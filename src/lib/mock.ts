// Deterministic mock answers for UI development without spending real money.
// Uses simple keyword heuristics + a stable hash so the same message always
// produces the same (plausible) result. Never used when JEV_MOCK is off.

import type { AnswerMap, CardConfig } from "@/lib/types";

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295; // 0..1
}

function has(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

/** Build a plausible, deterministic AnswerMap for a message. */
export function mockAnswers(message: string, cards: CardConfig[]): AnswerMap {
  const text = message.toLowerCase();
  const out: AnswerMap = {};

  for (const card of cards) {
    const seed = hash(card.key + "::" + message);

    if (card.type === "noul") {
      // Bias toward "refund" wording for the refund card, else use the seed.
      const refundish = has(text, ["refund", "money back", "chargeback", "reimburse", "cancel"]);
      const probability = refundish ? 0.8 + seed * 0.19 : Math.min(0.45, seed * 0.6);
      out[card.key] = { type: "noul", probability };
    } else if (card.type === "choice") {
      const keys = Object.keys(card.criteria);
      // Weight keys by naive keyword hits so the mock feels responsive.
      const weights = keys.map((k) => {
        let w = 0.2 + hash(k + message) * 0.6;
        if (k === "sales" && has(text, ["price", "pricing", "plan", "upgrade", "quote", "buy"])) w += 1.2;
        if (k === "service" && has(text, ["bug", "error", "broken", "not working", "help", "issue", "down"])) w += 1.2;
        if (k === "customer_success" && has(text, ["onboard", "renew", "cancel", "churn", "adopt"])) w += 1.0;
        if (k === "follow_up" && has(text, ["again", "already", "still", "previous", "last time", "twice", "ticket #"])) w += 1.3;
        if (k === "new" && !has(text, ["again", "already", "still", "previous", "last time", "twice"])) w += 0.6;
        return w;
      });
      const sum = weights.reduce((a, b) => a + b, 0) || 1;
      const probabilities: Record<string, number> = {};
      keys.forEach((k, i) => (probabilities[k] = weights[i] / sum));
      const choice = keys.reduce((best, k) => (probabilities[k] > probabilities[best] ? k : best), keys[0]);
      out[card.key] = { type: "choice", choice, probabilities };
    } else {
      const rubric = card.criteria;
      let index = Math.floor(seed * rubric.length);
      if (has(text, ["angry", "ridiculous", "unacceptable", "furious", "worst", "!!"])) index = rubric.length - 1;
      else if (has(text, ["frustrat", "annoy", "disappoint", "again", "still"])) index = Math.min(rubric.length - 1, 2);
      else if (has(text, ["thank", "great", "love", "awesome", "happy"])) index = 0;
      index = Math.max(0, Math.min(rubric.length - 1, index));
      const distribution = rubric.map((_, i) => (i === index ? 0.6 : 0.4 / (rubric.length - 1)));
      out[card.key] = { type: "score", index, label: rubric[index], distribution };
    }
  }

  return out;
}
