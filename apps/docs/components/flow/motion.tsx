'use client';

import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import s from './reel.module.css';

/**
 * Text effects for the home reel. Each effect is timed by a Web Animations API animation on its own
 * element, handed to the player (`adopt`), so pausing the reel also freezes the text. When the reel
 * isn't playing (server render, no JS, reduced motion) the text is simply shown in full.
 */

export const ReelMotion = createContext<{ playing: boolean; speed: number; adopt: (a: Animation) => void }>({
  playing: false,
  speed: 1,
  adopt: () => {},
});

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=<>/';
const randomGlyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!;

/**
 * Runs `draw(ms)` every frame while `timer` plays, and checks back rarely while it is paused (the tab
 * is hidden or the figure is off screen). Returns a cleanup function.
 */
function drive(timer: Animation, draw: (ms: number, done: boolean) => boolean) {
  let frame = 0;
  let wait = 0;
  const tick = () => {
    if (timer.playState === 'paused') {
      wait = window.setTimeout(tick, 250);
      return;
    }
    const done = timer.playState === 'finished' || timer.playState === 'idle';
    if (draw(done ? Infinity : Number(timer.currentTime ?? 0), done)) frame = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(wait);
    timer.cancel();
  };
}

interface DecodeProps {
  text: string;
  /** ms before the first character resolves (at speed 1). */
  delay?: number;
  /** ms per character (at speed 1). */
  perChar?: number;
  /** `decode` resolves scrambled glyphs left to right; `type` types the text with a caret. */
  mode?: 'decode' | 'type';
  className?: string;
  style?: CSSProperties;
}

function DecodeText({ text, delay = 0, perChar = 22, mode = 'decode', className, style }: DecodeProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const { playing, speed, adopt } = useContext(ReelMotion);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !playing) return;
    const start = delay / speed;
    const step = perChar / speed;
    el.textContent = mode === 'type' ? '' : ' ';
    const timer = el.animate([{ opacity: 1 }, { opacity: 1 }], { duration: start + text.length * step + 200 / speed });
    adopt(timer);
    return drive(timer, (ms) => {
      const n = Math.floor(Math.max(0, ms - start) / step);
      if (ms < start) return true;
      if (n >= text.length) {
        el.textContent = text;
        return false;
      }
      if (mode === 'type') {
        el.textContent = `${text.slice(0, n)}▍`;
      } else {
        let out = text.slice(0, n);
        for (let i = n; i < Math.min(text.length, n + 10); i++) out += text[i] === ' ' ? ' ' : randomGlyph();
        el.textContent = out;
      }
      return true;
    });
  }, [text, playing, speed, adopt, delay, perChar, mode]);

  return (
    <span ref={ref} className={className} style={style}>
      {text}
    </span>
  );
}

/** Text that decodes (or types) itself in. Keyed by its text, so new text replays the effect. */
export function Decode(props: DecodeProps) {
  return <DecodeText key={props.text} {...props} />;
}

/**
 * Display type that spins through glyphs like a split-flap board, each character locking in place
 * left to right with a flash. Every character keeps its final width, so the line never jitters.
 */
export function Scramble({ text, delay = 0, spin = 420, lockEvery = 120 }: { text: string; delay?: number; spin?: number; lockEvery?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { playing, speed, adopt } = useContext(ReelMotion);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !playing) return;
    const cells = [...el.querySelectorAll<HTMLElement>('[data-cell]')];
    const glyphs = cells.map((c) => c.querySelector<HTMLElement>('[data-glyph]')!);
    const lockAt = (i: number) => (delay + spin + i * lockEvery) / speed;
    const startAt = (i: number) => (delay + i * 45) / speed;
    for (const c of cells) c.dataset.state = 'idle';
    const timer = el.animate([{ opacity: 1 }, { opacity: 1 }], { duration: lockAt(cells.length) + 100 / speed });
    adopt(timer);
    let lastTick = -1;
    return drive(timer, (ms) => {
      const tick = Math.floor(ms / (55 / speed));
      cells.forEach((cell, i) => {
        const state = ms < startAt(i) ? 'idle' : ms < lockAt(i) ? 'spin' : 'locked';
        if (cell.dataset.state !== state) cell.dataset.state = state;
        if (state === 'spin' && tick !== lastTick && cell.dataset.space !== 'true') glyphs[i]!.textContent = randomGlyph();
      });
      lastTick = tick;
      return cells.some((c) => c.dataset.state !== 'locked');
    });
  }, [text, playing, speed, adopt, delay, spin, lockEvery]);

  return (
    <span ref={ref} className={s.scramble} key={text}>
      {[...text].map((ch, i) => (
        <span key={i} className={s.flap} data-cell data-state="locked" data-space={ch === ' ' ? 'true' : undefined}>
          <span className={s.flapFinal}>{ch === ' ' ? ' ' : ch}</span>
          <span className={s.flapGlyph} data-glyph />
        </span>
      ))}
    </span>
  );
}

/**
 * A ticket stub drawn around its parent: rounded corners, a notch on each side and a perforation
 * before the `[data-stub]` child. Measured in pixels so the notches stay round at any size.
 */
export function TicketOutline() {
  const ref = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState<{ w: number; h: number; p: number | null } | null>(null);

  useLayoutEffect(() => {
    const svg = ref.current;
    const parent = svg?.parentElement;
    if (!svg || !parent) return;
    const measure = () => {
      const stub = parent.querySelector<HTMLElement>('[data-stub]');
      setBox({ w: parent.offsetWidth, h: parent.offsetHeight, p: stub ? stub.offsetLeft : null });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  let outline = '';
  if (box) {
    const { w, h } = box;
    const r = Math.min(h * 0.14, 14);
    const n = h * 0.13;
    const cy = h / 2;
    outline =
      `M${r} 1 H${w - r} A${r} ${r} 0 0 1 ${w - 1} ${r} V${cy - n} A${n} ${n} 0 0 0 ${w - 1} ${cy + n} ` +
      `V${h - r} A${r} ${r} 0 0 1 ${w - r} ${h - 1} H${r} A${r} ${r} 0 0 1 1 ${h - r} V${cy + n} ` +
      `A${n} ${n} 0 0 0 1 ${cy - n} V${r} A${r} ${r} 0 0 1 ${r} 1 Z`;
  }

  return (
    <svg ref={ref} className={s.ticketOutline} width={box?.w ?? 0} height={box?.h ?? 0} aria-hidden="true">
      {box && (
        <>
          <path className={s.ticketPath} d={outline} pathLength={1} />
          {box.p !== null && <line className={s.ticketPerf} x1={box.p} x2={box.p} y1={box.h * 0.16} y2={box.h * 0.84} />}
        </>
      )}
    </svg>
  );
}
