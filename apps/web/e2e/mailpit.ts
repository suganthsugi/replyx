import type { APIRequestContext } from '@playwright/test';

/**
 * Reads development mail from Mailpit's HTTP API (web-testing rule 9). The dev stack sends every
 * email there, so an e2e test can follow an invitation or sign-in link exactly as a person would.
 * Playwright's Node-side `request` fixture resolves `mailpit` by compose service name.
 */

const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://mailpit:8025';

interface MessageSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Created: string;
}

/**
 * A fresh address, so tests never read each other's mail: the projects run in parallel against
 * one shared Mailpit and one shared dev database, and clearing the mailbox would race.
 */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}@acme.test`;
}

/** Waits for the newest message to `to` whose subject contains `subject`, and returns its body. */
export async function waitForMessage(
  request: APIRequestContext,
  to: string,
  subject: string,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request.get(`${MAILPIT}/api/v1/messages?limit=50`);
    if (response.ok()) {
      const { messages } = (await response.json()) as { messages: MessageSummary[] };
      const match = messages.find(
        (message) =>
          message.Subject.includes(subject) && message.To.some((recipient) => recipient.Address.toLowerCase() === to.toLowerCase()),
      );
      if (match !== undefined) {
        const body = await request.get(`${MAILPIT}/api/v1/message/${match.ID}`);
        if (body.ok()) return JSON.stringify(await body.json());
      }
    }
    if (Date.now() > deadline) throw new Error(`No "${subject}" email for ${to} within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The first link in `body` whose path matches, as a path the test can navigate to. */
export function linkPath(body: string, pathFragment: string): string {
  const match = new RegExp(`https?://[^"'\\\\\\s<>]*${pathFragment}[^"'\\\\\\s<>]*`).exec(body);
  if (match === null) throw new Error(`No ${pathFragment} link in the email`);
  const url = new URL(match[0].replace(/&amp;/g, '&'));
  return `${url.pathname}${url.search}`;
}
