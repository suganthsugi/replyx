import { NextResponse } from "next/server";

import { cards } from "@/lib/cards";
import { callJev, cardsToQuestions, normalizeAnswers } from "@/lib/jev";
import { mockAnswers } from "@/lib/mock";
import type { ClassifyResponse } from "@/lib/types";

export const runtime = "nodejs";

/** Pull the USD cost out of the raw Decisions API response (`usage.cost`). */
function extractCost(raw: unknown): number {
  if (raw && typeof raw === "object" && "usage" in raw) {
    const usage = (raw as { usage?: unknown }).usage;
    if (usage && typeof usage === "object" && "cost" in usage) {
      const cost = (usage as { cost?: unknown }).cost;
      if (typeof cost === "number" && Number.isFinite(cost)) return cost;
    }
  }
  return 0;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const message =
    body && typeof body === "object" && "message" in body
      ? String((body as { message: unknown }).message ?? "")
      : "";

  if (!message.trim()) {
    return NextResponse.json({ error: "Message is required." }, { status: 400 });
  }

  const url = new URL(request.url);
  const mock = process.env.JEV_MOCK === "1" || url.searchParams.get("mock") === "1";

  if (mock) {
    const payload: ClassifyResponse = {
      message,
      answers: mockAnswers(message, cards),
      mock: true,
      cost: 0,
    };
    return NextResponse.json(payload);
  }

  try {
    const raw = await callJev(message, cardsToQuestions(cards));
    const payload: ClassifyResponse = {
      message,
      answers: normalizeAnswers(raw, cards),
      mock: false,
      cost: extractCost(raw),
    };
    return NextResponse.json(payload);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
