import { HomeLayout } from 'fumadocs-ui/layouts/home';
import Link from 'next/link';
import { baseOptions } from '@/lib/layout.shared';

export default function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
        <p className="text-sm font-medium text-fd-muted-foreground">404</p>
        <h1 className="text-2xl font-semibold">This page doesn&apos;t exist</h1>
        <p className="text-fd-muted-foreground">It may have moved. Search the docs or start from the home page.</p>
        <Link href="/" className="text-fd-primary underline">
          Go to the docs home
        </Link>
      </main>
    </HomeLayout>
  );
}
