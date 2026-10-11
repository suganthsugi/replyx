import { FACTOR_LABELS, ROUTING_CONFIDENCE, THRESHOLDS, WEIGHTS, type Factor, type Level } from './complexity';
import { Decode, ReelMotion, Scramble, TicketOutline } from './motion';
import { ComplexityRing, CoreOrb } from './primitives';
import s from './reel.module.css';
import { GROUPS, SCENARIOS, STAGES, type Group, type Scenario, type StageId } from './scenarios';

import type { CSSProperties, ReactNode } from 'react';

/**
 * The home page flow (US1, FR-005, FR-008) as a motion-graphics reel: each ticket plays in beats
 * (a new ticket → routing → complexity → model level → recap), with kinetic type, a HUD and one
 * hero object per beat. The stage links form the reel's chapter bar (FR-007).
 *
 * Pure: it draws one scenario at one step. The server renders `step: 'complete'` (the recap of
 * scenario 3), which is what no-JS and reduce-motion visitors see (FR-009); FlowPlayer steps through
 * the scenarios on the client. Only --rx-* tokens colour it (FR-015), and only AI parts glow (FR-016a).
 *
 * Timing lives in one storyboard (AT, holdFor, COUNT_WINDOW): every delay below and in
 * reel.module.css comes from it, so the parts of a beat land in order and the player holds each beat
 * until it has been read.
 */

export type Step = StageId | 'complete';
export type Scene = 'ticket' | 'route' | 'complexity' | 'model' | 'end';

export const LEVELS: readonly Level[] = ['Fast', 'Standard', 'Advanced'];
const SCENES: readonly Scene[] = ['ticket', 'route', 'complexity', 'model', 'end'];

/** The storyboard: when each part of a beat starts, in ms after the beat appears (at speed 1). */
export const AT = {
  title: 250, // first title character
  sub: 2000, // the caption under a title
  panel: 700, // first panel of a beat draws on; the next ones follow every PANEL_STEP
  // 01 ticket
  ping: 0, // incoming signal at the card's landing spot
  card: 500, // the card flies in (lands about 900 ms later)
  typing: 1400, // "typing…" dots
  message: 2200, // the message types out
  scrambleNew: 300, // "A NEW" spins and locks
  ticketWord: 1100, // "TICKET." lands
  stubDraw: 2300, // the ticket outline draws round it
  stubText: 2900, // ticket number and status
  verdict: 1100, // rules: the verdict, once the scan line has passed
  // 02 route
  orb: 200, // the orb powers on
  incoming: 900, // the ticket flies into the orb
  // 04 model
  lit: 2100, // the chosen level lights up, after the word has landed
} as const;
export const PANEL_STEP = 150;
export const PER_CHAR = 30; // the message types at this many ms per character

/** How long each step holds (ms at speed 1): long enough for its parts to land and be read. */
export function holdFor(step: Step, sc: Scenario): number {
  switch (step) {
    case 'intake':
      return Math.max(4600, AT.message + sc.message.length * PER_CHAR + 1400);
    case 'rules':
      return 3000;
    case 'decision':
      return 3600;
    case 'groups':
      return sc.ruleMatch ? 4000 : 3200; // a rule match enters the beat here, so it needs the entrance too
    case 'triage':
      return 4200;
    case 'factors':
      return 3800;
    case 'score':
      return 3000;
    case 'levels':
      return 4200;
    case 'complete':
      return 4600;
  }
}

/** When the numbers of a step count up: [start, end] in ms after the step begins (at speed 1). */
export const COUNT_WINDOW: Partial<Record<Step, [number, number]>> = {
  decision: [1700, 2900], // once the rows have drawn on
  factors: [1800, 3100], // once the ring has powered on
  score: [300, 1800],
};

export function sceneOf(step: Step): Scene {
  switch (step) {
    case 'intake':
    case 'rules':
      return 'ticket';
    case 'decision':
    case 'groups':
    case 'triage':
      return 'route';
    case 'factors':
    case 'score':
      return 'complexity';
    case 'levels':
      return 'model';
    default:
      return 'end';
  }
}

/** The stages a scenario passes through, in order. */
export function stepsFor(sc: Scenario): StageId[] {
  const steps: StageId[] = ['intake', 'rules'];
  if (!sc.ruleMatch) steps.push('decision');
  if (sc.expected.group === 'Needs Triage') steps.push('triage');
  else steps.push('groups', 'factors', 'score', 'levels');
  return steps;
}

