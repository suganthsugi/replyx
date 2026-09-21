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
      // Match keywords to the concept implied by the card key.
      let probability = Math.min(0.45, seed * 0.6);
      if (card.key.includes("refund")) {
        if (has(text, ["refund", "money back", "chargeback", "reimburse"])) probability = 0.8 + seed * 0.19;
      } else if (card.key.includes("churn")) {
        if (has(text, ["cancel", "unsubscribe", "downgrade", "leave", "switch", "competitor", "refund"]))
          probability = 0.75 + seed * 0.24;
      }
      out[card.key] = { type: "noul", probability };
    } else if (card.type === "choice") {
      const keys = Object.keys(card.criteria);
      // Weight keys by naive keyword hits so the mock feels responsive.
      const weights = keys.map((k) => {
        let w = 0.2 + hash(k + message) * 0.6;
        // department
        if (k === "sales" && has(text, ["price", "pricing", "plan", "upgrade", "quote", "buy"])) w += 1.2;
        if (k === "service" && has(text, ["bug", "error", "broken", "not working", "help", "issue", "down"])) w += 1.2;
        if (k === "customer_success" && has(text, ["onboard", "renew", "cancel", "churn", "adopt"])) w += 1.0;
        // ticket_type
        if (k === "follow_up" && has(text, ["again", "already", "still", "previous", "last time", "twice", "ticket #"])) w += 1.3;
        if (k === "new" && !has(text, ["again", "already", "still", "previous", "last time", "twice"])) w += 0.6;
        // topic
        if (k === "bug" && has(text, ["bug", "error", "broken", "crash", "500", "not working", "fails"])) w += 1.3;
        if (k === "billing" && has(text, ["refund", "charge", "invoice", "price", "billing", "payment", "card"])) w += 1.3;
        if (k === "how_to" && has(text, ["how do i", "how to", "where is", "can i", "what is"])) w += 1.2;
        if (k === "feature_request" && has(text, ["feature", "please add", "would be nice", "support for", "request"])) w += 1.2;
        if (k === "account" && has(text, ["login", "log in", "password", "account", "access", "locked out", "sign in"])) w += 1.2;
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
      if (card.key.includes("priorit") || card.key.includes("urgen")) {
        // Urgency-driven score.
        if (has(text, ["asap", "urgent", "immediately", "critical", "down", "outage", "emergency", "!!"]))
          index = rubric.length - 1;
        else if (has(text, ["soon", "still", "again", "waiting", "blocked"])) index = Math.min(rubric.length - 1, 2);
        else if (has(text, ["whenever", "no rush", "just wondering", "curious"])) index = 0;
      } else {
        // Mood-driven score.
        if (has(text, ["angry", "ridiculous", "unacceptable", "furious", "worst", "!!"])) index = rubric.length - 1;
        else if (has(text, ["frustrat", "annoy", "disappoint", "again", "still"])) index = Math.min(rubric.length - 1, 2);
        else if (has(text, ["thank", "great", "love", "awesome", "happy"])) index = 0;
      }
      index = Math.max(0, Math.min(rubric.length - 1, index));
      const distribution = rubric.map((_, i) => (i === index ? 0.6 : 0.4 / (rubric.length - 1)));
      out[card.key] = { type: "score", index, label: rubric[index], distribution };
    }
  }

  return out;
}
