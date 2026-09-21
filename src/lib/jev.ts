// Server-only helpers for OpenRouter's Decisions API ("Jev" / System One).
// This module reads OPENROUTER_API_KEY and must never be imported by client code.

import "server-only";

import type { AnswerMap, CardConfig, JevQuestion } from "@/lib/types";

const DECISIONS_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

/** Build the `questions` payload for the Decisions API from card configs. */
export function cardsToQuestions(cards: CardConfig[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  for (const card of cards) {
    questions[card.key] = {
      type: card.type,
      instructions: card.instructions,
      criteria: card.criteria,
    };
  }
  return questions;
}

/** Call the Decisions API. Throws on missing key or non-2xx responses. */
export async function callJev(
  state: string,
  questions: Record<string, JevQuestion>,
): Promise<unknown> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Add it to .env.local and restart the dev server.",
    );
  }
  const model = process.env.JEV_MODEL || "~typesafe/jev-latest";

  const res = await fetch(DECISIONS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, state, questions }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Jev request failed (${res.status} ${res.statusText})${detail ? `: ${detail}` : ""}`,
    );
  }
  return res.json();
}

// --- Normalization ------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Normalize the raw Decisions API response into an AnswerMap keyed by card.
 * Defensive about the exact envelope: accepts `{ answers: {...} }` or a flat map.
 */
export function normalizeAnswers(raw: unknown, cards: CardConfig[]): AnswerMap {
  const root = asRecord(raw);
  const answers = asRecord("answers" in root ? root.answers : root);
  const out: AnswerMap = {};

  for (const card of cards) {
    const a = asRecord(answers[card.key]);

    if (card.type === "noul") {
      const probability =
        "noul" in a
          ? toNumber(a.noul)
          : "probability" in a
            ? toNumber(a.probability)
            : toNumber(a.true);
      out[card.key] = { type: "noul", probability };
    } else if (card.type === "choice") {
      const probabilities: Record<string, number> = {};
      for (const [k, v] of Object.entries(asRecord(a.probabilities))) {
        probabilities[k] = toNumber(v);
      }
      const keys = Object.keys(card.criteria);
      const choice =
        typeof a.choice === "string" && a.choice
          ? a.choice
          : (Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0]?.[0] ?? keys[0]);
      out[card.key] = { type: "choice", choice, probabilities };
    } else {
      const rubric = card.criteria;
      let index = 0;
      if (typeof a.score === "number") {
        index = Math.round(a.score);
      } else if (typeof a.score === "string") {
        const found = rubric.indexOf(a.score);
        index = found >= 0 ? found : 0;
      }
      index = Math.max(0, Math.min(rubric.length - 1, index));
      // The API returns probabilities as an object keyed by rubric index
      // (e.g. {"0":0,"2":0.36,"3":0.64}); older/mock paths may use an array.
      let distribution: number[] | undefined;
      if (Array.isArray(a.probabilities)) {
        distribution = a.probabilities.map((v) => toNumber(v));
      } else if (a.probabilities && typeof a.probabilities === "object") {
        const obj = a.probabilities as Record<string, unknown>;
        distribution = rubric.map((_, i) => toNumber(obj[String(i)]));
      }
      out[card.key] = { type: "score", index, label: rubric[index], distribution };
    }
  }

  return out;
}
