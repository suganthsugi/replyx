import type { CardAnswer, CardConfig } from "@/lib/types";
import { ChoiceCard } from "./ChoiceCard";
import { NoulCard } from "./NoulCard";
import { ScoreCard } from "./ScoreCard";

export function CardRenderer({ card, answer }: { card: CardConfig; answer?: CardAnswer }) {
  if (!answer) return null;
  if (card.type === "noul" && answer.type === "noul") {
    return <NoulCard card={card} answer={answer} />;
  }
  if (card.type === "choice" && answer.type === "choice") {
    return <ChoiceCard card={card} answer={answer} />;
  }
  if (card.type === "score" && answer.type === "score") {
    return <ScoreCard card={card} answer={answer} />;
  }
  return null;
}
