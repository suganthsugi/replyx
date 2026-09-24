import { describe, expect, it, vi } from 'vitest';

import { DEV_CLOCK_OFFSET_KEY, DevOffsetClock, parseAdvanceArgs, SystemClock } from '../../src/platform-kernel/clock.js';

describe('SystemClock', () => {
  it('returns the current time', () => {
    const before = Date.now();
    const now = new SystemClock().nowMs();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('DevOffsetClock', () => {
  it('applies the shared offset from Redis', async () => {
    const offset = 73 * 3_600_000;
    const redis = { get: vi.fn(() => Promise.resolve(String(offset))) };
    const clock = new DevOffsetClock(redis as never);
    await clock.refresh();
    expect(redis.get).toHaveBeenCalledWith(DEV_CLOCK_OFFSET_KEY);
    expect(clock.nowMs() - Date.now()).toBeGreaterThan(offset - 1_000);
    clock.onApplicationShutdown();
  });

  it('keeps the last offset when Redis fails', async () => {
    const redis = { get: vi.fn().mockResolvedValueOnce('3600000').mockRejectedValue(new Error('down')) };
    const clock = new DevOffsetClock(redis as never);
    await clock.refresh();
    await clock.refresh();
    expect(clock.nowMs() - Date.now()).toBeGreaterThan(3_599_000);
    clock.onApplicationShutdown();
  });
});

describe('dev:advance-clock arguments', () => {
  it('parses --hours and --reset', () => {
    expect(parseAdvanceArgs(['--hours', '73'])).toEqual({ hours: 73 });
    expect(parseAdvanceArgs(['--hours', '-1.5'])).toEqual({ hours: -1.5 });
    expect(parseAdvanceArgs(['--reset'])).toEqual({ reset: true });
  });

  it('rejects missing or zero hours', () => {
    for (const argv of [[], ['--hours'], ['--hours', 'x'], ['--hours', '0']]) {
      expect(() => parseAdvanceArgs(argv)).toThrow('Usage');
    }
  });
});
