import type { ReactNode } from 'react';
import { Icon, NeonDefs, type IconName } from '../flow/primitives';
import s from './illustrations.module.css';

/**
 * Pieces shared by the concept page illustrations. Each illustration is one still SVG with
 * `role="img"`, a `<title>` and a `<desc>`, so a screen reader gets the whole idea in one go.
 */

export function Diagram({
  id,
  width,
  height,
  title,
  desc,
  children,
}: {
  id: string;
  width: number;
  height: number;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <figure className={s.figure} data-illustration={id}>
      <svg className={s.svg} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title ${id}-desc`}>
        <title id={`${id}-title`}>{title}</title>
        <desc id={`${id}-desc`}>{desc}</desc>
        <NeonDefs id={id} />
        {children}
      </svg>
    </figure>
  );
}

/** A labelled box: an icon, a name and a mono caption under it. */
export function Box({
  x,
  y,
  w,
  h = 64,
  icon,
  name,
  caption,
  tone,
  neon,
}: {
  x: number;
  y: number;
  w: number;
  h?: number;
  icon?: IconName;
  name: string;
  caption?: string;
  tone?: 'ai' | 'warn';
  /** id of the diagram, to glow the box with its neon filter (AI parts only). */
  neon?: string;
}) {
  const boxClass = tone === 'ai' ? s.boxAi : tone === 'warn' ? s.boxWarn : s.box;
  const iconClass = tone === 'ai' ? s.iconAi : tone === 'warn' ? s.iconWarn : s.icon;
  const textX = icon ? x + 50 : x + 18;
  return (
    <g>
      <rect className={boxClass} x={x} y={y} width={w} height={h} rx={12} filter={neon ? `url(#${neon}-neon)` : undefined} />
      {icon && (
        <g className={iconClass}>
          <Icon name={icon} x={x + 16} y={y + h / 2 - 11} size={22} />
        </g>
      )}
      <text className={`${s.name} ${tone === 'warn' ? s.warn : ''}`} x={textX} y={caption ? y + h / 2 - 3 : y + h / 2 + 6}>
        {name}
      </text>
      {caption && (
        <text className={s.label} x={textX} y={y + h / 2 + 17}>
          {caption}
        </text>
      )}
    </g>
  );
}

/** A straight arrow from (x1, y1) to (x2, y2), horizontal or vertical. */
export function Arrow({ x1, y1, x2, y2, ai }: { x1: number; y1: number; x2: number; y2: number; ai?: boolean }) {
  const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  return (
    <g>
      <line className={ai ? s.flowAi : s.flow} x1={x1} y1={y1} x2={x2} y2={y2} />
      <path className={ai ? s.headAi : s.head} d="M0 0 L-9 -5 L-9 5 Z" transform={`translate(${x2} ${y2}) rotate(${angle})`} />
    </g>
  );
}
