import type { Factor, Level } from './complexity';
import { WEIGHTS, THRESHOLDS, ROUTING_CONFIDENCE } from './complexity';
import { dialArc, dialPoint, GEOMETRY, wrap, type Layout, type PathId } from './geometry';
import { Bar, Icon, NeonDefs, NodeBox } from './primitives';
import { GROUPS, type Scenario, type StageId } from './scenarios';
import styles from './flow.module.css';

/**
 * The home page flow (US1, FR-005, FR-008): an original inline SVG of intake → routing rules →
 * decision model → group or Needs Triage → complexity factors → weighted score → model level.
 *
 * Pure: it draws one scenario at one step. The server renders `step: 'complete'`, the full static
 * diagram that no-JS and reduce-motion visitors see (FR-009, FR-018); FlowPlayer steps through the
 * scenarios on the client. Only --rx-* tokens colour it (FR-015), and only AI stages are neon (FR-016a).
 */

export type Step = StageId | 'complete';

export const LEVELS: readonly Level[] = ['Fast', 'Standard', 'Advanced'];

const FACTOR_LABELS: Record<Factor, string> = {
  frustration: 'Frustration',
  severalIssues: 'Several issues',
  technical: 'Technical problem',
  vip: 'VIP customer',
};

/** The stages a scenario passes through, in order. */
export function stepsFor(s: Scenario): StageId[] {
  const steps: StageId[] = ['intake', 'rules'];
  if (!s.ruleMatch) steps.push('decision');
  if (s.expected.group === 'Needs Triage') steps.push('triage');
  else steps.push('groups', 'factors', 'score', 'levels');
  return steps;
}

/** The path a ticket travels to reach each step (none for intake). */
export function pathInto(s: Scenario, step: StageId): PathId | null {
  const g = GROUPS.indexOf(s.expected.group as (typeof GROUPS)[number]);
  const l = s.expected.level ? LEVELS.indexOf(s.expected.level) : -1;
  switch (step) {
    case 'rules':
      return 'intake-rules';
    case 'decision':
      return 'rules-decision';
    case 'groups':
      return s.ruleMatch ? `rules-group-${g}` : `decision-group-${g}`;
    case 'triage':
      return 'decision-triage';
    case 'factors':
      return `group-${g}-factors`;
    case 'score':
      return 'factors-score';
    case 'levels':
      return `score-level-${l}`;
    default:
      return null;
  }
}

const AI_PATH = /^(decision-|factors-|score-)/;

export interface FlowArtworkProps {
  layout: Layout;
  scenario: Scenario;
  step: Step;
  /** Overrides the score text while the player counts up. */
  scoreText?: string;
  playing?: boolean;
}

