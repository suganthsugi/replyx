'use client';

import { useEffect, useRef, useState } from 'react';
import { FlowArtwork, pathInto, stepsFor, type Step } from './flow-svg';
import { SCENARIOS, STATIC_SCENARIO, type Scenario, type StageId } from './scenarios';

/**
 * Plays the home flow (US1, FR-006): loops through SCENARIOS, moving the ticket along each path and
 * lighting each stage in turn. The first render matches the server's static diagram; nothing moves
 * when the visitor prefers reduced motion (FR-009).
 *
 * Every step is a Web Animations API animation (the ticket travelling, or a hold), and the sequence
 * awaits each one. Pausing every animation in the figure therefore also pauses the sequence, which is
 * how it stops while the tab is hidden or the figure is off screen (FR-010).
 */

/** How long each stage holds before the ticket moves on (ms, at speed 1). */
const HOLD: Record<StageId, number> = {
  intake: 700,
  rules: 500,
  decision: 1000,
  groups: 600,
  triage: 1400,
  factors: 1100,
  score: 900,
  levels: 1500,
};
const TRAVEL = 420;
const EASING = 'cubic-bezier(0.2, 0, 0, 1)';

class Stopped extends Error {}

export function FlowPlayer() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [scenario, setScenario] = useState<Scenario>(STATIC_SCENARIO);
  const [step, setStep] = useState<Step>('complete');
  const [scoreText, setScoreText] = useState<string | undefined>(undefined);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const speedParam = Number(new URLSearchParams(window.location.search).get('speed'));
    const speed = Number.isFinite(speedParam) && speedParam > 0 ? speedParam : 1;

    let run = 0; // bumped to stop the current loop
    let onScreen = true;
    const live = new Set<Animation>();

    const hidden = () => document.hidden || !onScreen;
    const allAnimations = () => root.getAnimations({ subtree: true });

    function track(animation: Animation) {
      live.add(animation);
      animation.finished.finally(() => live.delete(animation)).catch(() => {});
      if (hidden()) animation.pause();
      return animation;
    }

    /** The layout on screen (the other one is display: none). */
    function visibleSvg(): SVGSVGElement | null {
      return [...root!.querySelectorAll('svg')].find((svg) => getComputedStyle(svg).display !== 'none') ?? null;
    }

    async function finish(animation: Animation, token: number) {
      try {
        await animation.finished;
      } catch {
        throw new Stopped();
      }
      if (token !== run) throw new Stopped();
    }

    /** Moves the ticket along a path of the visible layout. */
    async function travel(pathId: string, token: number) {
      const svg = visibleSvg();
      const path = svg?.querySelector<SVGPathElement>(`[data-path="${pathId}"]`);
      const particle = svg?.querySelector<SVGGElement>('[data-part="particle"]');
      if (!path || !particle) return;
      const length = path.getTotalLength();
      const samples = 18;
      const frames: Keyframe[] = [];
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const p = path.getPointAtLength(length * t);
        frames.push({ offset: t, transform: `translate(${p.x}px, ${p.y}px)`, opacity: t < 0.12 ? t / 0.12 : t > 0.88 ? (1 - t) / 0.12 : 1 });
      }
      await finish(track(particle.animate(frames, { duration: TRAVEL / speed, easing: EASING })), token);
    }

    /** Holds the current step; `onFrame` gets the progress (0–1) while it runs, paused or not. */
    async function hold(ms: number, token: number, onFrame?: (progress: number) => void) {
      const animation = track(root!.animate([{ opacity: 1 }, { opacity: 1 }], { duration: ms / speed }));
      let frame = 0;
      if (onFrame) {
        const tick = () => {
          const t = Number(animation.currentTime ?? 0) / (ms / speed);
          onFrame(Math.min(1, Math.max(0, t)));
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

    async function loop(token: number) {
      setPlaying(true);
      for (let i = 0; ; i = (i + 1) % SCENARIOS.length) {
        const s = SCENARIOS[i]!;
        setScoreText(undefined);
        setScenario(s);
        for (const stage of stepsFor(s)) {
          const pathId = pathInto(s, stage);
          if (pathId) await travel(pathId, token);
          setStep(stage);
          if (stage === 'score') {
            const target = s.expected.score ?? 0;
            await hold(HOLD.score, token, (t) => setScoreText((target * (1 - (1 - t) ** 3)).toFixed(2)));
            setScoreText(undefined);
          } else {
            await hold(HOLD[stage], token);
          }
        }
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
      setScenario(STATIC_SCENARIO);
      setStep('complete');
      setScoreText(undefined);
    }

    function syncPause() {
      for (const animation of allAnimations()) {
        if (hidden()) animation.pause();
        else if (animation.playState === 'paused') animation.play();
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
      <FlowArtwork layout="horizontal" scenario={scenario} step={step} scoreText={scoreText} playing={playing} />
      <FlowArtwork layout="vertical" scenario={scenario} step={step} scoreText={scoreText} playing={playing} />
    </div>
  );
}
