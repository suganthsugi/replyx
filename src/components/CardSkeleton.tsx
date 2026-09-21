export function CardSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-4 rounded-2xl border border-black/[.06] bg-white p-5 dark:border-white/[.08] dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <div className="h-4 w-28 rounded bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-4 w-12 rounded-full bg-zinc-200 dark:bg-zinc-800" />
      </div>
      <div className="h-7 w-24 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-2 w-full rounded-full bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-2 w-4/5 rounded-full bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}
