import { FACTOR_LABELS, level, score, THRESHOLDS, WEIGHTS, type Factor, type Level } from '../flow/complexity';
import { ComplexityRing } from '../flow/primitives';
import { STATIC_SCENARIO } from '../flow/scenarios';

import s from './illustrations.module.css';
import { Box, Diagram } from './parts';

/**
 * How complexity picks a model, as a still: the four default factors and their weights, the weighted
 * average, and where it falls against the Standard and Advanced thresholds. The example is scenario 3
 * of contracts/flow-scenarios.md, the same ticket the home reel shows when it is still.
 */

const ID = 'complexity-diagram';
const values = STATIC_SCENARIO.factors!;
const factors = Object.keys(WEIGHTS) as Factor[];
const total = factors.reduce((t, f) => t + WEIGHTS[f], 0);
const value = score(values);
const picked = level(value);
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const formula = `(${factors.map((f) => `${WEIGHTS[f]}×${fmt(values[f])}`).join(' + ')}) ÷ ${total} = ${value.toFixed(2)}`;

const LEVELS: { level: Level; from: number; to: number; fill: string; text: string }[] = [
  { level: 'Fast', from: 0, to: THRESHOLDS.standard, fill: s.fast!, text: s.fastText! },
  { level: 'Standard', from: THRESHOLDS.standard, to: THRESHOLDS.advanced, fill: s.standard!, text: s.standardText! },
  { level: 'Advanced', from: THRESHOLDS.advanced, to: 1, fill: s.advanced!, text: s.advancedText! },
];

export function ComplexityDiagram() {
  const barX = 20;
  const barW = 520;
  const at = (n: number) => barX + barW * n;
  return (
    <Diagram
      id={ID}
      width={560}
      height={536}
      title="How complexity picks a model"
      desc={
        `Four default factors are scored from 0 to 1: ${factors
          .map((f) => `${FACTOR_LABELS[f]} (weight ${WEIGHTS[f]})`)
          .join(', ')}. The complexity is their weighted average. Below ${THRESHOLDS.standard.toFixed(2)} the Fast ` +
        `model answers, from ${THRESHOLDS.standard.toFixed(2)} the Standard model, and from ` +
        `${THRESHOLDS.advanced.toFixed(2)} the Advanced model. In this example, ${formula}, so the ${picked} model ` +
        `answers. When complexity is not set up, or scoring fails, the Fast model answers.`
      }
    >
      <text className={s.label} x={20} y={24}>
        FACTOR
      </text>
      <text className={s.label} x={290} y={24} textAnchor="end">
        WEIGHT · VALUE
      </text>
      {factors.map((f, i) => {
        const y = 44 + i * 56;
        return (
          <g key={f} data-factor={f}>
            <text className={s.name} x={20} y={y + 16}>
              {FACTOR_LABELS[f]}
            </text>
            <text className={s.value} x={290} y={y + 16} textAnchor="end">
              ×{WEIGHTS[f]} · {fmt(values[f])}
            </text>
            <rect className={s.track} x={20} y={y + 28} width={270} height={6} rx={3} />
            {values[f] > 0 && (
              <rect className={s.fill} x={20} y={y + 28} width={270 * values[f]} height={6} rx={3} filter={`url(#${ID}-neon)`} />
            )}
          </g>
        );
      })}
      <ComplexityRing id={`${ID}-ring`} values={values} score={value} scoreText={value.toFixed(2)} place={{ x: 310, y: 8, size: 240 }} />

      <text className={s.formula} x={280} y={300} textAnchor="middle">
        {formula}
      </text>
      <text className={s.label} x={280} y={322} textAnchor="middle">
        WEIGHTED AVERAGE · FRUSTRATION COUNTS DOUBLE
      </text>

      {/* Where the score falls between the thresholds. */}
      {LEVELS.map((l) => (
        <g key={l.level} data-level={l.level}>
          <rect className={l.fill} x={at(l.from) + 1} y={372} width={at(l.to) - at(l.from) - 2} height={14} rx={4} opacity={l.level === picked ? 1 : 0.35} />
          <text className={`${s.label} ${l.text}`} x={(at(l.from) + at(l.to)) / 2} y={362} textAnchor="middle">
            {l.level.toUpperCase()}
          </text>
        </g>
      ))}
      {[0, THRESHOLDS.standard, THRESHOLDS.advanced, 1].map((t, i, all) => (
        <text key={t} className={s.value} x={at(t)} y={406} textAnchor={i === 0 ? 'start' : i === all.length - 1 ? 'end' : 'middle'}>
          {fmt(t)}
        </text>
      ))}
      <line className={s.tick} x1={at(value)} y1={366} x2={at(value)} y2={392} />
      <circle className={s.marker} cx={at(value)} cy={379} r={5} />
      <text className={s.value} x={at(value) + 12} y={432}>
        {value.toFixed(2)} → {picked.toUpperCase()}
      </text>

      <Box x={20} y={460} w={520} h={60} icon="gauge" name="Not set up, or scoring fails → Fast" caption="THE FALLBACK LEVEL" />
    </Diagram>
  );
}
