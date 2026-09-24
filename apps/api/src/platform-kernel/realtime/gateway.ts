import { Injectable, Logger, Module } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';

import { grantedGroups, PolicyService } from '../../authorization/policy.service.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { SessionService, type SessionKind } from '../../identity/session.service.js';
import { parseCookies, SESSION_COOKIE } from '../http/cookies.js';
import { HttpKernelModule } from '../http/http-kernel.module.js';
import { TenantResolver } from '../http/tenant-resolver.middleware.js';
import { MetricsService } from '../observability/metrics.js';
import { isStreamKey, type DomainEventPayload } from '../outbox/event-types.js';
import { CONTROL_EVENT, CUSTOMER_NAMESPACE, roomFor, STAFF_NAMESPACE, type ControlMessage } from '../outbox/relay.js';

import { REALTIME_PATH } from './redis-io.adapter.js';
import {
  CLOSING_EVENT,
  errorAck,
  notFoundAck,
  sessionRoom,
  socketContext,
  tenantRoom,
  type Ack,
  type RealtimeSocket,
  type RealtimeSocketData,
} from './socket-context.js';
import { StreamAccess } from './stream-access.js';
import { SyncHandler } from './sync.handler.js';

import type { Namespace, Server } from 'socket.io';

/**
 * The real-time gateway (research D8, contracts/realtime-events.md): Socket.IO on `/rt`, staff on
 * namespace `/`, customers on `/customer`.
 *
 * - Handshake: tenant from the `Host` header, `rx_session` cookie authenticated against it, and
 *   the session's audience must match the namespace; otherwise `connect_error` with
 *   `data.code` `UNAUTHENTICATED` (or `TENANT_SUSPENDED`).
 * - Rooms are `t:{tenantId}:{stream}`. Staff join `user`, `views` and the `tickets:group:*` rooms
 *   they can view; customers join their own `conversation` and nothing else. Every socket also
 *   joins `t:{tenantId}:tenant` and `t:{tenantId}:session:{sessionId}` so control events can
 *   reach it; clients never subscribe to those.
 * - `subscribe`/`unsubscribe` answer with acks; anything the caller may not see is `NOT_FOUND`.
 *   `sync` replays missed events (sync.handler.ts).
 * - Control events from the relay (`session.revoked`, `tenant.suspended`) send `closing { code }`
 *   and disconnect the affected sockets on this process.
 */

class HandshakeError extends Error {
  readonly data: { code: string };
  constructor(code: string) {
    super(code === 'TENANT_SUSPENDED' ? 'This workspace is currently unavailable' : 'Sign in to continue');
    this.data = { code };
  }
}

/** Authenticates a handshake for one audience; shared by both namespaces. */
@Injectable()
export class RealtimeAuth {
  constructor(
    private readonly tenants: TenantResolver,
    private readonly sessions: SessionService,
  ) {}

  async authenticate(handshake: { headers: Record<string, string | string[] | undefined> }, audience: SessionKind): Promise<RealtimeSocketData> {
    const host = handshake.headers.host;
    const resolution = await this.tenants.resolve(typeof host === 'string' ? host : undefined).catch(() => undefined);
    if (resolution?.kind !== 'tenant') throw new HandshakeError('UNAUTHENTICATED');
    if (resolution.tenant.status === 'suspended') throw new HandshakeError('TENANT_SUSPENDED');

    const cookie = handshake.headers.cookie;
    const token = parseCookies(typeof cookie === 'string' ? cookie : undefined).get(SESSION_COOKIE);
    const principal = await this.sessions.authenticate(resolution.tenant.id, token);
    if (principal?.tenantId !== resolution.tenant.id || principal.kind !== audience) {
      throw new HandshakeError('UNAUTHENTICATED');
    }
    return { tenantId: principal.tenantId, userId: principal.userId, sessionId: principal.sessionId, kind: principal.kind };
  }
}

type Middleware = (socket: RealtimeSocket, next: (error?: Error) => void) => void;

function handshakeMiddleware(auth: RealtimeAuth, audience: SessionKind, logger: Logger): Middleware {
  return (socket, next) => {
    auth.authenticate(socket.handshake, audience).then(
      (data) => {
        socket.data = data;
        next();
      },
      (error: unknown) => {
        if (!(error instanceof HandshakeError)) {
          logger.error(`Handshake failed: ${error instanceof Error ? error.message : 'unknown'}`);
        }
        next(error instanceof HandshakeError ? error : new HandshakeError('UNAUTHENTICATED'));
      },
    );
  };
}

function parseStream(body: unknown): string | undefined {
  const stream = (body as { stream?: unknown } | null)?.stream;
  return typeof stream === 'string' ? stream : undefined;
}

