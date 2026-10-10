import type { ReactNode } from 'react';
import type { Box } from './geometry';
import styles from './flow.module.css';

/**
 * Drawing primitives shared by the home flow and the concept page illustrations: one visual
 * language (1.5 px strokes, 12 px corners, the same icons and the neon treatment for AI parts).
 * Colours come only from the --rx-* tokens via flow.module.css.
 */

export const RADIUS = 12;

/**
 * Filter and paint definitions. `id` prefixes every definition so two SVGs on one page (the
 * horizontal and vertical layouts) don't share ids.
 */
export function NeonDefs({ id }: { id: string }) {
  return (
    <defs>
      {/* Two blurred copies of the stroke, tinted with the AI glow tokens, under the original. */}
      <filter id={`${id}-neon`} x="-25%" y="-25%" width="150%" height="150%" colorInterpolationFilters="sRGB">
        <feGaussianBlur in="SourceAlpha" stdDeviation="7" result="wide" />
        <feFlood style={{ floodColor: 'var(--rx-ai-glow-2)' }} result="wideColor" />
        <feComposite in="wideColor" in2="wide" operator="in" result="halo" />
        <feGaussianBlur in="SourceAlpha" stdDeviation="2.2" result="tight" />
        <feFlood style={{ floodColor: 'var(--rx-ai-glow)' }} result="tightColor" />
        <feComposite in="tightColor" in2="tight" operator="in" result="glow" />
        <feMerge>
          <feMergeNode in="halo" />
          <feMergeNode in="glow" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <pattern id={`${id}-dots`} width="22" height="22" patternUnits="userSpaceOnUse">
        <circle className={styles.dot} cx="1.5" cy="1.5" r="1.1" />
      </pattern>
      <radialGradient id={`${id}-wash`}>
        <stop offset="0%" style={{ stopColor: 'var(--rx-ai-glow-2)', stopOpacity: 0.5 }} />
        <stop offset="100%" style={{ stopColor: 'var(--rx-ai-glow-2)', stopOpacity: 0 }} />
      </radialGradient>
    </defs>
  );
}

export type IconName = 'chat' | 'rules' | 'spark' | 'team' | 'alert' | 'sliders' | 'gauge' | 'check';

const ICONS: Record<IconName, ReactNode> = {
  chat: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H9l-3.5 3v-3h0A2.5 2.5 0 0 1 4 10.5z" />,
  rules: <path d="M3.5 5h13M6 10h8M8.5 15h3" />,
  spark: (
    <>
      <path d="M10 2.5l1.6 4.4 4.4 1.6-4.4 1.6L10 14.5l-1.6-4.4L4 8.5l4.4-1.6z" />
      <path d="M15.5 13.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </>
  ),
  team: (
    <>
      <circle cx="7.5" cy="7" r="2.5" />
      <path d="M3 15.5c.6-2.4 2.3-3.8 4.5-3.8s3.9 1.4 4.5 3.8" />
      <circle cx="13.5" cy="7.5" r="2" />
      <path d="M13 11.8c1.9.1 3.3 1.3 3.9 3.2" />
    </>
  ),
  alert: (
    <>
      <path d="M10 3.2l7 12.3H3z" />
      <path d="M10 8.2v3.4M10 13.6v.1" />
    </>
  ),
  sliders: <path d="M4 5h6m3 0h3M4 10h2m3 0h7M4 15h8m3 0h1M10 3.5v3M6 8.5v3M12 13.5v3" />,
  gauge: (
    <>
      <path d="M3.5 13.5a6.5 6.5 0 0 1 13 0" />
      <path d="M10 13.5l3-4" />
    </>
  ),
  check: <path d="M4.5 10.5l3.5 3.5 7.5-8" />,
};

/** A 20×20 stroke icon drawn at (x, y), in currentColor. */
export function Icon({ name, x, y, size = 18 }: { name: IconName; x: number; y: number; size?: number }) {
  return (
    <g className={styles.icon} transform={`translate(${x} ${y}) scale(${size / 20})`}>
      <g fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        {ICONS[name]}
      </g>
    </g>
  );
}

/** A rounded node. AI nodes get the neon outline (filter `url(#<id>-neon)`) drawn on top. */
export function NodeBox({ box, ai, defsId }: { box: Box; ai?: boolean; defsId: string }) {
  return (
    <>
      <rect className={styles.node} x={box.x} y={box.y} width={box.w} height={box.h} rx={RADIUS} />
      {ai && (
        <rect
          className={styles.neon}
          x={box.x}
          y={box.y}
          width={box.w}
          height={box.h}
          rx={RADIUS}
          filter={`url(#${defsId}-neon)`}
        />
      )}
    </>
  );
}

/** A horizontal bar whose fill shows `value` (0–1); the fill animates when the value changes. */
export function Bar({ x, y, w, h = 6, value, muted }: { x: number; y: number; w: number; h?: number; value: number; muted?: boolean }) {
  return (
    <>
      <rect className={styles.track} x={x} y={y} width={w} height={h} rx={h / 2} />
      <rect
        className={`${styles.fill} ${muted ? styles.fillMuted : ''}`}
        x={x}
        y={y}
        width={w}
        height={h}
        rx={h / 2}
        style={{ transform: `scaleX(${Math.max(0, Math.min(1, value))})` }}
      />
    </>
  );
}