export function FlowArtwork({ layout, scenario, step, scoreText, playing }: FlowArtworkProps) {
  const g = GEOMETRY[layout];
  const id = `rx-flow-${layout}`;
  const steps = stepsFor(scenario);
  const at = step === 'complete' ? steps.length - 1 : steps.indexOf(step);
  const reached = (stage: StageId) => {
    const i = steps.indexOf(stage);
    return i !== -1 && i <= at;
  };
  const active = (stage: StageId) => step === stage;
  const state = (stage: StageId) => ({
    'data-stage': stage,
    'data-reached': reached(stage),
    'data-active': active(stage),
  });
  const litPaths = new Set(steps.filter((s, i) => i <= at).map((s) => pathInto(scenario, s)).filter(Boolean));

  const groupIndex = GROUPS.indexOf(scenario.expected.group as (typeof GROUPS)[number]);
  const candidates = scenario.routing?.candidates ?? [];
  const confidenceOf = (group: string) => candidates.find((c) => c.group === group)?.confidence;
  const chosenConfidence = scenario.ruleMatch ? null : confidenceOf(scenario.expected.group);
  const score = scenario.expected.score ?? 0;
  const lines = wrap(scenario.message, g.messageChars);
  const d = g.decision;
  const f = g.factors;
  const { cx, cy, r } = g.dial;
  const needleAngle = reached('score') ? score * 180 : 0;

  return (
    <svg
      className={`${styles.svg} ${styles[layout]}`}
      viewBox={`0 0 ${g.width} ${g.height}`}
      data-layout={layout}
      data-playing={playing ? 'true' : undefined}
      aria-hidden="true"
      focusable="false"
    >
      <NeonDefs id={id} />
      <rect x="0" y="0" width={g.width} height={g.height} fill={`url(#${id}-dots)`} />
      <ellipse
        className={styles.aiWash}
        cx={layout === 'horizontal' ? 900 : 190}
        cy={layout === 'horizontal' ? 210 : 900}
        rx={layout === 'horizontal' ? 380 : 240}
        ry={layout === 'horizontal' ? 230 : 520}
        fill={`url(#${id}-wash)`}
      />

      {/* Paths first, so nodes sit on top. Bypass arcs only exist for a rule match. */}
      {(Object.entries(g.paths) as [PathId, string][]).map(([pathId, path]) => {
        const bypass = pathId.startsWith('rules-group-');
        return (
          <path
            key={pathId}
            id={`${id}-${pathId}`}
            className={styles.path}
            d={path}
            data-path={pathId}
            data-ai={AI_PATH.test(pathId)}
            data-lit={litPaths.has(pathId)}
            data-optional={bypass || pathId === 'decision-triage' ? 'true' : undefined}
            data-hidden={bypass && !(scenario.ruleMatch && litPaths.has(pathId)) ? 'true' : undefined}
          />
        );
      })}

      {/* The customer's message. */}
      <g data-part="message">
        <rect className={styles.bubble} x={g.message.x} y={g.message.y} width={g.message.w} height={g.message.h} rx={14} />
        <text className={styles.bubbleTag} x={g.message.x + 14} y={g.message.y + 20}>
          Customer
        </text>
        <text className={styles.message} data-part="message-text">
          {lines.map((line, i) => (
            <tspan key={i} x={g.message.x + 14} y={g.message.y + 40 + i * 17}>
              {line}
            </tspan>
          ))}
        </text>
      </g>

      {/* Intake and routing rules. */}
      <g {...state('intake')}>
        <NodeBox box={g.intake} defsId={id} />
        <Icon name="chat" x={g.intake.x + 14} y={g.intake.y + 14} />
        <text className={styles.title} x={g.intake.x + 40} y={g.intake.y + 28}>New ticket</text>
        <text className={styles.sub} x={g.intake.x + 14} y={g.intake.y + 54}>from customer chat</text>
      </g>
      <g {...state('rules')}>
        <NodeBox box={g.rules} defsId={id} />
        <Icon name="rules" x={g.rules.x + 14} y={g.rules.y + 14} />
        <text className={styles.title} x={g.rules.x + 40} y={g.rules.y + 28}>Rules</text>
        <text className={styles.sub} x={g.rules.x + 14} y={g.rules.y + 52}>checked first</text>
      </g>
      <g className={styles.ruleBadge} data-part="rule-badge" data-shown={Boolean(scenario.ruleMatch && reached('rules'))}>
        <rect className={styles.ruleBadgeBg} x={g.ruleBadge.x} y={g.ruleBadge.y} width={g.ruleBadge.w} height={g.ruleBadge.h} rx={g.ruleBadge.h / 2} />
        <Icon name="check" x={g.ruleBadge.x + 8} y={g.ruleBadge.y + 6} size={16} />
        <text className={styles.value} x={g.ruleBadge.x + 28} y={g.ruleBadge.y + 18}>
          {scenario.ruleMatch ? `Rule: ${scenario.ruleMatch.rule}` : 'Rule matched'}
        </text>
      </g>

      {/* Decision model (AI): candidates with confidence against the 0.70 threshold. */}
      <g {...state('decision')} data-ai="true">
        <NodeBox box={d} ai defsId={id} />
        <Icon name="spark" x={d.x + 14} y={d.y + 14} />
        <text className={styles.title} x={d.x + 40} y={d.y + 28}>Decision model</text>
        <text className={styles.sub} x={d.x + 14} y={d.y + 50}>reads the first message</text>
        {[0, 1].map((i) => {
          const c = candidates[i];
          const y = d.y + 74 + i * 34;
          const show = Boolean(c) && reached('decision');
          return (
            <g key={i}>
              <text className={styles.small} x={d.x + 14} y={y}>{show ? c!.group : i === 0 ? 'Best group' : 'Next best'}</text>
              <text className={styles.value} x={d.x + d.w - 14} y={y} textAnchor="end">{show ? c!.confidence.toFixed(2) : '–'}</text>
              <Bar x={d.x + 14} y={y + 7} w={d.w - 28} value={show ? c!.confidence : 0} muted={i === 1} />
            </g>
          );
        })}
        {(() => {
          const tx = d.x + 14 + (d.w - 28) * ROUTING_CONFIDENCE;
          return (
            <g>
              <line className={styles.threshold} x1={tx} x2={tx} y1={d.y + 78} y2={d.y + 122} />
              <text className={styles.small} x={tx} y={d.y + d.h - 10} textAnchor="middle">{ROUTING_CONFIDENCE.toFixed(2)}</text>
            </g>
          );
        })()}
      </g>

      {/* Groups and the Needs Triage fallback. */}
      {GROUPS.map((group, i) => {
        const b = g.groups[i]!;
        const chosen = reached('groups') && i === groupIndex;
        const badge = chosenConfidence !== null && chosenConfidence !== undefined ? chosenConfidence.toFixed(2) : 'rule';
        return (
          <g key={group} data-stage="groups" data-group={group} data-chosen={chosen} data-active={chosen && active('groups')}>
            <rect className={styles.chip} x={b.x} y={b.y} width={b.w} height={b.h} rx={b.h / 2} />
            <g transform={`translate(${b.x + 12} ${b.y + b.h / 2 - 8})`}>
              <Icon name="team" x={0} y={0} size={16} />
            </g>
            <text className={styles.chipLabel} x={b.x + 34} y={b.y + b.h / 2 + 4.5}>{group}</text>
            <g className={styles.badge}>
              <rect className={styles.badgeBg} x={b.x + b.w - 44} y={b.y + b.h / 2 - 9} width={36} height={18} rx={9} />
              <text className={styles.badgeText} x={b.x + b.w - 26} y={b.y + b.h / 2 + 4} textAnchor="middle">{badge}</text>
            </g>
          </g>
        );
      })}
      <g {...state('triage')} data-chosen={reached('triage')}>
        <rect className={styles.triage} x={g.triage.x} y={g.triage.y} width={g.triage.w} height={g.triage.h} rx={g.triage.h / 2} />
        <g className={styles.triageIcon}>
          <Icon name="alert" x={g.triage.x + 14} y={g.triage.y + g.triage.h / 2 - 9} />
        </g>
        <text className={styles.triageLabel} x={g.triage.x + 40} y={g.triage.y + g.triage.h / 2 + 4.5}>Needs Triage</text>
      </g>

      {/* Complexity factors (AI). */}
      <g {...state('factors')} data-ai="true">
        <NodeBox box={f} ai defsId={id} />
        <Icon name="sliders" x={f.x + 14} y={f.y + 14} />
        <text className={styles.title} x={f.x + 40} y={f.y + 28}>Complexity</text>
        {(Object.keys(WEIGHTS) as Factor[]).map((factor, i) => {
          const y = f.y + 58 + i * 38;
          const value = scenario.factors?.[factor] ?? 0;
          const show = reached('factors');
          return (
            <g key={factor} data-factor={factor}>
              <text className={styles.small} x={f.x + 14} y={y}>{FACTOR_LABELS[factor]}</text>
              <text className={styles.value} x={f.x + f.w - 14} y={y} textAnchor="end">×{WEIGHTS[factor]}</text>
              <Bar x={f.x + 14} y={y + 8} w={f.w - 28} value={show ? value : 0} />
            </g>
          );
        })}
      </g>

      {/* Weighted score dial (AI): Fast below 0.45, Standard below 0.80, Advanced above. */}
      <g {...state('score')} data-ai="true">
        <path className={`${styles.arc} ${styles.arcFast}`} d={dialArc(cx, cy, r, 0, THRESHOLDS.standard)} />
        <path className={`${styles.arc} ${styles.arcStandard}`} d={dialArc(cx, cy, r, THRESHOLDS.standard, THRESHOLDS.advanced)} />
        <path className={`${styles.arc} ${styles.arcAdvanced}`} d={dialArc(cx, cy, r, THRESHOLDS.advanced, 1)} />
        {[THRESHOLDS.standard, THRESHOLDS.advanced].map((t) => {
          const inner = dialPoint(cx, cy, r - 9, t);
          const outer = dialPoint(cx, cy, r + 7, t);
          const label = dialPoint(cx, cy, r + 18, t);
          return (
            <g key={t}>
              <line className={styles.tick} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} />
              <text className={styles.small} x={label.x} y={label.y + 3} textAnchor="middle">{t.toFixed(2)}</text>
            </g>
          );
        })}
        <line
          className={styles.needle}
          x1={cx}
          y1={cy}
          x2={cx - r + 12}
          y2={cy}
          style={{ transform: `rotate(${needleAngle}deg)`, transformOrigin: `${cx}px ${cy}px` }}
        />
        <circle className={styles.hub} cx={cx} cy={cy} r={4.5} />
        <text className={styles.score} x={cx} y={cy + 30} textAnchor="middle" data-part="score">
          {scoreText ?? (reached('score') ? score.toFixed(2) : '0.00')}
        </text>
      </g>

      {/* Model levels (AI). */}
      {LEVELS.map((lvl, i) => {
        const b = g.levels[i]!;
        const chosen = reached('levels') && scenario.expected.level === lvl;
        const dot = lvl === 'Fast' ? styles.pillDotFast : lvl === 'Standard' ? styles.pillDotStandard : styles.pillDotAdvanced;
        return (
          <g
            key={lvl}
            data-stage="levels"
            data-ai="true"
            data-level={lvl}
            data-chosen={chosen}
            data-active={chosen && active('levels')}
            filter={chosen ? `url(#${id}-neon)` : undefined}
          >
            <rect className={styles.pill} x={b.x} y={b.y} width={b.w} height={b.h} rx={b.h / 2} />
            <circle className={dot} cx={b.x + 16} cy={b.y + b.h / 2} r={4.5} />
            <text className={styles.pillLabel} x={b.x + 28} y={b.y + b.h / 2 + 4.5}>{lvl}</text>
          </g>
        );
      })}

      {/* The travelling ticket, moved by FlowPlayer along the lit path. */}
      <g className={styles.particle} data-part="particle">
        <circle className={styles.particleGlow} r={11} />
        <circle className={styles.particleCore} r={4.5} />
      </g>
    </svg>
  );
}
