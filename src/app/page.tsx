"use client";

import { useState } from "react";

import { CardRenderer } from "@/components/cards/CardRenderer";
import { CardSkeleton } from "@/components/CardSkeleton";
import { cards } from "@/lib/cards";
import type { ClassifyResponse } from "@/lib/types";

const SAMPLES = [
  "I've asked twice already and still haven't gotten my refund — this is ridiculous.",
  "Hi! Loving the product. Could you tell me more about the Pro plan pricing?",
  "The export button throws a 500 error every time I click it. Can you help?",
];

export default function Home() {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ClassifyResponse | null>(null);
  const [totalCost, setTotalCost] = useState(0);

  async function classify(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Request failed.");
      const payload = data as ClassifyResponse;
      setResult(payload);
      setTotalCost((c) => c + (payload.cost || 0));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    classify(message);
  }

  return (
    <div className="min-h-dvh bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-10 sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">Ticket Classifier</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Paste a customer message. Jev routes it, reads the mood, and flags refunds and follow-ups.
            </p>
          </div>
          <div
            className="flex flex-col items-end rounded-xl border border-black/[.08] bg-white px-3 py-2 dark:border-white/[.12] dark:bg-zinc-900"
            title="Total OpenRouter spend this session"
          >
            <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              Spent this session
            </span>
            <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
              ${totalCost.toFixed(6)}
            </span>
            {result && !result.mock && result.cost > 0 ? (
              <span className="text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
                last: ${result.cost.toFixed(6)}
              </span>
            ) : null}
          </div>
        </header>

        {/* Message composer (top, messaging-app style) */}
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex items-end gap-2 rounded-2xl border border-black/[.1] bg-white p-2 shadow-sm focus-within:border-indigo-400 dark:border-white/[.14] dark:bg-zinc-900">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              placeholder="Type a customer message, then click Send…"
              className="max-h-40 flex-1 resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-zinc-400"
            />
            <button
              type="submit"
              disabled={loading || !message.trim()}
              className="mb-1 mr-1 shrink-0 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? "Analyzing…" : "Send"}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {SAMPLES.map((s) => (
              <button
                key={s}
                type="button"
                title={s}
                onClick={() => setMessage(s)}
                className="max-w-full truncate rounded-full border border-black/[.08] bg-white px-3 py-1 text-xs text-zinc-600 transition-colors hover:border-indigo-300 hover:bg-indigo-50 hover:text-zinc-900 dark:border-white/[.12] dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-indigo-950/40 dark:hover:text-zinc-100"
              >
                {s.length > 46 ? s.slice(0, 46) + "…" : s}
              </button>
            ))}
          </div>
        </form>

        {error ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        ) : null}

        {/* Analyzed message echo */}
        {result && !loading ? (
          <div className="flex items-start gap-3">
            <span className="rounded-lg bg-indigo-100 px-2 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
              Analyzed
            </span>
            <p className="flex-1 text-sm text-zinc-700 dark:text-zinc-300">
              &ldquo;{result.message}&rdquo;
              {result.mock ? (
                <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  mock
                </span>
              ) : null}
            </p>
          </div>
        ) : null}

        {/* Results grid (bottom) */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {loading
            ? cards.map((c) => <CardSkeleton key={c.key} />)
            : result
              ? cards.map((card) => (
                  <CardRenderer key={card.key} card={card} answer={result.answers[card.key]} />
                ))
              : cards.map((card) => (
                  <div
                    key={card.key}
                    className="flex min-h-[132px] flex-col justify-between rounded-2xl border border-dashed border-black/[.1] bg-white/50 p-5 text-zinc-400 dark:border-white/[.12] dark:bg-zinc-900/40 dark:text-zinc-600"
                  >
                    <h3 className="text-sm font-medium">{card.title}</h3>
                    <p className="text-xs">{card.subtitle}</p>
                  </div>
                ))}
        </section>
      </div>
    </div>
  );
}
