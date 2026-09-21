import type { NoulAnswer, NoulCardConfig } from "@/lib/types";
import { CardShell, pct } from "./CardShell";

export function NoulCard({ card, answer }: { card: NoulCardConfig; answer: NoulAnswer }) {
  const p = Math.max(0, Math.min(1, answer.probability));
  const isYes = p >= 0.5;
  const confidence = isYes ? p : 1 - p;

  return (
    <CardShell title={card.title} subtitle={card.subtitle} type="noul">
      <div className="flex items-baseline justify-between">
        <span
          className={`text-2xl font-semibold ${
            isYes ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500 dark:text-zinc-400"
          }`}
        >
          {isYes ? "Yes" : "No"}
        </span>
        <span className="text-sm tabular-nums text-zinc-500 dark:text-zinc-400">
          {pct(confidence)} confident
        </span>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div
          className={`h-full rounded-full ${isYes ? "bg-emerald-500" : "bg-zinc-400 dark:bg-zinc-600"}`}
          style={{ width: pct(p) }}
        />
      </div>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        P(yes) = {p.toFixed(2)}
      </p>
    </CardShell>
  );
}
