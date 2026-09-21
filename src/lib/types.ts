// Shared, client-safe types for cards and normalized answers.
// No server-only imports here — both the UI and the API route depend on this.

export type CardType = "noul" | "choice" | "score";

interface BaseCard {
  key: string;
  type: CardType;
  title: string;
  subtitle?: string;
  instructions: string;
}

export interface NoulCardConfig extends BaseCard {
  type: "noul";
  criteria: { true: string; false: string };
}

export interface ChoiceCardConfig extends BaseCard {
  type: "choice";
  criteria: Record<string, string>;
  /** Optional display labels for each criteria key. */
  labels?: Record<string, string>;
}

export interface ScoreCardConfig extends BaseCard {
  type: "score";
  criteria: string[];
}

export type CardConfig = NoulCardConfig | ChoiceCardConfig | ScoreCardConfig;

/** The question object sent to the Decisions API for a single card. */
export interface JevQuestion {
  type: CardType;
  instructions: string;
  criteria: Record<string, string> | string[];
}

// --- Normalized answer shapes consumed by the UI ------------------------------

export interface NoulAnswer {
  type: "noul";
  /** Probability in [0,1] that the answer is "true". */
  probability: number;
}

export interface ChoiceAnswer {
  type: "choice";
  /** The winning option key. */
  choice: string;
  /** Full distribution over option keys. */
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: "score";
  /** Index into the ordered rubric. */
  index: number;
  /** Rubric label at `index`. */
  label: string;
  /** Optional distribution across rubric positions. */
  distribution?: number[];
}

export type CardAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type AnswerMap = Record<string, CardAnswer>;

/** Response shape returned by POST /api/classify. */
export interface ClassifyResponse {
  message: string;
  answers: AnswerMap;
  mock: boolean;
}
