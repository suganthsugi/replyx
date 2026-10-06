import { useSyncExternalStore } from 'react';

/**
 * A shared ticking clock: one interval for the whole page, however many components read it (a
 * ticket list shows an SLA countdown on every row). The interval runs only while something is
 * subscribed. Components re-render once per tick with the same `now`, so a list stays consistent.
 */

const TICK_MS = 15_000;

let current = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    // The value may be stale from before the first subscriber: refresh it, then keep ticking.
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      listeners.forEach((notify) => notify());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): number {
  return current;
}

/** The current time in ms, refreshed every 15 seconds while the component is mounted. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
