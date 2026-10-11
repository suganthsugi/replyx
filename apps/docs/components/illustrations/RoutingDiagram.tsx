import { ROUTING_CONFIDENCE } from '../flow/complexity';
import { CoreOrb, Icon } from '../flow/primitives';
import { STATIC_SCENARIO } from '../flow/scenarios';

import s from './illustrations.module.css';
import { Arrow, Box, Diagram } from './parts';

/**
 * How AI routing works, as a still: rules first, then the decision model reading the active groups'
 * AI descriptions, then its confidence against the threshold. The example is scenario 3 of
 * contracts/flow-scenarios.md, the same ticket the home reel shows when it is still.
 */

const ID = 'routing-diagram';
const top = STATIC_SCENARIO.routing!.candidates[0]!;
const threshold = ROUTING_CONFIDENCE.toFixed(2);

export function RoutingDiagram() {
  const barX = 30;
  const barW = 300;
  const tickX = barX + barW * ROUTING_CONFIDENCE;
  return (
    <Diagram
      id={ID}
      width={560}
      height={676}
      title="How a new ticket is routed"
      desc={
        `A new ticket is checked against the routing rules first. If a rule matches, the ticket goes to that rule's ` +
        `group and the decision model is skipped. If no rule matches, the decision model reads the AI descriptions ` +
        `of the active groups and picks the most likely group. With a confidence of ${threshold} or more, the ticket ` +
        `goes to that group, as here: ${top.group} at ${top.confidence.toFixed(2)}. Below ${threshold}, it waits in ` +
        `Needs Triage. A manual triage choice always wins.`
      }
    >
      <Box x={30} y={16} w={300} icon="chat" name="New ticket" caption="CUSTOMER MESSAGE" />
      <Arrow x1={180} y1={80} x2={180} y2={110} />

      <Box x={30} y={112} w={300} icon="rules" name="Routing rules" caption="CHECKED FIRST" />
      <text className={s.label} x={338} y={136}>
        MATCH
      </text>
      <Arrow x1={330} y1={144} x2={382} y2={144} />
      <Box x={384} y={112} w={160} name="Rule's group" caption="MODEL SKIPPED" />

      <Arrow x1={180} y1={176} x2={180} y2={222} ai />
      <text className={s.label} x={192} y={204}>
        NO MATCH
      </text>

      {/* The decision model reads each active group's AI description. */}
      <text className={s.label} x={384} y={224}>
        ACTIVE GROUPS
      </text>
      <text className={s.label} x={384} y={240}>
        WITH AI DESCRIPTIONS
      </text>
      {['Orders & Shipping', 'Technical Support', 'Billing'].map((group, i) => {
        const y = 254 + i * 44;
        return (
          <g key={group}>
            <path className={s.reads} d={`M384 ${y + 17} C330 ${y + 17} 300 300 262 300`} />
            <rect className={s.box} x={384} y={y} width={160} height={34} rx={17} />
            <text className={s.chip} x={400} y={y + 22}>
              {group}
            </text>
          </g>
        );
      })}
      <CoreOrb id={`${ID}-orb`} place={{ x: 90, y: 210, size: 180 }} />
      <text className={`${s.name} ${s.accent}`} x={180} y={406} textAnchor="middle">
        Decision model
      </text>
      <text className={s.label} x={180} y={424} textAnchor="middle">
        PICKS THE LIKELIEST GROUP
      </text>

      {/* Confidence against the threshold. */}
      <text className={s.label} x={barX} y={452}>
        CONFIDENCE · {top.group.toUpperCase()}
      </text>
      <text className={s.value} x={barX + barW} y={452} textAnchor="end">
        {top.confidence.toFixed(2)}
      </text>
      <rect className={s.track} x={barX} y={462} width={barW} height={8} rx={4} />
      <rect className={s.fill} x={barX} y={462} width={barW * top.confidence} height={8} rx={4} filter={`url(#${ID}-neon)`} />
      <line className={s.tick} x1={tickX} y1={455} x2={tickX} y2={477} />
      <text className={s.value} x={tickX} y={494} textAnchor="middle">
        {threshold}
      </text>

      <Arrow x1={180} y1={478} x2={180} y2={526} ai />
      <Box x={30} y={528} w={300} icon="team" name={top.group} caption={`${threshold} OR MORE · ASSIGNED`} tone="ai" neon={ID} />

      <path className={s.flow} d="M340 466 H464 V520" />
      <path className={s.head} d="M0 0 L-9 -5 L-9 5 Z" transform="translate(464 526) rotate(90)" />
      <text className={`${s.label} ${s.warn}`} x={372} y={456}>
        BELOW {threshold}
      </text>
      <Box x={384} y={528} w={160} name="Needs Triage" caption="A PERSON PICKS" tone="warn" />

      <rect className={s.boxNote} x={30} y={616} width={514} height={44} rx={22} />
      <g className={s.iconAi}>
        <Icon name="check" x={48} y={627} size={22} />
      </g>
      <text className={s.name} x={82} y={644}>
        A manual triage choice always wins.
      </text>
    </Diagram>
  );
}