const GROUP_LINES: Record<Group, string[]> = {
  'Orders & Shipping': ['Orders &', 'shipping.'],
  Accounts: ['Accounts.'],
  'Technical Support': ['Technical', 'support.'],
  Billing: ['Billing.'],
};

const LEVEL_TONE: Record<Level, string> = { Fast: s.lvFast!, Standard: s.lvStandard!, Advanced: s.lvAdvanced! };
const LEVEL_RANGE: Record<Level, string> = {
  Fast: `< ${THRESHOLDS.standard.toFixed(2)}`,
  Standard: `${THRESHOLDS.standard.toFixed(2)} – ${THRESHOLDS.advanced.toFixed(2)}`,
  Advanced: `≥ ${THRESHOLDS.advanced.toFixed(2)}`,
};

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const ease = (t: number) => 1 - (1 - t) ** 3;
/** Starts a CSS entrance at `ms` (scaled by the reel's --s speed in reel.module.css). */
const at = (ms: number, extra?: CSSProperties) => ({ ['--at' as string]: `${ms}ms`, ...extra });
/** The start time of the i-th panel of a beat. */
const panelAt = (i: number, from: number = AT.panel) => from + i * PANEL_STEP;

/**
 * Characters that fly in from in front of the screen, out of focus and split into colour fringes,
 * then light up as they land. They land from the middle of the word outwards; once all have landed,
 * a glint runs across them left to right (`shine`).
 */
function Chars({ text, from, shine }: { text: string; from: number; shine?: number }) {
  const chars = [...text];
  const mid = (chars.length - 1) / 2;
  return (
    <>
      {chars.map((ch, i) => (
        <span
          key={i}
          className={`${s.char} ${shine !== undefined ? s.shine : ''}`}
          style={at(from + Math.abs(i - mid) * 55, shine !== undefined ? { ['--sh' as string]: `${shine + i * 45}ms` } : undefined)}
        >
          {ch === ' ' ? ' ' : ch}
        </span>
      ))}
    </>
  );
}

/** Big title type, one line after another, each line glinting once it has landed. */
function Title({ lines, tone, xl, from = AT.title }: { lines: string[]; tone?: string; xl?: boolean; from?: number }) {
  return (
    <p className={`${s.title} ${xl ? s.titleXl : ''}`} key={lines.join('|')}>
      {lines.map((line, li) => {
        const start = from + li * 320;
        const landed = start + ((line.length - 1) / 2) * 55 + 1000;
        return (
          <span key={li} className={`${s.line} ${li === lines.length - 1 ? (tone ?? s.accent) : ''}`}>
            <Chars text={line} from={start} shine={landed} />
          </span>
        );
      })}
    </p>
  );
}

function Eyebrow({ n, children }: { n: number; children: string }) {
  return (
    <span className={`${s.mono} ${s.eyebrow}`}>
      <span className={s.eyebrowNum}>{pad(n)}</span> / <Decode text={children} perChar={20} />
    </span>
  );
}

function Sub({ children, delay = AT.sub }: { children: string; delay?: number }) {
  return <Decode text={children} delay={delay} perChar={24} className={`${s.mono} ${s.sub}`} />;
}

/** 01: a customer writes in. The signal pings, the card lands, the message types out. */
function TicketScene({ sc, step }: { sc: Scenario; step: Step }) {
  const checked = step === 'rules';
  const number = SCENARIOS.indexOf(sc) + 1;
  return (
    <>
      <div className={s.copy}>
        <Eyebrow n={1}>Incoming — customer chat</Eyebrow>
        <p className={s.title}>
          <span className={s.line}>
            <Scramble text="A new" delay={AT.scrambleNew} />
          </span>
          <span className={`${s.line} ${s.accent}`}>
            <span className={s.ticket} style={at(AT.stubDraw)}>
              <span className={s.ticketWord}>
                <Chars text="Ticket." from={AT.ticketWord} shine={AT.stubDraw + 900} />
              </span>
              <span className={`${s.mono} ${s.stub}`} data-stub>
                <Decode text={`№ ${pad(number, 4)}`} delay={AT.stubText} perChar={50} />
                <Decode text="Open" delay={AT.stubText + 300} perChar={60} className={s.stubStatus} />
              </span>
              <TicketOutline />
            </span>
          </span>
        </p>
        <Sub delay={AT.stubText + 400}>Your routing rules run first</Sub>
      </div>
      <div className={s.visual}>
        <span className={s.ping} style={at(AT.ping)} />
        <span className={s.ping} style={at(AT.ping + 300)} />
        <span className={s.ping} style={at(AT.ping + 600)} />
        <div className={`${s.card} ${s.arrive}`} style={at(AT.card)}>
          <span className={s.landing} style={at(AT.card + 850)} />
          <span className={s.scanLine} data-on={checked} />
          <span className={`${s.mono} ${s.cardTag}`}>
            <span className={s.rec} /> <Decode text="Customer · just now" delay={AT.card + 700} perChar={22} />
          </span>
          <p className={s.message}>
            <span className={s.typing} style={at(AT.typing)} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <Decode text={sc.message} mode="type" delay={AT.message} perChar={PER_CHAR} />
          </p>
          <span className={`${s.mono} ${s.verdict}`} data-part="rule-badge" data-shown={checked} data-match={Boolean(sc.ruleMatch)}>
            {checked ? (
              <Decode
                text={sc.ruleMatch ? `✓ Rule match — ${sc.ruleMatch.rule}` : 'Rules checked — no match → AI'}
                delay={AT.verdict}
                perChar={26}
              />
            ) : (
              ' '
            )}
          </span>
        </div>
      </div>
    </>
  );
}

