# ReplyX design system

The visual source of truth for `apps/web` screens built from **Phase 5 onward**
(specs/001-multi-tenant-helpdesk/tasks.md). Screens from Phases 1–4 keep the original theme
(`apps/web/src/theme/tokens.ts`, indigo/coral) until a later retheme task moves them over.

## Files

| File | What it shows | Screens that inherit it |
|------|---------------|-------------------------|
| `Workspace Inbox.dc.html` | View rail + ticket list + ticket focus, triage bar, internal notes, presence, SLA pill, reconnecting / access-revoked banners, empty view, mobile one-pane flow | All workspace (`/desk`) ticket screens: views, ticket focus, triage, composer, notes, collision, bulk selection, notifications |
| `Customer Chat.dc.html` | Single chat thread: empty welcome, first message, active + typing, resolved + rating, past issues as dated dividers, out of hours, reconnecting, rate limited; mobile frame and centered desktop | Customer area chat and everything around it |
| `Customer Sign-in.dc.html` | Centered auth card: customer email step, check-your-email, staff sign-in | Any auth-style card (sign-up, invitation, reset, locked, expired). Phase 3 sign-in pages stay as they are for now |
| `support.js` | Generated preview runtime (do not edit) | — |

Open a `.dc.html` file in a browser to preview it. Each has scenario and light/dark toggles. The
**"Inherits from this template"** note at the bottom of each file lists the states it covers.
The HTML is a mock. Rebuild it with MUI and the shared components, and don't copy the inline
styles.

## Color tokens

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `pageBg` | `#F1F5F9` | `#0B1120` | App background behind panes |
| `bg` | `#F8FAFC` | `#0B1120` | Timeline / focus pane background |
| `surface` | `#FFFFFF` | `#0F172A` | Panes, cards, headers, composer bar |
| `surface2` | `#F1F5F9` | `#1E293B` | Inputs, chips, inactive pills, count badges |
| `border` | `#E2E8F0` | `#1E293B` | All 1px dividers and outlines |
| `textPrimary` | `#0F172A` | `#F1F5F9` | Body and headings |
| `textSecondary` | `#475569` | `#94A3B8` | Meta, labels, timestamps |
| `primary` | `#0D9488` | `#2DD4BF` | Primary actions, active view, links, unread dot, customer bubble |
| `primaryContrast` | `#FFFFFF` | `#0F172A` | Text on `primary` |
| `primarySoft` | `#CCFBF1` | `#134E4A` | Selected rail item, avatar/icon tiles, agent reply bubble (workspace) |
| `warningText` / `warningSoft` | `#92400E` / `#FEF3C7` | `#FBBF24` / `#3F2D0B` | Internal notes, pending state, reconnecting, out-of-hours, rate limit, collision |
| `errorText` / `errorSoft` | `#991B1B` / `#FEE2E2` | `#F87171` / `#3F1417` | Access revoked, hard errors |
| `slaOkText` / `slaOkSoft` | `#047857` / `#D1FAE5` | `#34D399` / `#0B2E22` | SLA on track / met, resolved state |
| `slaWarnText` / `slaWarnSoft` | = warning | = warning | SLA close to breach |

`primary` is the default brand accent. A tenant color still replaces it through
`resolveBrandAccent`. **Accessibility beats the mock.** White on `#0D9488` is about 3.7:1, which
fails WCAG AA for normal text. The resolver's AA shift (and `contrastThreshold: 4.5`) will darken
it for button text and links. Don't work around that.

## Typography

- **Sora** 600/700 for headings and titles: pane titles 14–15px, ticket title 16px, auth card
  title 19px, empty-state titles 13–16px, org avatar initial.
- **Inter** 400/500/600 for everything else. Body is 13px in the workspace and 14px in the
  customer chat. Meta text is 11–12px. Timestamps are 10px.
- Ticket numbers use a monospace font (`#4821`), in the workspace only.
- Section labels are 12px/600, uppercase, letter-spacing `.04em`.

## Shape, spacing, elevation

- 4px spacing grid. Pane padding is 12–16px. List rows are 10px × 14px.
- Radii: 8px for inputs, segmented controls and rail items. 10–12px for cards, notes, the
  composer textarea and icon tiles. 14–16px for app shells, the auth card and chat bubbles.
  Chat bubbles get a 4px corner on the sender's side.
- **Pills (`9999px`) for every button, chip and status badge**: primary actions, send, mode
  toggles (Reply / Internal note), triage chips, state and SLA badges, count badges.
- Borders do the separating, not shadows. Shadows only on the outer shell
  (`0 8px 24px rgba(0,0,0,.08–.12)`).

## Component patterns

- **Status badge**: soft background with strong text, 10px/700 uppercase (Open = primary,
  Pending = warning, Resolved = slaOk).
- **Banner**: a full-width strip under the header, soft background with strong text, 12–13px
  (reconnecting = warning, access revoked = error).
- **Empty state**: centered icon tile (`primarySoft` / `primary`), a Sora title and one
  secondary line. Maps onto `EmptyState`.
- **Internal note**: warning-soft card with a 3px `warningText` left border and an uppercase
  "Internal note · {author}" label. The composer in note mode also turns warning-soft.
- **Timeline event**: centered 11px secondary text ("Priority set to High by Sam").
- **Presence**: 24px overlapping initials avatars ringed with `surface`.
- **Keyboard hints**: shortcut letters (`G`, `O`, `↵`) shown faintly inside the matching chip or
  button.
- **Customer chat**: the customer's own bubbles are `primary`, right-aligned, with a delivery
  status (Sending… / Sent / Read). Support bubbles are `surface` with a border, left-aligned.
  Past issues are shown as dated divider lines only. A rating card offers 1–5 buttons and a Skip.
- **Layout**: the workspace desktop grid is `200px rail | 320px list | 1fr focus`. On mobile it's
  one pane at a time, with "← Back to list". The customer chat is a full-height column, centered
  on desktop.

## Rules that still apply

The existing `ui-components` rules come first. That means theme tokens only (no inline hex), shared
components, loading, empty and error states, `useAnnounce`, keyboard access, and **no ticket
concepts in the customer area** (the chat mock follows this, and so must its implementations).
