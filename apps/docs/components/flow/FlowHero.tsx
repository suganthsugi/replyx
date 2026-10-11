import Link from 'next/link';
import { FlowPlayer } from './FlowPlayer';

/**
 * Home page hero (US1): the headline, then the routing and complexity reel. The reel sits in a
 * `figure` with a text alternative for the whole flow (FR-011); its chapter bar holds the stage links
 * (FR-007), which is why the figure is not role="img" (that would hide the links).
 */
export function FlowHero() {
  return (
    <section className="relative mx-auto w-full max-w-[1280px] px-4 pt-14 pb-10 md:pt-20" aria-labelledby="hero-title">
      <div className="mx-auto max-w-3xl text-center">
        <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-3 py-1 text-sm font-medium text-fd-muted-foreground">
          <span className="size-2 rounded-full bg-[var(--rx-ai)] shadow-[0_0_10px_var(--rx-ai-glow)]" aria-hidden="true" />
          ReplyX AI routing
        </p>
        <h1 id="hero-title" className="text-4xl font-bold tracking-tight text-balance md:text-5xl">
          Every conversation, routed and answered by the right model
        </h1>
        <p className="mt-5 text-lg text-fd-muted-foreground text-pretty">
          Your rules run first. When none match, the decision model picks the team. Then a complexity score
          decides whether a fast, standard or advanced model writes the reply, so the expensive ones are used rarely.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/guides/working-tickets/"
            className="rounded-full bg-fd-primary px-5 py-2.5 text-sm font-semibold text-fd-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rx-primary)]"
          >
            Read the guides
          </Link>
          <Link
            href="/guides/ai-assist/"
            className="rounded-full border border-fd-border bg-fd-card px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rx-primary)]"
          >
            Set up AI assist
          </Link>
        </div>
      </div>

      <figure
        aria-labelledby="flow-desc"
        className="mt-12 rounded-3xl shadow-[0_40px_120px_-48px_var(--rx-ai-glow)]"
        style={{ containerType: 'inline-size', containerName: 'flow' }}
      >
        <p id="flow-desc" className="sr-only">
          How ReplyX handles a new customer conversation. The conversation becomes a ticket. Your routing
          rules are checked first; if one matches, the ticket goes straight to that rule&apos;s group. If no
          rule matches, the decision model reads the first message, compares it with each group&apos;s AI
          description and gives each group a confidence. The ticket moves to the most likely group only when
          that confidence is at least 0.70; otherwise it stays in Needs Triage for a person to sort. Next, the
          complexity factors are scored: customer frustration counts double, then several issues in one
          message, a technical problem, and a VIP customer. Their weighted average is the complexity score.
          Below 0.45 the Fast model level answers, from 0.45 the Standard level, and from 0.80 the Advanced
          level, so the cheaper levels handle most conversations. The animation plays five example conversations
          in turn, one short reel each.
        </p>
        <FlowPlayer />
      </figure>
    </section>
  );
}
