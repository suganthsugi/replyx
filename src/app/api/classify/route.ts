import { NextResponse } from "next/server";

import { cards } from "@/lib/cards";
import { callJev, cardsToQuestions, normalizeAnswers } from "@/lib/jev";
import { mockAnswers } from "@/lib/mock";
import type { ClassifyResponse } from "@/lib/types";

export const runtime = "nodejs";

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
    };
    return NextResponse.json(payload);
  }

  try {
    const raw = await callJev(message, cardsToQuestions(cards));
    const payload: ClassifyResponse = {
      message,
      answers: normalizeAnswers(raw, cards),
      mock: false,
    };
    return NextResponse.json(payload);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
