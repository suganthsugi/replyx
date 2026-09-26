import { sql } from 'kysely';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { API_PREFIX } from '../../../src/app.setup.js';
import { AttachmentScanConsumer } from '../../../src/attachments/scan.job.js';
import { FILE_STORAGE } from '../../../src/attachments/storage/file-storage.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { OutboxService } from '../../../src/platform-kernel/outbox/outbox.service.js';
import { getTestApp, service } from '../../support/app.js';
import { createGroup, createRole, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asGuest, asUser } from '../../support/http.js';

import type { MalwareScanner, ScanVerdict } from '../../../src/attachments/scan.job.js';
import type { FileStorage } from '../../../src/attachments/storage/file-storage.js';
import type { Readable } from 'node:stream';

/**
 * Attachment uploads, malware scanning and downloads (FR-045, FR-046, FR-047, research D17,
 * contracts/tickets.yaml and customer.yaml `/attachments`, `/attachments/{id}/download`,
 * `/files/{token}`).
 */

const DOWNLOAD_TTL_MS = 15 * 60_000;

// A well-known 1x1 transparent PNG, valid by magic bytes.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
// A Windows PE header (`MZ...`): a real executable, whatever its name says.
const EXE_BYTES = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62, 0)]);

interface UploadedBody {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanStatus: string;
  downloadPath: null;
}

interface ErrorBody {
  error: { code: string; message: string };
}

const failure = (response: { body: unknown }) => response.body as ErrorBody;

function uploadPath(user: TestUser): string {
  return user.kind === 'customer' ? '/customer/attachments' : '/attachments';
}

/** Multipart upload: `asUser`/`asGuest` don't carry files, so this goes straight through supertest. */
async function upload(
  user: TestUser,
  file: { buffer: Buffer; fileName: string },
  options: { host?: string; path?: string } = {},
): Promise<supertest.Test> {
  const { app } = await getTestApp();
  const path = options.path ?? uploadPath(user);
  let req = supertest(app.getHttpServer())
    .post(`/${API_PREFIX}${path}`)
    .set('Host', options.host ?? user.tenant.host);
  if (user.sessionToken !== undefined) req = req.set('Cookie', [`rx_session=${user.sessionToken}`, `rx_csrf=${user.csrfToken}`].join('; '));
  req = req.set('X-CSRF-Token', user.csrfToken);
  return req.attach('file', file.buffer, file.fileName);
}

function downloadPath(user: TestUser, id: string): string {
  return `${user.kind === 'customer' ? '/customer/attachments' : '/attachments'}/${id}/download`;
}

class FakeScanner implements MalwareScanner {
  readonly name = 'fake';
  constructor(private readonly verdict: ScanVerdict) {}
  async scan(file: Readable): Promise<ScanVerdict> {
    for await (const chunk of file) void chunk;
    return this.verdict;
  }
}

class ScanFixtures extends TenantRepository {
  uploadEvent(tx: TenantTransaction, attachmentId: string) {
    return this.selectFrom(tx, 'outbox_events')
      .select(['id'])
      .where('type', '=', 'attachment.uploaded')
      .where(sql<boolean>`payload ->> 'attachmentId' = ${attachmentId}`)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
  }
}

async function inspect<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: ScanFixtures) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-inspect' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new ScanFixtures(ctx)));
}

/** Drives the scan job directly (no worker process), with a scanner the test controls. */
async function runScan(tenant: TestTenant, attachmentId: string, verdict: ScanVerdict): Promise<void> {
  const { app, clock } = await getTestApp();
  const unitOfWork = await service(UnitOfWork);
  const outbox = await service(OutboxService);
  const storage = app.get<FileStorage>(FILE_STORAGE);
  const consumer = new AttachmentScanConsumer(unitOfWork, outbox, clock, storage, new FakeScanner(verdict));
  const { id: eventId } = await inspect(tenant, (tx, repo) => repo.uploadEvent(tx, attachmentId));
  const result = await consumer.process({ tenantId: tenant.id, eventId }, 'test-job');
  if (result !== 'handled') throw new Error(`Scan job did not run: ${result}`);
}

function locationOf(response: { headers: Record<string, string> }): string {
  const location = response.headers.location;
  if (location === undefined) throw new Error('Expected a Location header');
  return location;
}

function tokenOf(location: string): string {
  const match = /\/files\/(.+)$/.exec(location);
  if (match?.[1] === undefined) throw new Error(`Not a file link: ${location}`);
  return match[1];
}

