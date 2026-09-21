import type { ReactNode } from "react";

const TYPE_LABEL: Record<string, string> = {
  noul: "Yes / No",
  choice: "Choice",
  score: "Score",
};

export function CardShell({
  title,
  subtitle,
  type,
  children,
}: {
  title: string;
  subtitle?: string;
  type: "noul" | "choice" | "score";
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-black/[.08] bg-white p-5 shadow-sm dark:border-white/[.12] dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{title}</h3>
          {subtitle ? (
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>
          ) : null}
        </div>
        <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {TYPE_LABEL[type]}
        </span>
      </div>
      {children}
    </div>
  );
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
