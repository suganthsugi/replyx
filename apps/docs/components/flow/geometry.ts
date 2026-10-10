import type { StageId } from './scenarios';

/**
 * Coordinates of the flow artwork, one table per layout (horizontal from 768 px, vertical below).
 * Both layouts draw the same parts with the same ids, so the player and the captions work on either.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Layout = 'horizontal' | 'vertical';

export type PathId =
  | 'intake-rules'
  | 'rules-decision'
  | `rules-group-${number}`
  | `decision-group-${number}`
  | 'decision-triage'
  | `group-${number}-factors`
  | 'factors-score'
  | `score-level-${number}`;

export interface Geometry {
  width: number;
  height: number;
  message: Box;
  intake: Box;
  rules: Box;
  ruleBadge: Box;
  decision: Box;
  groups: Box[];
  triage: Box;
  factors: Box;
  dial: { cx: number; cy: number; r: number };
  levels: Box[];
  paths: Record<PathId, string>;
  /** Caption anchor (top centre of the caption), in viewBox units. */
  captions: Record<StageId, { x: number; y: number }>;
  /** Characters per line when wrapping the customer's message. */
  messageChars: number;
}

const midY = (b: Box) => b.y + b.h / 2;
const midX = (b: Box) => b.x + b.w / 2;

function horizontal(): Geometry {
  const intake = { x: 40, y: 160, w: 150, h: 80 };
  const rules = { x: 246, y: 164, w: 128, h: 72 };
  const decision = { x: 432, y: 124, w: 196, h: 152 };
  const groups = [100, 144, 188, 232].map((y) => ({ x: 684, y, w: 196, h: 34 }));
  const triage = { x: 700, y: 300, w: 166, h: 40 };
  const factors = { x: 914, y: 96, w: 152, h: 210 };
  const dial = { cx: 1130, cy: 186, r: 50 };
  const levels = [246, 284, 322].map((y) => ({ x: 1080, y, w: 104, h: 30 }));

  const paths = {
    'intake-rules': `M${intake.x + intake.w} 200 L${rules.x} 200`,
    'rules-decision': `M${rules.x + rules.w} 200 L${decision.x} 200`,
    'decision-triage': `M${decision.x + decision.w} 236 C664 246, 660 ${midY(triage)}, ${triage.x} ${midY(triage)}`,
    'factors-score': `M${factors.x + factors.w} 200 C1074 200, 1072 ${dial.cy}, ${dial.cx - dial.r} ${dial.cy}`,
  } as Record<PathId, string>;
  groups.forEach((g, i) => {
    const cy = midY(g);
    paths[`rules-group-${i}`] = `M${midX(rules)} ${rules.y} C${midX(rules)} 70, 640 54, ${g.x + 30} ${g.y}`;
    paths[`decision-group-${i}`] = `M${decision.x + decision.w} 200 C660 200, 662 ${cy}, ${g.x} ${cy}`;
    paths[`group-${i}-factors`] = `M${g.x + g.w} ${cy} C898 ${cy}, 898 200, ${factors.x} 200`;
  });
  levels.forEach((l, i) => {
    paths[`score-level-${i}`] = `M${dial.cx - 22} ${dial.cy + 44} C1058 ${dial.cy + 56}, 1058 ${midY(l)}, ${l.x} ${midY(l)}`;
  });

  return {
    width: 1200,
    height: 390,
    message: { x: 24, y: 30, w: 236, h: 92 },
    intake,
    rules,
    ruleBadge: { x: 232, y: 250, w: 156, h: 28 },
    decision,
    groups,
    triage,
    factors,
    dial,
    levels,
    paths,
    captions: {
      intake: { x: midX(intake), y: intake.y + intake.h + 10 },
      rules: { x: midX(rules), y: 290 },
      decision: { x: midX(decision), y: decision.y + decision.h + 10 },
      groups: { x: midX(groups[0]!), y: 64 },
      triage: { x: midX(triage), y: triage.y + triage.h + 8 },
      factors: { x: midX(factors), y: factors.y + factors.h + 10 },
      score: { x: dial.cx, y: 82 },
      levels: { x: 1120, y: levels[2]!.y + levels[2]!.h + 8 },
    },
    messageChars: 30,
  };
}

