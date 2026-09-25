---
name: ui-components
description: MUI theme/tokens and brand accent, shared components, route areas, WCAG 2.2 AA rules, no ticket concepts for customers. Use when editing apps/web/src/{theme,components,routes} or pages.
---

# ui-components

Scope: `apps/web/src/theme`, `src/components`, `src/routes`, and pages (`src/pages/{customer,desk,
admin,console}`, target per plan.md; not created yet). Loaded by frontend-agent. Data access
rules live in `data-hooks`; tests in `web-testing`.

## Rules

1. **Tokens and theme live in `src/theme` only.** `tokens.ts` (`colorTokens`, `typeScaleTokens`,
   `spacingTokens`, `radiusTokens`, `elevationTokens`, `motionTokens`) feeds `theme.ts`
   `createAppTheme(mode, tenantColor?)` (exports `lightTheme`, `darkTheme`). It sets focus rings
   (`.Mui-focusVisible` on ButtonBase, `:focus-visible` on Link), `prefers-reduced-motion`,
   `contrastThreshold: 4.5`. Tenant colors go through `resolveBrandAccent` (`brand-accent.ts`),
   which shifts to the nearest AA shade; never put a tenant color into the palette yourself.
   Components read the theme (`sx`, `useTheme`), never `tokens.ts`.
   Wrong: `sx={{ color: '#1e40af', padding: '12px' }}`; `import { colorTokens } from '../theme/tokens'`
   in a component; `createTheme({ palette: { primary: { main: settings.brandColor } } })`

2. **Every data-bearing view has loading, empty and error branches** using
   `components/foundations/Skeleton` (`variant: 'list'|'text'|'block'`, `rows`, `label` → announced
   "Loading {label}") and `EmptyState` (`variant: 'empty'|'error'`, `title`, `message?`, `action?`,
   `onRetry?` → "Try again", `headingLevel?`). Error text is `mapError(error).message` (data-hooks).
   ```tsx
   // target shape (components as they exist in src/components/foundations)
   if (query.isPending) return <Skeleton variant="list" rows={8} label="tickets" />;
   if (query.isError) return <EmptyState variant="error" title="Couldn't load tickets"
     message={mapError(query.error).message} onRetry={() => void query.refetch()} />;
   if (query.data.items.length === 0) return <EmptyState title="No tickets in this view" />;
   ```
   Wrong: `{query.data?.items.map(...)}` with no pending/error/empty branch; rendering `error.message` raw

3. **Announce live changes with `useAnnounce()`** (`foundations/LiveRegion.tsx`):
   `announce(text, 'polite' | 'assertive')`. `LiveRegionProvider` renders two visually hidden
   regions with plain `aria-live` + `aria-atomic` (no `role="status"`/`"alert"`, so they don't
   collide with components' roles); repeated text is re-announced. `useToast()`
   (`shell/Toast.tsx`) also announces (errors assertively). Both need the area's providers, which
   `AreaShell` supplies.
   Wrong: a component-local `<div aria-live="polite">`; `role="status"` on an announcer

4. **Use the shell components instead of raw MUI dialogs/forms** (`src/components/shell/`):
   - `Modal({ open, onClose, title, actions?, maxWidth?, busy? })`: labelled by its title, close
     button "Close", focus trap and return (MUI); `busy` blocks closing while saving.
   - `ConfirmationDialog({ title, message, confirmLabel, destructive?, requireText?, onConfirm })`.
   - `Drawer({ open, onClose, title, anchor?, width? })`.
   - `Form({ onSubmit, label })` + `FormField({ name, label })` + `FormError` + `SubmitButton`:
     `onSubmit` is async; a thrown API error is mapped, `fieldErrors[name]` lands on the matching
     field via `issueMessage(issue)`, anything else in `FormError`; submit disables while pending.
     `FormField` `name` must equal the API `details[].path`.
   - `ErrorBoundary({ resetKeys })`, `Toast`.
   Wrong: `<Dialog>` without `aria-labelledby`; per-form ad-hoc submitting/error state

5. **Keyboard and names.** Every interactive element is a real control (Button, IconButton,
   ListItemButton, Link) with an accessible name; icon-only buttons get `aria-label`. Icons from
   `foundations/icons.tsx` are `aria-hidden`; the control names them. Hide text visually with
   `VisuallyHidden` / `visuallyHiddenStyle`. Headings form an outline (`EmptyState headingLevel`).
   Shortcuts per plan (Ctrl/Cmd+K command bar; triage `G`/`O`/`Enter`).
   Wrong: `<Box onClick>` row with no role/tabIndex/key handler; `<IconButton><CloseIcon/></IconButton>`

6. **Route areas** (`src/routes/`): `area.ts` picks the area — console = host whose first label is
   `console` (`isConsoleHost`, no build config), workspace = `/desk` and below
   (`WORKSPACE_BASE`), anything else on a tenant host = customer. `index.tsx` lazy-loads
   `CustomerArea`/`WorkspaceArea`/`ConsoleArea` (separate chunks) and holds QueryClient, theme and
   router. Each area wraps its routes in `AreaShell` (own `LiveRegionProvider` + `ToastProvider` +
   `ErrorBoundary resetKeys={[pathname]}`) and ends with `<Route path="*" element={<NotFoundPage />} />`.
   Add pages as routes inside the area component; workspace paths are relative to `/desk`
   (admin under `/desk/admin`). Each page renders one `<Box component="main">` with an `h1`.
   ```tsx
   // from apps/web/src/routes/WorkspaceArea.tsx
   <AreaShell>
     <Routes>
       <Route index element={<WorkspaceHome />} />
       <Route path="*" element={<NotFoundPage />} />
     </Routes>
   </AreaShell>
   ```
   Wrong: importing a workspace/console module from customer code (breaks chunk isolation);
   `<Route path="/desk/views">` inside `WorkspaceArea`

7. **The customer area never shows ticket concepts** (constitution XI): no ticket id/number,
   state, group, owner, priority, SLA or internal notes, and no imports from staff pages or
   ticket components. Customer data comes only from the customer conversation projection.
   Wrong: reusing a `TicketRow` or state pill in a customer page "for styling"

8. **Shared components go in a family folder**: `foundations`, `shell` (exist), `data-display`,
   `inputs`, `builders`, `chat` (plan.md §Shared component system). Not inside a page folder when
   used by more than one page.

## Checklist (before reporting done)
- [ ] Loading/empty/error branches with `Skeleton`/`EmptyState`; errors via `mapError`
- [ ] Colors/spacing/type from the theme; tenant color only through `createAppTheme`
- [ ] Live updates via `useAnnounce`/`useToast`, no ad-hoc `aria-live`
- [ ] Dialogs/forms use `Modal`/`ConfirmationDialog`/`Form`; `FormField name` = API path
- [ ] Keyboard operable, accessible names, one `main` + `h1` per page
- [ ] New routes inside the right area; no cross-area imports; no ticket vocabulary for customers