@Injectable()
@WebSocketGateway({ path: REALTIME_PATH, namespace: STAFF_NAMESPACE })
export class StaffGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('StaffGateway');
  private server?: Server;

  constructor(
    private readonly auth: RealtimeAuth,
    private readonly policy: PolicyService,
    private readonly sessions: SessionService,
    private readonly metrics: MetricsService,
    private readonly access: StreamAccess,
    private readonly syncHandler: SyncHandler,
  ) {}

  /** For the root namespace Nest passes the `Server` itself. */
  afterInit(namespace: Namespace | Server): void {
    this.server = 'server' in namespace ? namespace.server : namespace;
    namespace.use(handshakeMiddleware(this.auth, 'staff', this.logger) as Parameters<Namespace['use']>[0]);
    // Server-side broadcasts from the relay arrive on the root namespace of every api process.
    namespace.on(CONTROL_EVENT, (message: ControlMessage) => void this.onControl(message));
  }

  async handleConnection(socket: RealtimeSocket): Promise<void> {
    this.metrics.wsConnections.add(1, { namespace: STAFF_NAMESPACE });
    const { tenantId, userId, sessionId } = socket.data;
    await socket.join([
      tenantRoom(tenantId),
      sessionRoom(tenantId, sessionId),
      roomFor(tenantId, `user:${userId}`),
      roomFor(tenantId, `views:${userId}`),
      ...(await this.groupRooms(socket)),
    ]);
  }

  handleDisconnect(): void {
    this.metrics.wsConnections.add(-1, { namespace: STAFF_NAMESPACE });
  }

  /** `tickets:group:*` rooms for the groups (and Ungrouped) the user can view now. */
  async groupRooms(socket: RealtimeSocket): Promise<string[]> {
    const access = await this.policy.effectiveAccess(socketContext(socket), socket.data.userId);
    const { groupIds, ungrouped } = grantedGroups(access, 'view');
    const streams = [...groupIds.map((id) => `tickets:group:${id}`), ...(ungrouped ? ['tickets:group:ungrouped'] : [])];
    return streams.map((stream) => roomFor(socket.data.tenantId, stream));
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: RealtimeSocket, @MessageBody() body: unknown): Promise<Ack> {
    const stream = parseStream(body);
    // `user` and `views` are joined on connect; subscribing to them is a no-op.
    if (stream === 'user' || stream === 'views') return { ok: true };
    if (stream === undefined || !stream.startsWith('ticket:') || !isStreamKey(stream)) return notFoundAck();

    if (!(await this.access.canSeeTicket(socketContext(socket), stream.slice('ticket:'.length)))) {
      return notFoundAck();
    }
    await socket.join(roomFor(socket.data.tenantId, stream));
    return { ok: true };
  }

  @SubscribeMessage('sync')
  sync(@ConnectedSocket() socket: RealtimeSocket, @MessageBody() body: unknown): Promise<Ack> {
    return this.syncHandler.sync(socket, body).catch(errorAck);
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(@ConnectedSocket() socket: RealtimeSocket, @MessageBody() body: unknown): Promise<Ack> {
    const stream = parseStream(body);
    if (stream !== undefined && stream.startsWith('ticket:') && isStreamKey(stream)) {
      await socket.leave(roomFor(socket.data.tenantId, stream));
    }
    return { ok: true };
  }

  /** Relay control events: disconnect revoked sessions and suspended tenants on this process. */
  async onControl(message: ControlMessage): Promise<void> {
    try {
      if (message.type === 'session.revoked') {
        const payload = message.payload as unknown as DomainEventPayload<'session.revoked'>;
        // The revoking transaction purged the cache before commit; purge again now it is committed.
        await this.sessions.purgeCache(message.tenantId, payload.sessionIds);
        const code = payload.reason === 'tenant_suspended' ? 'TENANT_SUSPENDED' : 'SESSION_REVOKED';
        for (const sessionId of payload.sessionIds) {
          this.close(sessionRoom(message.tenantId, sessionId), code);
        }
      } else if (message.type === 'tenant.suspended') {
        this.close(tenantRoom(message.tenantId), 'TENANT_SUSPENDED');
      }
    } catch (error) {
      this.logger.error(`Control ${message.type} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  /** Both namespaces, local sockets only: every api process receives the same control event. */
  private close(room: string, code: string): void {
    const server = this.server;
    if (server === undefined) return;
    for (const name of [STAFF_NAMESPACE, CUSTOMER_NAMESPACE]) {
      const local = server.of(name).local.in(room);
      local.emit(CLOSING_EVENT, { code });
      local.disconnectSockets(true);
    }
  }
}

@Injectable()
@WebSocketGateway({ path: REALTIME_PATH, namespace: CUSTOMER_NAMESPACE })
export class CustomerGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('CustomerGateway');

  constructor(
    private readonly auth: RealtimeAuth,
    private readonly metrics: MetricsService,
    private readonly syncHandler: SyncHandler,
  ) {}

  afterInit(namespace: Namespace): void {
    namespace.use(handshakeMiddleware(this.auth, 'customer', this.logger) as Parameters<Namespace['use']>[0]);
  }

  async handleConnection(socket: RealtimeSocket): Promise<void> {
    this.metrics.wsConnections.add(1, { namespace: CUSTOMER_NAMESPACE });
    const { tenantId, userId, sessionId } = socket.data;
    await socket.join([
      tenantRoom(tenantId),
      sessionRoom(tenantId, sessionId),
      roomFor(tenantId, `conversation:${userId}`),
    ]);
  }

  handleDisconnect(): void {
    this.metrics.wsConnections.add(-1, { namespace: CUSTOMER_NAMESPACE });
  }

  /** Customers are joined to their conversation on connect and can subscribe to nothing else. */
  @SubscribeMessage('subscribe')
  subscribe(@MessageBody() body: unknown): Ack {
    return parseStream(body) === 'conversation' ? { ok: true } : notFoundAck();
  }

  @SubscribeMessage('sync')
  sync(@ConnectedSocket() socket: RealtimeSocket, @MessageBody() body: unknown): Promise<Ack> {
    return this.syncHandler.sync(socket, body).catch(errorAck);
  }

  @SubscribeMessage('unsubscribe')
  unsubscribe(): Ack {
    return { ok: true };
  }
}

/** Real-time gateway (api process only). */
@Module({
  imports: [HttpKernelModule, IdentityModule],
  providers: [RealtimeAuth, StreamAccess, SyncHandler, StaffGateway, CustomerGateway],
  exports: [StaffGateway],
})
export class RealtimeModule {}
