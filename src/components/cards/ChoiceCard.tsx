import { optionLabel } from "@/lib/cards";
import type { ChoiceAnswer, ChoiceCardConfig } from "@/lib/types";
import { CardShell, pct } from "./CardShell";

export function ChoiceCard({ card, answer }: { card: ChoiceCardConfig; answer: ChoiceAnswer }) {
  const keys = Object.keys(card.criteria);
  const rows = keys
    .map((key) => ({ key, label: optionLabel(card, key), value: answer.probabilities[key] ?? 0 }))
    .sort((a, b) => b.value - a.value);

  return (
    <CardShell title={card.title} subtitle={card.subtitle} type="choice">
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          {optionLabel(card, answer.choice)}
        </span>
        <span className="text-sm tabular-nums text-zinc-500 dark:text-zinc-400">
          {pct(answer.probabilities[answer.choice] ?? 0)}
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const top = row.key === answer.choice;
          return (
            <li key={row.key} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className={top ? "font-medium text-zinc-900 dark:text-zinc-100" : "text-zinc-500 dark:text-zinc-400"}>
                  {row.label}
                </span>
                <span className="tabular-nums text-zinc-400 dark:text-zinc-500">{pct(row.value)}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div
                  className={`h-full rounded-full ${top ? "bg-indigo-500" : "bg-zinc-300 dark:bg-zinc-700"}`}
                  style={{ width: pct(row.value) }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
}
