import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNow } from '../../src/components/foundations/useNow';

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T10:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('ticks every 15 seconds with the current time', () => {
    const { result, unmount } = renderHook(() => useNow());
    const first = result.current;
    expect(first).toBe(Date.parse('2026-10-07T10:00:00.000Z'));
    act(() => void vi.advanceTimersByTime(14_999));
    expect(result.current).toBe(first);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(first + 15_000);
    unmount();
  });

  it('shares one interval between every subscriber and gives them the same value', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const seen: number[][] = [[], [], []];
    function Reader({ index }: { index: number }) {
      seen[index]?.push(useNow());
      return null;
    }
    const view = render(
      <>
        <Reader index={0} />
        <Reader index={1} />
        <Reader index={2} />
      </>,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(15_000));
    const last = seen.map((values) => values.at(-1));
    expect(last).toEqual([Date.parse('2026-10-07T10:00:15.000Z'), Date.parse('2026-10-07T10:00:15.000Z'), Date.parse('2026-10-07T10:00:15.000Z')]);
    expect(spy).toHaveBeenCalledTimes(1);
    view.unmount();
    spy.mockRestore();
  });

  it('stops the interval when the last subscriber leaves and restarts it with a fresh time', () => {
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const set = vi.spyOn(globalThis, 'setInterval');
    const a = renderHook(() => useNow());
    const b = renderHook(() => useNow());
    a.unmount();
    expect(clear).not.toHaveBeenCalled();
    b.unmount();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    vi.setSystemTime(new Date('2026-10-07T12:00:00.000Z'));
    const again = renderHook(() => useNow());
    expect(again.result.current).toBe(Date.parse('2026-10-07T12:00:00.000Z'));
    expect(set).toHaveBeenCalledTimes(2);
    again.unmount();
    clear.mockRestore();
    set.mockRestore();
  });
});
