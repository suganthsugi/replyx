import type { ReactNode } from 'react';
import { THRESHOLDS, WEIGHTS, type Factor } from './complexity';
import styles from './reel.module.css';

/**
 * Drawing primitives shared by the home reel and the concept page illustrations: one visual language
 * (glossy AI core, weighted complexity ring, the neon treatment for AI parts). Colours come only from
 * the --rx-* tokens, so everything follows the theme live (FR-015, FR-016a).
 */

/**
 * Filter and paint definitions. `id` prefixes every definition so several SVGs on one page don't
 * share ids.
 */
export function NeonDefs({ id }: { id: string }) {
  return (
    <defs>
      {/* Two blurred copies of the shape, tinted with the AI glow tokens, under the original. */}
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
      <radialGradient id={`${id}-wash`}>
        <stop offset="0%" style={{ stopColor: 'var(--rx-ai-glow-2)', stopOpacity: 0.55 }} />
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
    <g transform={`translate(${x} ${y}) scale(${size / 20})`}>
      <g fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        {ICONS[name]}
      </g>
    </g>
  );
}

const C = 200;

function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

function arc(r: number, from: number, to: number) {
  const [x0, y0] = polar(r, from);
  const [x1, y1] = polar(r, to);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Neurons inside the AI core: [x, y] points and the links between them. */
const NEURONS: [number, number][] = [
  [150, 150], [205, 128], [250, 168], [140, 215], [196, 196], [258, 230], [175, 262], [228, 276],
];
const SYNAPSES: [number, number][] = [
  [0, 1], [1, 2], [0, 3], [0, 4], [1, 4], [2, 4], [2, 5], [3, 4], [4, 5], [3, 6], [4, 6], [4, 7], [5, 7], [6, 7],
];

/**
 * The decision model: a glossy neon sphere with a neural mesh inside and two orbits a light travels
 * around. `dim` greys it out when a routing rule matched and the model was skipped.
 */
export function CoreOrb({ id, dim }: { id: string; dim?: boolean }) {
  return (
    <svg className={styles.core} viewBox="-40 -40 480 480" data-dim={dim ? 'true' : undefined} aria-hidden="true">
      <NeonDefs id={id} />
      <defs>
        <radialGradient id={`${id}-sphere`} cx="36%" cy="30%" r="78%">
          <stop offset="0%" style={{ stopColor: 'color-mix(in srgb, var(--rx-ai) 18%, white)' }} />
          <stop offset="38%" style={{ stopColor: 'var(--rx-ai)' }} />
          <stop offset="78%" style={{ stopColor: 'color-mix(in srgb, var(--rx-ai) 45%, var(--rx-bg))' }} />
          <stop offset="100%" style={{ stopColor: 'color-mix(in srgb, var(--rx-level-advanced) 35%, var(--rx-bg))' }} />
        </radialGradient>
        <linearGradient id={`${id}-orbit`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" style={{ stopColor: 'var(--rx-ai)', stopOpacity: 0.15 }} />
          <stop offset="55%" style={{ stopColor: 'var(--rx-ai)' }} />
          <stop offset="100%" style={{ stopColor: 'var(--rx-level-advanced)' }} />
        </linearGradient>
        <clipPath id={`${id}-clip`}>
          <circle cx={C} cy={C} r={100} />
        </clipPath>
      </defs>

      <circle className={styles.halo} cx={C} cy={C} r={210} fill={`url(#${id}-wash)`} />

      {/* Back orbit: a faint ring, with a light travelling round it. */}
      <g transform={`rotate(-18 ${C} ${C})`}>
        <ellipse className={styles.orbitTrack} cx={C} cy={C} rx={192} ry={54} stroke={`url(#${id}-orbit)`} />
        <ellipse className={`${styles.orbitLight} ${styles.orbitSlow}`} cx={C} cy={C} rx={192} ry={54} pathLength={1} filter={`url(#${id}-neon)`} />
      </g>

      <circle className={styles.sphere} cx={C} cy={C} r={100} fill={`url(#${id}-sphere)`} filter={`url(#${id}-neon)`} />
      <g clipPath={`url(#${id}-clip)`} className={styles.neural}>
        {SYNAPSES.map(([a, b]) => (
          <line key={`${a}-${b}`} x1={NEURONS[a]![0]} y1={NEURONS[a]![1]} x2={NEURONS[b]![0]} y2={NEURONS[b]![1]} />
        ))}
        {NEURONS.map(([x, y], i) => (
          <circle key={i} className={styles.neuron} cx={x} cy={y} r={4.5} style={{ ['--i' as string]: i }} />
        ))}
      </g>
      <ellipse className={styles.spec} cx={166} cy={152} rx={40} ry={19} transform="rotate(-35 166 152)" />

      {/* Front orbit, tilted the other way. */}
      <g transform={`rotate(24 ${C} ${C})`}>
        <ellipse className={styles.orbitTrack} cx={C} cy={C} rx={168} ry={44} stroke={`url(#${id}-orbit)`} />
        <ellipse className={`${styles.orbitLight} ${styles.orbitFast}`} cx={C} cy={C} rx={168} ry={44} pathLength={1} filter={`url(#${id}-neon)`} />
      </g>
    </svg>
  );
}

/**
 * The complexity score: an inner ring of factor segments sized by their weight (frustration counts
 * double) that fill to each factor's value, and an outer ring that fills to the weighted score, with
 * ticks at the Standard and Advanced thresholds.
 */
export function ComplexityRing({
  id,
  values,
  score,
  scoreText,
}: {
  id: string;
  values: Record<Factor, number>;
  score: number;
  scoreText: string;
}) {
  const factors = Object.keys(WEIGHTS) as Factor[];
  const total = factors.reduce((t, f) => t + WEIGHTS[f], 0);
  const gap = 10;
  const usable = 360 - gap * factors.length;
  let at = -90 + gap / 2;
  const segments = factors.map((factor) => {
    const sweep = (usable * WEIGHTS[factor]) / total;
    const segment = { factor, d: arc(126, at, at + sweep), mid: at + sweep / 2 };
    at += sweep + gap;
    return segment;
  });

  return (
    <svg className={styles.ring} viewBox="-40 -40 480 480" aria-hidden="true">
      <NeonDefs id={id} />
      <circle className={styles.halo} cx={C} cy={C} r={200} fill={`url(#${id}-wash)`} />

      <circle className={styles.scoreTrack} cx={C} cy={C} r={170} />
      <circle
        className={styles.scoreFill}
        cx={C}
        cy={C}
        r={170}
        pathLength={1}
        transform={`rotate(-90 ${C} ${C})`}
        style={{ strokeDashoffset: 1 - score }}
        filter={`url(#${id}-neon)`}
      />
      {[THRESHOLDS.standard, THRESHOLDS.advanced].map((t) => {
        const deg = -90 + 360 * t;
        const [x0, y0] = polar(158, deg);
        const [x1, y1] = polar(184, deg);
        const [lx, ly] = polar(208, deg);
        return (
          <g key={t}>
            <line className={styles.tick} x1={x0} y1={y0} x2={x1} y2={y1} />
            <text className={styles.tickLabel} x={lx} y={ly + 5} textAnchor="middle">
              {t.toFixed(2)}
            </text>
          </g>
        );
      })}

      {segments.map(({ factor, d, mid }) => {
        const [lx, ly] = polar(94, mid);
        return (
          <g key={factor} data-factor={factor}>
            <path className={styles.segTrack} d={d} />
            <path
              className={styles.segFill}
              d={d}
              pathLength={1}
              style={{ strokeDashoffset: 1 - values[factor] }}
              filter={`url(#${id}-neon)`}
            />
            <text className={styles.segLabel} x={lx} y={ly + 5} textAnchor="middle">
              ×{WEIGHTS[factor]}
            </text>
          </g>
        );
      })}

      <text className={styles.ringScore} x={C} y={C + 18} textAnchor="middle" data-part="score">
        {scoreText}
      </text>
      <text className={styles.ringLabel} x={C} y={C + 50} textAnchor="middle">
        COMPLEXITY
      </text>
    </svg>
  );
}
