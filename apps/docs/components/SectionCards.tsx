import Link from 'next/link';
import { Icon, type IconName } from './flow/primitives';

/**
 * Home page section cards (US5): one card per area of the docs, each linking to that area's first
 * page. The whole card is the link. Only the AI assist icon gets the neon glow, as everywhere else on
 * the site AI parts are the only neon ones (FR-016a).
 */

interface Section {
  title: string;
  summary: string;
  href: string;
  icon: IconName;
  ai?: boolean;
}

const SECTIONS: readonly Section[] = [
  { title: 'Agent desk', summary: 'Work tickets, reply to customers and keep every conversation moving.', href: '/guides/working-tickets/', icon: 'inbox' },
  { title: 'Customer chat', summary: 'What your customers see when they message your support team.', href: '/guides/customer-chat/', icon: 'chat' },
  { title: 'AI assist', summary: 'Let the assistant answer or draft replies from your own policies.', href: '/guides/ai-assist/', icon: 'spark', ai: true },
  { title: 'Routing & SLA', summary: 'Send tickets to the right group and keep to your response times.', href: '/admin/routing-rules/', icon: 'rules' },
  { title: 'Administration', summary: 'Organization settings, users, roles, groups and the audit log.', href: '/admin/organization-settings/', icon: 'sliders' },
  { title: 'Developers', summary: 'Authorization, conversation routing and deploying ReplyX.', href: '/developers/authorization/', icon: 'code' },
];

export function SectionCards() {
  return (
    <section className="mx-auto w-full max-w-[1280px] px-4 pb-20" aria-labelledby="sections-title">
      <p className="mb-2 font-mono text-xs font-semibold tracking-[0.14em] text-fd-muted-foreground uppercase">Documentation</p>
      <h2 id="sections-title" className="mb-6 text-2xl font-bold tracking-tight">
        Find your way around
      </h2>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" data-section-cards>
        {SECTIONS.map((section, i) => (
          <li key={section.href} className="flex">
            <Link
              href={section.href}
              className="group relative flex w-full flex-col rounded-2xl border border-fd-border bg-fd-card p-5 transition-[transform,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.2,0,0,1)] hover:-translate-y-0.5 hover:border-[var(--rx-primary)] hover:shadow-[0_18px_40px_-24px_var(--rx-ai-glow)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rx-primary)] motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            >
              <span className="mb-4 flex items-center justify-between">
                <span
                  className={
                    section.ai
                      ? 'flex size-10 items-center justify-center rounded-xl border border-[var(--rx-ai)] text-[var(--rx-ai)] shadow-[0_0_18px_var(--rx-ai-glow)]'
                      : 'flex size-10 items-center justify-center rounded-xl border border-fd-border bg-fd-muted text-fd-muted-foreground'
                  }
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 20 20" className="size-5 overflow-visible">
                    <Icon name={section.icon} x={0} y={0} size={20} />
                  </svg>
                </span>
                <span className="font-mono text-xs text-fd-muted-foreground" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
              </span>
              <span className="text-lg font-semibold">{section.title}</span>
              <span className="mt-1 text-sm text-fd-muted-foreground">{section.summary}</span>
              <span
                className="mt-4 text-sm font-semibold text-fd-primary transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none"
                aria-hidden="true"
              >
                Open →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
