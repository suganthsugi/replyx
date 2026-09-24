import { BadRequestException, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError, conflict, notFound, permissionDenied, rateLimited } from '../../../src/platform-kernel/http/app-error.js';
import { ErrorFilter } from '../../../src/platform-kernel/http/error.filter.js';
import { decodeCursor, encodeCursor, PaginationQuery, toPage } from '../../../src/platform-kernel/http/pagination.js';
import { ZodValidationPipe } from '../../../src/platform-kernel/http/validation.pipe.js';

function run(exception: unknown) {
  const response = {
    headersSent: false,
    headers: {} as Record<string, string>,
    statusCode: 0,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new ErrorFilter().catch(exception, host);
  return response;
}

describe('AppError helpers', () => {
  it('builds resource-specific not-found errors', () => {
    const error = notFound('sla_policy');
    expect(error).toMatchObject({ code: 'SLA_POLICY_NOT_FOUND', httpStatus: 404, message: 'Sla policy not found' });
  });

  it('rejects codes that are not UPPER_SNAKE_CASE', () => {
    expect(() => new AppError('bad-code', 400, 'x')).toThrow(TypeError);
  });

  it('rounds retryAfter up to whole seconds', () => {
    expect(rateLimited(0.2).retryAfter).toBe(1);
    expect(rateLimited(12.1).retryAfter).toBe(13);
  });
});

describe('ErrorFilter', () => {
  it('renders AppError with code, message and details', () => {
    const response = run(new AppError('VALIDATION_FAILED', 400, 'Invalid', [{ path: 'title', issue: 'too_long' }]));
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Invalid', details: [{ path: 'title', issue: 'too_long' }] },
    });
  });

  it('adds Retry-After for rate limits', () => {
    const response = run(rateLimited(30));
    expect(response.statusCode).toBe(429);
    expect(response.headers['Retry-After']).toBe('30');
    expect(response.body).toMatchObject({ error: { code: 'RATE_LIMITED', retryAfter: 30 } });
  });

  it('maps Nest HTTP exceptions by status', () => {
    expect(run(new NotFoundException('Cannot GET /x')).body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    expect(run(new BadRequestException()).body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(run(permissionDenied()).statusCode).toBe(403);
    expect(run(conflict('ALREADY_TRIAGED')).statusCode).toBe(409);
  });

  it('maps body-parser errors that are safe to expose', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), { status: 413, expose: true });
    expect(run(tooLarge)).toMatchObject({ statusCode: 413, body: { error: { code: 'PAYLOAD_TOO_LARGE' } } });
  });

  it('hides unknown errors behind INTERNAL', () => {
    const response = run(new Error('relation "users" does not exist at /repo/src/secret.ts'));
    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
    expect(JSON.stringify(response.body)).not.toContain('users');
  });

  it('rethrows for non-HTTP contexts', () => {
    const host = { getType: () => 'ws' } as unknown as ArgumentsHost;
    expect(() => new ErrorFilter().catch(new Error('x'), host)).toThrow('x');
  });
});

describe('ZodValidationPipe', () => {
  const Body = z
    .object({
      title: z.string().trim().min(1).max(5),
      count: z.coerce.number().int().min(1).max(10).optional(),
      tags: z.array(z.string()).max(1).optional(),
      state: z.enum(['open', 'closed']).optional(),
      owner: z.uuid().optional(),
      nested: z.object({ name: z.string() }).strict().optional(),
    })
    .strict();
  const pipe = new ZodValidationPipe(Body);

  function detailsOf(value: unknown) {
    try {
      pipe.transform(value);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      return (error as AppError).details;
    }
    throw new Error('expected a validation error');
  }

  it('returns the parsed value', () => {
    expect(pipe.transform({ title: ' hi ', count: '3' })).toEqual({ title: 'hi', count: 3 });
  });

  it('reports each problem with a stable issue code', () => {
    expect(
      detailsOf({
        title: 'far too long',
        count: 0,
        tags: ['a', 'b'],
        state: 'nope',
        owner: 'not-a-uuid',
        nested: { name: 1, extra: true },
        tenantId: 'x',
      }),
    ).toEqual(
      expect.arrayContaining([
        { path: 'title', issue: 'too_long' },
        { path: 'count', issue: 'too_small' },
        { path: 'tags', issue: 'too_many' },
        { path: 'state', issue: 'invalid_value' },
        { path: 'owner', issue: 'invalid_format' },
        { path: 'nested.name', issue: 'invalid_type' },
        { path: 'nested.extra', issue: 'unrecognized_key' },
        { path: 'tenantId', issue: 'unrecognized_key' },
      ]),
    );
  });

  it('distinguishes missing from wrongly typed values', () => {
    expect(detailsOf({})).toEqual([{ path: 'title', issue: 'required' }]);
    expect(detailsOf({ title: '' })).toEqual([{ path: 'title', issue: 'too_short' }]);
    expect(detailsOf(null)).toEqual([{ path: '', issue: 'invalid_type' }]);
  });
});

describe('pagination', () => {
  it('defaults and bounds the limit', () => {
    expect(PaginationQuery.parse({})).toEqual({ limit: 25 });
    expect(PaginationQuery.parse({ limit: '100' }).limit).toBe(100);
    expect(PaginationQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(PaginationQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(PaginationQuery.safeParse({ page: '2' }).success).toBe(false);
  });

  it('round-trips cursors and rejects tampered ones', () => {
    const Position = z.tuple([z.string(), z.uuid()]);
    const position = ['2026-09-24T10:00:00.000Z', '0192f3c4-0000-7000-8000-000000000001'];
    expect(decodeCursor(encodeCursor(position), Position)).toEqual(position);
    for (const bad of ['%%%', encodeCursor({ a: 1 }), Buffer.from('not json').toString('base64url')]) {
      expect(() => decodeCursor(bad, Position)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED', details: [{ path: 'cursor', issue: 'invalid_cursor' }] }),
      );
    }
  });

  it('builds a page from limit + 1 rows', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const page = toPage(rows, 2, (row) => [row.id], (row) => row.id);
    expect(page.items).toEqual([1, 2]);
    expect(decodeCursor(page.nextCursor!, z.tuple([z.number()]))).toEqual([2]);
    expect(toPage(rows, 3, (row) => [row.id], (row) => row.id).nextCursor).toBeNull();
    expect(toPage([], 3, () => [], (row) => row)).toEqual({ items: [], nextCursor: null });
  });
});
