import Link from 'next/link';

// Placeholder until the animated flow hero lands (US1).
export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-4 py-16">
      <h1 className="text-3xl font-semibold">ReplyX Docs</h1>
      <p className="text-fd-muted-foreground">
        Guides, admin reference, operator runbooks and developer docs for the ReplyX help desk.
      </p>
      <Link href="/guides/working-tickets/" className="text-fd-primary underline">
        Start with the guides
      </Link>
    </main>
  );
}
