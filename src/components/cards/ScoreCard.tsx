import type { ScoreAnswer, ScoreCardConfig } from "@/lib/types";
import { CardShell } from "./CardShell";

export function ScoreCard({ card, answer }: { card: ScoreCardConfig; answer: ScoreAnswer }) {
  const rubric = card.criteria;
  const n = rubric.length;
  // Position the marker at the center of the active segment.
  const markerLeft = n > 1 ? (answer.index / (n - 1)) * 100 : 50;

  return (
    <CardShell title={card.title} subtitle={card.subtitle} type="score">
      <span className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{answer.label}</span>

      <div className="mt-1">
        <div className="relative h-2 w-full rounded-full bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-500">
          <div
            className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-zinc-900 shadow dark:border-zinc-900 dark:bg-white"
            style={{ left: `${markerLeft}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between">
          {rubric.map((label, i) => (
            <span
              key={label}
              className={`text-[10px] ${
                i === answer.index
                  ? "font-semibold text-zinc-900 dark:text-zinc-100"
                  : "text-zinc-400 dark:text-zinc-500"
              }`}
            >
              {label}
            </span>
          ))}
        </div>
      </div>
    </CardShell>
  );
}