function vertical(): Geometry {
  const intake = { x: 115, y: 124, w: 150, h: 64 };
  const rules = { x: 125, y: 244, w: 130, h: 60 };
  const decision = { x: 80, y: 356, w: 220, h: 156 };
  const groups = [586, 624, 662, 700].map((y) => ({ x: 95, y, w: 190, h: 30 }));
  const triage = { x: 110, y: 768, w: 160, h: 38 };
  const factors = { x: 50, y: 866, w: 280, h: 196 };
  const dial = { cx: 190, cy: 1222, r: 56 };
  const levels = [18, 138, 258].map((x) => ({ x, y: 1308, w: 104, h: 30 }));

  const paths = {
    'intake-rules': `M190 ${intake.y + intake.h} L190 ${rules.y}`,
    'rules-decision': `M190 ${rules.y + rules.h} L190 ${decision.y}`,
    'decision-triage': `M${decision.x + 14} ${decision.y + decision.h} C20 540, 24 ${midY(triage)}, ${triage.x} ${midY(triage)}`,
    'factors-score': `M190 ${factors.y + factors.h} L190 ${dial.cy - dial.r - 30}`,
  } as Record<PathId, string>;
  groups.forEach((g, i) => {
    const cy = midY(g);
    paths[`rules-group-${i}`] = `M${rules.x + rules.w} ${midY(rules)} C362 300, 364 ${cy}, ${g.x + g.w} ${cy}`;
    paths[`decision-group-${i}`] = `M${decision.x + 30} ${decision.y + decision.h} C48 ${decision.y + decision.h + 30}, 50 ${cy}, ${g.x} ${cy}`;
    paths[`group-${i}-factors`] = `M${g.x + g.w} ${cy} C352 ${cy}, 352 ${factors.y - 20}, 300 ${factors.y}`;
  });
  levels.forEach((l, i) => {
    paths[`score-level-${i}`] = `M190 ${dial.cy + 40} C190 ${dial.cy + 64}, ${midX(l)} ${l.y - 26}, ${midX(l)} ${l.y}`;
  });

  return {
    width: 380,
    height: 1376,
    message: { x: 30, y: 16, w: 320, h: 80 },
    intake,
    rules,
    ruleBadge: { x: 262, y: 216, w: 112, h: 28 },
    decision,
    groups,
    triage,
    factors,
    dial,
    levels,
    paths,
    captions: {
      intake: { x: 190, y: intake.y + intake.h + 8 },
      rules: { x: 190, y: rules.y + rules.h + 8 },
      decision: { x: 190, y: decision.y + decision.h + 8 },
      groups: { x: 190, y: groups[0]!.y - 26 },
      triage: { x: 190, y: triage.y + triage.h + 8 },
      factors: { x: 190, y: factors.y + factors.h + 8 },
      score: { x: 190, y: dial.cy - dial.r - 54 },
      levels: { x: 190, y: levels[0]!.y + levels[0]!.h + 8 },
    },
    messageChars: 44,
  };
}

export const GEOMETRY: Record<Layout, Geometry> = { horizontal: horizontal(), vertical: vertical() };

/** A point on the score dial (a half circle from 0 at the left to 1 at the right). */
export function dialPoint(cx: number, cy: number, r: number, value: number) {
  const angle = Math.PI * (1 - value);
  return { x: cx + r * Math.cos(angle), y: cy - r * Math.sin(angle) };
}

/** The dial arc between two values. */
export function dialArc(cx: number, cy: number, r: number, from: number, to: number) {
  const a = dialPoint(cx, cy, r, from);
  const b = dialPoint(cx, cy, r, to);
  return `M${a.x.toFixed(2)} ${a.y.toFixed(2)} A${r} ${r} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

/** Wraps the message into lines of at most `chars` characters, breaking at spaces. */
export function wrap(text: string, chars: number, maxLines = 3): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > chars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.slice(0, chars - 1)}…`;
    return kept;
  }
  return lines;
}
