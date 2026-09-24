---
name: ui-components
description: MUI 7 theme and tokens, the shared component system, and WCAG 2.2 AA rules (loading/empty/error, focus, LiveRegion, keyboard). Use when adding or editing files in apps/web/src/theme or apps/web/src/components.
---

# ui-components

Scope: `apps/web/src/theme` and `apps/web/src/components`. Loaded by frontend-agent. Ties to
tasks T051 (theme), T053 (shell/foundations), and the shared component list in
`specs/001-multi-tenant-helpdesk/plan.md` §UI architecture.

## Rules

1. **Theme and tokens live in `src/theme`, nowhere else.** `tokens.ts` exports raw values (color,
   type scale, spacing, radius, elevation); `theme.ts` builds `createTheme()` for light and dark
   from those tokens, with visible focus rings and `prefers-reduced-motion` support;
   `brand-accent.ts` applies the tenant's primary color, adjusted to the nearest WCAG AA-compliant
   shade against the surface it sits on. Components import from the MUI theme (`useTheme`,
   `sx`), never from `tokens.ts` directly.
   ```ts
   // target shape (from plan.md §UI architecture, tasks.md T051)
   // apps/web/src/theme/theme.ts
   export function createAppTheme(mode: 'light' | 'dark', brandAccent?: string) {
     return createTheme({
       palette: { mode, primary: { main: brandAccent ?? tokens.color.primary } },
       components: {
         MuiButtonBase: { styleOverrides: { root: { '&:focus-visible': { outline: `2px solid ${tokens.color.focusRing}`, outlineOffset: 2 } } } },
       },
     });
   }
   ```
   Wrong: hard-coding a hex color or `px` spacing value inside a component instead of reading it
   from the theme.

2. **Every data-bearing component has three required states: loading, empty, error.** Use
   `Skeleton` for loading, `EmptyState` for zero results, and render the mapped error (see
   `data-hooks` skill) with a retry action, not a raw error string. A component that only renders
   its "happy path" is incomplete.
   ```tsx
   // apps/web/src/components/data-display/TicketList.tsx (target shape)
   if (query.isLoading) return <Skeleton variant="list" rows={8} />;
   if (query.isError) return <EmptyState variant="error" onRetry={query.refetch} message={mapError(query.error).message} />;
   if (query.data.items.length === 0) return <EmptyState variant="empty" title="No tickets" />;
   return <DataTable rows={query.data.items} ... />;
   ```
   Wrong: `{query.data?.items.map(...)}` with no branch for loading or empty.

3. **Announce live changes through `LiveRegion`, never through a toast alone.** New messages,
   typing indicators, and notification arrivals must be readable by a screen reader (FR-071a,
   SC-013a). `LiveRegion` is a single `aria-live="polite"` (or `"assertive"` for errors) region
   mounted once per area (customer chat, workspace shell); components push text into it, they
   don't render their own `aria-live` div.
   ```tsx
   // apps/web/src/components/foundations/LiveRegion.tsx (target shape)
   export function LiveRegion({ politeness = 'polite' }: { politeness?: 'polite' | 'assertive' }) {
     const { message } = useLiveRegion();
     return <div role="status" aria-live={politeness} className="visually-hidden">{message}</div>;
   }
   ```
   Wrong: a component-local `<div aria-live="polite">{newMessage}</div>` that unmounts with the
   component and loses the announcement on route change.

4. **Every interactive element is reachable and operable by keyboard alone**, with a visible
   focus ring from rule 1 and an accessible name (`aria-label` or visible text, never icon-only
   with no label). `CommandBar` opens on Ctrl/Cmd+K; the triage bar accepts `G`/`O`/`Enter`
   (plan.md §Wireframe structure). Modal/Drawer trap focus and return it to the trigger on close.
   Test with `expectNoAxeViolations()` (see `web-testing` skill) and a keyboard-only pass.
   Wrong: a clickable `<Box onClick={...}>` row with no `role="button"`, `tabIndex`, or key
   handler.

5. **The customer chat area (`apps/web/src/pages/customer`, `components/chat`) never imports or
   renders ticket concepts** — no ticket id, status pill, group, priority, or internal note.
   Customers see `ChatThread`, `ChatBubble`, `ResolvedMarker`, `StatusLine`, `TypingDots`,
   `ChatComposer`, `RatingPrompt` only (constitution XI, plan.md §Shared component system). If a
   customer-facing screen needs ticket data, it must come through the customer conversation
   projection (see `data-hooks`), not the staff ticket API.
   Wrong: reusing `TicketRow` or `StatePill` inside a customer page "just for styling".

6. **New shared components go in the matching family folder** from
   `plan.md` §Shared component system (`foundations`, `data-display`, `inputs`, `builders`,
   `shell`, `chat`) — don't create a one-off component inside a page folder when it's reused
   across areas.

## Checklist (before reporting done)
- [ ] New component has loading, empty, and error branches (rule 2)
- [ ] Colors, spacing and type come from the theme/tokens, not literals (rule 1)
- [ ] Live updates go through `LiveRegion`, not an ad-hoc `aria-live` (rule 3)
- [ ] Keyboard operable with a visible focus ring and accessible name (rule 4)
- [ ] No ticket vocabulary in `pages/customer` or `components/chat` (rule 5)