async function getFile(token: string, host: string): Promise<supertest.Test> {
  return asGuest(host).get(`/files/${token}`);
}

let tenant: TestTenant;
let other: TestTenant;
let admin: TestUser;

beforeAll(async () => {
  await getTestApp();
  [tenant, other] = await Promise.all([createTenant(), createTenant()]);
  admin = await createUser(tenant, { roles: ['admin'] });
});

describe('POST /attachments and /customer/attachments', () => {
  it('uploads for staff and customers, pending until scanned', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    for (const uploader of [admin, customer]) {
      const response = await upload(uploader, { buffer: PNG_BYTES, fileName: 'photo.png' });
      expect(response.status).toBe(201);
      const body = response.body as UploadedBody;
      expect(body).toMatchObject({ fileName: 'photo.png', contentType: 'image/png', sizeBytes: PNG_BYTES.length, scanStatus: 'pending', downloadPath: null });
      expect(typeof body.id).toBe('string');
    }
  });

  it('rejects a file over 25 MB with 413 ATTACHMENT_TOO_LARGE', async () => {
    const big = Buffer.alloc(30 * 1024 * 1024, 1);
    const response = await upload(admin, { buffer: big, fileName: 'big.bin' });
    expect(response.status).toBe(413);
    expect(failure(response).error.code).toBe('ATTACHMENT_TOO_LARGE');
  });

  it('rejects an executable renamed to .png with 415 ATTACHMENT_TYPE_NOT_ALLOWED', async () => {
    const response = await upload(admin, { buffer: EXE_BYTES, fileName: 'totally-a-photo.png' });
    expect(response.status).toBe(415);
    expect(failure(response).error.code).toBe('ATTACHMENT_TYPE_NOT_ALLOWED');
  });

  it('refuses a staff upload from someone without ticket.edit', async () => {
    const role = await createRole(tenant, { permissions: [] });
    const outsider = await createUser(tenant, { roles: [{ id: role.id }] });
    const response = await upload(outsider, { buffer: PNG_BYTES, fileName: 'photo.png' });
    expect(response.status).toBe(403);
    expect(failure(response).error.code).toBe('PERMISSION_DENIED');
  });
});

describe('scanning', () => {
  it('answers 409 ATTACHMENT_NOT_READY while an upload is still pending', async () => {
    const uploaded = (await upload(admin, { buffer: PNG_BYTES, fileName: 'photo.png' })).body as UploadedBody;
    const response = await asUser(admin).get(downloadPath(admin, uploaded.id));
    expect(response.status).toBe(409);
    expect(failure(response).error.code).toBe('ATTACHMENT_NOT_READY');
  });

  it('answers 409 ATTACHMENT_BLOCKED once the scanner flags the file', async () => {
    const uploaded = (await upload(admin, { buffer: PNG_BYTES, fileName: 'photo.png' })).body as UploadedBody;
    await runScan(tenant, uploaded.id, { verdict: 'infected', signature: 'EICAR-TEST' });
    const response = await asUser(admin).get(downloadPath(admin, uploaded.id));
    expect(response.status).toBe(409);
    expect(failure(response).error.code).toBe('ATTACHMENT_BLOCKED');
  });

  it('serves a clean file through a signed, short-lived link', async () => {
    const uploaded = (await upload(admin, { buffer: PNG_BYTES, fileName: 'photo.png' })).body as UploadedBody;
    await runScan(tenant, uploaded.id, { verdict: 'clean' });

    const redirect = await asUser(admin).get(downloadPath(admin, uploaded.id));
    expect(redirect.status).toBe(302);
    const location = locationOf(redirect);
    expect(location).toMatch(new RegExp(`^/${API_PREFIX}/files/`));

    const file = await getFile(tokenOf(location), admin.tenant.host);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['content-disposition']).toContain('inline');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(file.body as Buffer, PNG_BYTES)).toBe(0);
  });
});

