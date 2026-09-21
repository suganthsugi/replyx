// Client-safe loader for the card configuration.
// The JSON file in src/config/cards.json is the single source of truth for the
// dashboard's cards — edit it to add, remove, or reconfigure cards.

import cardsJson from "@/config/cards.json";
import type { CardConfig } from "@/lib/types";

export const cards = cardsJson.cards as CardConfig[];

/** Human label for a choice option key (falls back to a prettified key). */
export function optionLabel(card: CardConfig, key: string): string {
  if (card.type === "choice" && card.labels && card.labels[key]) {
    return card.labels[key];
  }
  return key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
