import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import { SessionService } from '../../identity/session.service.js';
import { Clock } from '../clock.js';
import { parseCookies, SESSION_COOKIE } from '../http/cookies.js';

import { CLOSING_EVENT, type RealtimeSocket } from './socket-context.js';

import type { Namespace } from 'socket.io';

/**
 * Sockets must not outlive their session (constitution I): a session is checked at handshake,
 * but it can idle out later (staff 12 h) without a revocation event. Every sweep looks at this
 * process's sockets whose session was due to expire, re-authenticates the handshake cookie (HTTP
 * use may have slid the expiry) and either records the new expiry or sends
 * `closing { code: 'SESSION_EXPIRED' }` and disconnects.
 */

export const SESSION_SWEEP_MS = 60_000;

@Injectable()
export class SessionExpirySweeper implements OnModuleDestroy {
  private readonly logger = new Logger('SessionExpirySweeper');
  private readonly namespaces = new Set<Namespace>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly sessions: SessionService,
    private readonly clock: Clock,
  ) {}

  /** Called by each gateway once its namespace exists. */
  watch(namespace: Namespace): void {
    this.namespaces.add(namespace);
    this.timer ??= setInterval(() => void this.sweep(), SESSION_SWEEP_MS).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Closes this process's sockets whose session has expired; returns how many it closed. */
  async sweep(): Promise<number> {
    const now = this.clock.nowMs();
    let closed = 0;
    for (const namespace of this.namespaces) {
      for (const socket of namespace.sockets.values() as IterableIterator<RealtimeSocket>) {
        if (socket.data.expiresAt > now) continue;
        try {
          if (!(await this.stillValid(socket))) {
            socket.emit(CLOSING_EVENT, { code: 'SESSION_EXPIRED' });
            socket.disconnect(true);
            closed += 1;
          }
        } catch (error) {
          this.logger.warn(`Session expiry check failed: ${error instanceof Error ? error.message : 'unknown'}`);
        }
      }
    }
    return closed;
  }

  private async stillValid(socket: RealtimeSocket): Promise<boolean> {
    const cookie = socket.handshake.headers.cookie;
    const token = parseCookies(typeof cookie === 'string' ? cookie : undefined).get(SESSION_COOKIE);
    // Checking must not count as activity: an open socket alone doesn't keep a session alive.
    const principal = await this.sessions.authenticate(socket.data.tenantId, token, { slide: false });
    if (principal?.sessionId !== socket.data.sessionId) return false;
    socket.data.expiresAt = principal.expiresAt;
    return true;
  }
}