describe('GET /attachments/{id}/download (staff)', () => {
  it('is refused for staff without ticket.view', async () => {
    const uploaded = (await upload(admin, { buffer: PNG_BYTES, fileName: 'photo.png' })).body as UploadedBody;
    await runScan(tenant, uploaded.id, { verdict: 'clean' });
    const role = await createRole(tenant, { permissions: [] });
    const outsider = await createUser(tenant, { roles: [{ id: role.id }] });
    const response = await asUser(outsider).get(downloadPath(admin, uploaded.id));
    expect(response.status).toBe(403);
    expect(failure(response).error.code).toBe('PERMISSION_DENIED');
  });

  it('is 404 for a tenant that has ticket.view but not this attachment', async () => {
    const uploaded = (await upload(admin, { buffer: PNG_BYTES, fileName: 'photo.png' })).body as UploadedBody;
    await runScan(tenant, uploaded.id, { verdict: 'clean' });
    const otherAdmin = await createUser(other, { roles: ['admin'] });
    const cross = await asUser(otherAdmin).get(downloadPath(admin, uploaded.id));
    const unknown = await asUser(otherAdmin).get(downloadPath(admin, uuidv7()));
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(unknown.body);
  });
});

describe('GET /files/{token}', () => {
  async function cleanDownloadToken(): Promise<{ token: string; body: Buffer }> {
    const uploaded = (await upload(admin, { buffer: PNG_BYTES, fileName: 'photo.png' })).body as UploadedBody;
    await runScan(tenant, uploaded.id, { verdict: 'clean' });
    const redirect = await asUser(admin).get(downloadPath(admin, uploaded.id));
    return { token: tokenOf(locationOf(redirect)), body: PNG_BYTES };
  }

  it('expires 15 minutes after it was issued', async () => {
    const { token } = await cleanDownloadToken();
    const stillValid = await getFile(token, admin.tenant.host);
    expect(stillValid.status).toBe(200);

    const { clock } = await getTestApp();
    clock.advance(DOWNLOAD_TTL_MS + 1);
    const expired = await getFile(token, admin.tenant.host);
    const unknown = await getFile('not-a-real-token', admin.tenant.host);
    expect(expired.status).toBe(404);
    expect(expired.body).toEqual(unknown.body);
  });

  it('is 404 when used on another tenant\'s host', async () => {
    const { token } = await cleanDownloadToken();
    const crossHost = await getFile(token, other.host);
    const unknown = await getFile('not-a-real-token', other.host);
    expect(crossHost.status).toBe(404);
    expect(crossHost.body).toEqual(unknown.body);
  });
});

describe('customer downloads', () => {
  async function publicMessageWith(attachmentId: string, customer: TestUser): Promise<void> {
    const response = await asUser(customer).post('/customer/messages', { body: 'Here is the file', clientMessageId: uuidv7(), attachmentIds: [attachmentId] });
    if (response.status !== 201) throw new Error(`Failed to send message: ${response.status} ${JSON.stringify(response.body)}`);
  }

  it('lets a customer download an attachment on their own public message', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const uploaded = (await upload(customer, { buffer: PNG_BYTES, fileName: 'photo.png' })).body as UploadedBody;
    await publicMessageWith(uploaded.id, customer);
    await runScan(tenant, uploaded.id, { verdict: 'clean' });

    const response = await asUser(customer).get(downloadPath(customer, uploaded.id));
    expect(response.status).toBe(302);
  });

  it('never lets a customer download an attachment on an internal note', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    const ticket = await createTicket(tenant, { customer, group: group.id, messages: [{ body: 'Hello' }] });
    const uploaded = (await upload(admin, { buffer: PNG_BYTES, fileName: 'internal.png' })).body as UploadedBody;

    const note = await asUser(admin).post(`/tickets/${ticket.id}/messages`, {
      visibility: 'internal',
      body: 'Internal only',
      clientMessageId: uuidv7(),
      attachmentIds: [uploaded.id],
      mentionIds: [],
    });
    expect(note.status).toBe(201);
    await runScan(tenant, uploaded.id, { verdict: 'clean' });

    const response = await asUser(customer).get(downloadPath(customer, uploaded.id));
    const unknown = await asUser(customer).get(downloadPath(customer, uuidv7()));
    expect(response.status).toBe(404);
    expect(response.body).toEqual(unknown.body);
  });

  it('is 404 for a customer of another tenant', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const uploaded = (await upload(customer, { buffer: PNG_BYTES, fileName: 'photo.png' })).body as UploadedBody;
    await publicMessageWith(uploaded.id, customer);
    await runScan(tenant, uploaded.id, { verdict: 'clean' });

    const foreigner = await createUser(other, { roles: ['customer'] });
    const cross = await asUser(foreigner).get(downloadPath(customer, uploaded.id));
    const unknown = await asUser(foreigner).get(downloadPath(customer, uuidv7()));
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(unknown.body);
  });
});