/** 02: the decision model takes the ticket and scores each team. */
function RouteScene({ sc, step, count }: { sc: Scenario; step: Step; count: number }) {
  const rule = sc.ruleMatch;
  const candidates = sc.routing?.candidates ?? [];
  const reveal = step === 'decision' ? ease(count) : 1;
  const confidence = (group: string) => candidates.find((c) => c.group === group)?.confidence;
  const chosen = step === 'groups' ? sc.expected.group : null;
  const best = candidates[0]?.confidence ?? 0;

  let lines = ['Reading', 'intent.'];
  let tone: string | undefined;
  let sub = 'The decision model reads the first message';
  if (step === 'groups') {
    lines = GROUP_LINES[sc.expected.group as Group];
    sub = rule
      ? `Rule “${rule.rule}” matched — AI skipped`
      : `Confidence ${confidence(sc.expected.group)!.toFixed(2)} ≥ ${ROUTING_CONFIDENCE.toFixed(2)}`;
  } else if (step === 'triage') {
    lines = ['Needs', 'triage.'];
    tone = s.warn;
    sub = `Best ${best.toFixed(2)} < ${ROUTING_CONFIDENCE.toFixed(2)} — a person decides`;
  }
  // The outcome title arrives in a beat that is already on screen, so its caption can follow sooner.
  const subAt = step === 'decision' || rule ? AT.sub : 1600;

  return (
    <>
      <div className={s.copy}>
        <Eyebrow n={2}>Routing — the right team</Eyebrow>
        <Title lines={lines} tone={tone} />
        <Sub delay={subAt}>{sub}</Sub>
      </div>
      <div className={`${s.visual} ${s.routeVisual}`}>
        <div className={`${s.orbWrap} ${s.power}`} style={at(AT.orb)}>
          <CoreOrb id="rx-core" dim={Boolean(rule)} />
          {!rule && <span className={s.incoming} style={at(AT.incoming)} />}
        </div>
        <div className={s.rows}>
          {GROUPS.map((group, i) => {
            const c = confidence(group);
            const value = c === undefined ? 0 : c * reveal;
            return (
              <div key={group} className={`${s.row} ${s.panel}`} style={at(panelAt(i))} data-group={group} data-chosen={chosen === group}>
                <Decode text={group} delay={panelAt(i) + 150} className={s.mono} />
                <span className={`${s.mono} ${s.rowValue}`}>
                  {c !== undefined ? value.toFixed(2) : rule?.group === group ? 'rule' : '—'}
                </span>
                <span className={s.bar}>
                  <span className={s.barFill} style={{ transform: `scaleX(${rule?.group === group ? 1 : value})` }} />
                  <span className={s.barTick} />
                </span>
              </div>
            );
          })}
          <div className={`${s.row} ${s.rowTriage} ${s.panel}`} style={at(panelAt(4))} data-stage="triage" data-chosen={step === 'triage'}>
            <Decode text="Needs Triage" delay={panelAt(4) + 150} className={s.mono} />
            <span className={`${s.mono} ${s.rowValue}`}>&lt; {ROUTING_CONFIDENCE.toFixed(2)}</span>
          </div>
        </div>
      </div>
    </>
  );
}

