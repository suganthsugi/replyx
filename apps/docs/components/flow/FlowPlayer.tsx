'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { COUNT_WINDOW, FlowReel, holdFor, stepsFor, type Step } from './FlowReel';
import { SCENARIOS, STATIC_SCENARIO, type Scenario } from './scenarios';

/**
 * Plays the home flow reel (US1, FR-006): loops through SCENARIOS, one beat per stage, with a tile
 * wipe between tickets. The first render matches the server's static recap; nothing moves when the
 * visitor prefers reduced motion (FR-009). Timing comes from the storyboard in FlowReel.tsx.
 *
 * Every step is a Web Animations API animation (a hold, or the wipe), and the sequence awaits each
 * one. Pausing every animation in the figure therefore also pauses the sequence, which is how it
 * stops while the tab is hidden or the figure is off screen (FR-010).
 */

const EASING = 'cubic-bezier(0.2, 0, 0, 1)';
/** The empty frame shows this long after the wipe, before the next ticket comes in. */
const BREATH = 350;

class Stopped extends Error {}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export function FlowPlayer() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [scenario, setScenario] = useState<Scenario>(STATIC_SCENARIO);
  const [step, setStep] = useState<Step>('complete');
  const [count, setCount] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [blank, setBlank] = useState(false);
  const [speed, setSpeed] = useState(1);
  const adoptRef = useRef<(animation: Animation) => void>(() => {});
  const adopt = useCallback((animation: Animation) => adoptRef.current(animation), []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const speedParam = Number(new URLSearchParams(window.location.search).get('speed'));
    const speed = Number.isFinite(speedParam) && speedParam > 0 ? speedParam : 1;
    setSpeed(speed);

    let run = 0; // bumped to stop the current loop
    let onScreen = true;
    const live = new Set<Animation>();
    // Only the animations we paused get resumed: calling play() on a finished one would replay it.
    const pausedByUs = new Set<Animation>();

    const hidden = () => document.hidden || !onScreen;

    /** Pauses an animation that starts while the reel is hidden. */
    function adoptAnimation(animation: Animation) {
      if (hidden()) {
        animation.pause();
        pausedByUs.add(animation);
      }
    }
    adoptRef.current = adoptAnimation;

    function track(animation: Animation) {
      live.add(animation);
      animation.finished.finally(() => live.delete(animation)).catch(() => {});
      adoptAnimation(animation);
      return animation;
    }

    // Resolved when the reel is visible again.
    let waiting: (() => void)[] = [];
    const whenVisible = () => (hidden() ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve());

    /**
     * Waits for an animation, then (if the reel was hidden meanwhile) for the reel to be visible, so
     * the next state change, and the CSS transitions it starts, never happen while hidden.
     */
    async function finish(animation: Animation, token: number) {
      try {
        await animation.finished;
      } catch {
        throw new Stopped();
      }
      await whenVisible();
      if (token !== run) throw new Stopped();
    }

    /** Holds the current step; with a count window, reports the count-up's progress (0–1). */
    async function hold(ms: number, token: number, window?: [number, number]) {
      const duration = ms / speed;
      const animation = track(root!.animate([{ opacity: 1 }, { opacity: 1 }], { duration }));
      let frame = 0;
      if (window) {
        const [from, to] = window;
        const tick = () => {
          const t = Number(animation.currentTime ?? 0) * speed;
          setCount(Math.min(1, Math.max(0, (t - from) / (to - from))));
          if (animation.playState !== 'finished' && animation.playState !== 'idle') frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      }
      try {
        await finish(animation, token);
      } finally {
        cancelAnimationFrame(frame);
      }
    }

    /** Covers the frame with tiles, swaps underneath, then uncovers an empty frame. */
    async function wipe(token: number, swap: () => void) {
      const tiles = [...root!.querySelectorAll<HTMLElement>('[data-tile]')];
      const play = (from: string, to: string) =>
        tiles.map((tile) =>
          track(
            tile.animate([{ transform: from }, { transform: to }], {
              duration: 320 / speed,
              delay: (Number(tile.dataset.tile) * 24) / speed,
              easing: EASING,
              fill: 'both',
            }),
          ),
        );
      const cover = play('scale(0)', 'scale(1)');
      await Promise.all(cover.map((a) => finish(a, token)));
      swap();
      await nextFrame();
      const reveal = play('scale(1)', 'scale(0)');
      for (const a of cover) a.cancel();
      await Promise.all(reveal.map((a) => finish(a, token)));
      for (const a of reveal) a.cancel();
    }

    async function loop(token: number) {
      setPlaying(true);
      for (let i = 0; ; i = (i + 1) % SCENARIOS.length) {
        const sc = SCENARIOS[i]!;
        const steps = stepsFor(sc);
        await wipe(token, () => {
          setBlank(true);
          setScenario(sc);
          setStep(steps[0]!);
          setCount(1);
        });
        await hold(BREATH, token);
        setBlank(false);
        for (const stage of steps) {
          const window = COUNT_WINDOW[stage];
          setCount(window ? 0 : 1);
          setStep(stage);
          await hold(holdFor(stage, sc), token, window);
        }
        setCount(1);
        setStep('complete');
        await hold(holdFor('complete', sc), token);
      }
    }

    function start() {
      const token = ++run;
      loop(token).catch((error: unknown) => {
        if (!(error instanceof Stopped)) throw error;
      });
    }

    function stop() {
      run++;
      for (const animation of live) animation.cancel();
      live.clear();
      setPlaying(false);
      setBlank(false);
      setScenario(STATIC_SCENARIO);
      setStep('complete');
      setCount(1);
    }

    function syncPause() {
      // CSS entrances that start while hidden (a scene mounting) stay frozen until it is visible.
      root!.toggleAttribute('data-paused', hidden());
      if (hidden()) {
        for (const animation of root!.getAnimations({ subtree: true })) {
          if (animation.playState === 'running') {
            animation.pause();
            pausedByUs.add(animation);
          }
        }
      } else {
        for (const animation of pausedByUs) if (animation.playState === 'paused') animation.play();
        pausedByUs.clear();
        const resume = waiting;
        waiting = [];
        for (const resolve of resume) resolve();
      }
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry?.isIntersecting ?? true;
        syncPause();
      },
      { threshold: 0.2 },
    );
    observer.observe(root);
    document.addEventListener('visibilitychange', syncPause);

    const onMotionChange = () => (reduceMotion.matches ? stop() : start());
    reduceMotion.addEventListener('change', onMotionChange);
    if (!reduceMotion.matches) start();

    return () => {
      run++;
      for (const animation of live) animation.cancel();
      observer.disconnect();
      document.removeEventListener('visibilitychange', syncPause);
      reduceMotion.removeEventListener('change', onMotionChange);
    };
  }, []);

  return (
    <div ref={rootRef} data-flow-player data-scenario={scenario.id} data-step={step}>
      <FlowReel scenario={scenario} step={step} count={count} playing={playing} speed={speed} blank={blank} adopt={adopt} />
    </div>
  );
}