/** 03: the factors fill the ring by weight, then the score counts up. */
function ComplexityScene({ sc, step, count }: { sc: Scenario; step: Step; count: number }) {
  const factors = sc.factors!;
  const fill = step === 'factors' ? ease(count) : 1;
  const score = step === 'score' ? (sc.expected.score ?? 0) * ease(count) : 0;
  const values = Object.fromEntries((Object.keys(WEIGHTS) as Factor[]).map((f) => [f, factors[f] * fill])) as Record<Factor, number>;

  return (
    <>
      <div className={s.copy}>
        <Eyebrow n={3}>Complexity — weighted score</Eyebrow>
        <Title lines={['How hard', 'is it?']} />
        <dl className={s.legend}>
          {(Object.keys(WEIGHTS) as Factor[]).map((f, i) => (
            <div key={f} className={`${s.legendRow} ${s.panel}`} style={at(panelAt(i, 1000))}>
              <dt className={s.mono}>
                <Decode text={FACTOR_LABELS[f]} delay={panelAt(i, 1000) + 150} /> <span className={s.weight}>×{WEIGHTS[f]}</span>
              </dt>
              <dd className={`${s.mono} ${s.rowValue}`}>{values[f].toFixed(2)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className={s.visual}>
        <div className={`${s.orbWrap} ${s.power}`} style={at(AT.orb)}>
          <ComplexityRing id="rx-ring" values={values} score={score} scoreText={score.toFixed(2)} />
        </div>
      </div>
    </>
  );
}

/** 04: the level word lands, then the chosen level lights up. */
function ModelScene({ sc }: { sc: Scenario }) {
  const level = sc.expected.level!;
  return (
    <>
      <div className={s.copy}>
        <Eyebrow n={4}>Model level — who replies</Eyebrow>
        <Title lines={[`${level}.`]} tone={LEVEL_TONE[level]} xl />
        <Sub delay={AT.lit}>{`Score ${sc.expected.score!.toFixed(2)} → the ${level} model writes the reply`}</Sub>
      </div>
      <div className={`${s.visual} ${s.levels}`}>
        {LEVELS.map((l, i) => (
          <div
            key={l}
            className={`${s.capsule} ${LEVEL_TONE[l]} ${s.panel}`}
            style={at(panelAt(i, 1100), { ['--lit' as string]: `${AT.lit}ms` })}
            data-level={l}
            data-chosen={l === level}
          >
            <span className={s.capsuleDot} />
            <span className={s.capsuleName}>{l}</span>
            <Decode text={LEVEL_RANGE[l]} delay={panelAt(i, 1100) + 300} className={`${s.mono} ${s.capsuleRange}`} />
          </div>
        ))}
      </div>
    </>
  );
}

function Cell({ i, label, note, children, data }: { i: number; label: string; note: string; children: ReactNode; data?: Record<string, string> }) {
  return (
    <div className={`${s.cell} ${s.panel}`} style={at(panelAt(i))} {...data}>
      <Decode text={label} delay={panelAt(i) + 150} className={s.mono} />
      {children}
      <Decode text={note} delay={panelAt(i) + 450} className={`${s.mono} ${s.cellNote}`} />
    </div>
  );
}

/** 05: the recap. */
function EndScene({ sc }: { sc: Scenario }) {
  const triage = sc.expected.group === 'Needs Triage';
  const confidence = sc.routing?.candidates.find((c) => c.group === sc.expected.group)?.confidence;
  const level = sc.expected.level;
  return (
    <>
      <div className={s.copy}>
        <Eyebrow n={5}>Routed and answered</Eyebrow>
        <Title lines={triage ? ['Sorted', 'by a person.'] : ['Routed.', 'Answered.']} tone={triage ? s.warn : undefined} />
        <Sub>{triage ? 'Low confidence never guesses' : 'Cheaper models answer most tickets'}</Sub>
      </div>
      <div className={`${s.visual} ${s.recap}`}>
        <Cell i={0} label="Rules" note={sc.ruleMatch ? sc.ruleMatch.rule : 'AI decides'}>
          <span className={s.cellValue}>{sc.ruleMatch ? 'Matched' : 'No match'}</span>
        </Cell>
        {triage ? (
          <Cell i={1} label="Team" note={`Best ${(sc.routing?.candidates[0]?.confidence ?? 0).toFixed(2)}`} data={{ 'data-stage': 'triage', 'data-chosen': 'true' }}>
            <span className={`${s.cellValue} ${s.warn}`}>Needs Triage</span>
          </Cell>
        ) : (
          <Cell
            i={1}
            label="Team"
            note={confidence !== undefined ? `Confidence ${confidence.toFixed(2)}` : 'By rule'}
            data={{ 'data-group': sc.expected.group, 'data-chosen': 'true' }}
          >
            <span className={s.cellValue}>{sc.expected.group}</span>
          </Cell>
        )}
        <Cell i={2} label="Complexity" note="Weighted score">
          <span className={s.cellValue} data-part="score">
            {sc.expected.score !== undefined ? sc.expected.score.toFixed(2) : '—'}
          </span>
        </Cell>
        {level ? (
          <Cell i={3} label="Model" note={LEVEL_RANGE[level]} data={{ 'data-level': level, 'data-chosen': 'true' }}>
            <span className={`${s.cellValue} ${LEVEL_TONE[level]}`}>{level}</span>
          </Cell>
        ) : (
          <Cell i={3} label="Model" note="Picks it up">
            <span className={s.cellValue}>A person</span>
          </Cell>
        )}
      </div>
    </>
  );
}

const WIPE_COLS = 12;
const WIPE_ROWS = 7;

export interface FlowReelProps {
  scenario: Scenario;
  step: Step;
  /** Progress (0–1) of the current step's count-up. */
  count?: number;
  playing?: boolean;
  /** Playback speed (the e2e tests run the reel faster). */
  speed?: number;
  /** An empty stage, shown while the wipe uncovers the next ticket, so its story starts in view. */
  blank?: boolean;
  /** Hands the player each text-effect timer, so it pauses with the reel. */
  adopt?: (animation: Animation) => void;
}

const ignore = () => {};

export function FlowReel({ scenario, step, count = 1, playing = false, speed = 1, blank = false, adopt = ignore }: FlowReelProps) {
  const scene = sceneOf(step);
  const steps = stepsFor(scenario);
  const atStep = step === 'complete' ? steps.length : steps.indexOf(step);
  const done = (stage: StageId) => {
    const i = steps.indexOf(stage);
    return i !== -1 && i < atStep;
  };
  const index = SCENARIOS.indexOf(scenario);

  return (
    <ReelMotion.Provider value={{ playing, speed, adopt }}>
      <div
        className={s.frame}
        data-reel
        data-scene={blank ? 'blank' : scene}
        data-playing={playing ? 'true' : undefined}
        style={{ ['--s' as string]: speed }}
      >
        <div className={s.bgGrid} aria-hidden="true" />
        <div className={s.bgGlow} aria-hidden="true" />
        {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
          <span key={c} className={`${s.corner} ${s[c]}`} aria-hidden="true" />
        ))}

        <div className={`${s.hud} ${s.mono}`} aria-hidden="true">
          <span className={s.brand}>
            <span className={s.rec} /> ReplyX / AI routing
          </span>
          <span className={s.hudMid}>
            Ticket {pad(index + 1)} / {pad(SCENARIOS.length)}
          </span>
          <span className={s.counter}>
            <strong>{blank ? '00' : pad(SCENES.indexOf(scene) + 1)}</strong> — {pad(SCENES.length)}
          </span>
        </div>

        <div className={s.stage} key={blank ? 'blank' : `${scenario.id}-${scene}`} data-step={step} aria-hidden="true">
          {!blank && scene === 'ticket' && <TicketScene sc={scenario} step={step} />}
          {!blank && scene === 'route' && <RouteScene sc={scenario} step={step} count={count} />}
          {!blank && scene === 'complexity' && <ComplexityScene sc={scenario} step={step} count={count} />}
          {!blank && scene === 'model' && <ModelScene sc={scenario} />}
          {!blank && scene === 'end' && <EndScene sc={scenario} />}
        </div>

        {/* Chapter bar: real links to the page that explains each stage (FR-007). */}
        <nav className={s.nav} aria-label="Stages of the flow">
          {STAGES.map((stage, i) => (
            <a
              key={stage.id}
              href={stage.href}
              className={`${s.mono} ${s.chapter}`}
              data-caption={stage.id}
              data-active={!blank && step === stage.id}
              data-done={!blank && done(stage.id)}
              data-ai={stage.ai}
            >
              <span className={s.chapterNum}>{pad(i + 1)}</span>
              <span>{stage.caption}</span>
            </a>
          ))}
        </nav>

        <div className={s.wipe} aria-hidden="true">
          {Array.from({ length: WIPE_COLS * WIPE_ROWS }, (_, i) => {
            const col = i % WIPE_COLS;
            const row = Math.floor(i / WIPE_COLS);
            const tone = (i * 7) % 11 === 0 ? s.tileAi : '';
            return <span key={i} className={`${s.tile} ${tone}`} data-tile={col + row} />;
          })}
        </div>
      </div>
    </ReelMotion.Provider>
  );
}
