---
name: docs-style
description: Fumadocs guide/concept/developer page style, frontmatter, and meta.json sidebar groups for apps/docs. Use when adding or editing a page under apps/docs/content/docs/.
---

# docs-style

Scope: writing or editing Markdown/MDX pages in `apps/docs/content/docs/`. Loaded
by documentator and dev-documentator.

## Rules

1. **Directory picks the sidebar group; `meta.json` picks the order.** Each group is
   a folder under `apps/docs/content/docs/` with a `meta.json` that lists every page
   by file name, in reading order. A page missing from `pages` fails
   `apps/docs/test/meta.test.ts`. The root `meta.json` orders the groups:
   ```json
   // from apps/docs/content/docs/meta.json and guides/meta.json
   { "pages": ["guides", "admin", "operators", "developers"] }
   { "title": "Guides", "defaultOpen": true, "pages": ["signing-in", "working-tickets", "triage", "..."] }
   ```
   The groups are `concepts` ("how it works" pages, which may use the illustration
   components registered in `apps/docs/components/mdx.tsx`), `guides`, `admin`,
   `operators` and `developers`. Put a page in the one folder whose audience matches,
   and don't add another group. There is no API reference page: the API serves none
   (`apps/api` mounts no Scalar or `/api/docs`), so never hand-write one.
   Wrong: adding `faq/` as a new group, or a new `.md` file without adding it to its folder's `meta.json`.

2. **`guides/*` pages are for the end user doing the task now** — customers or
   staff, second person, one flow per page, no file paths or code. See
   `apps/docs/content/docs/guides/customer-chat.md` and `guides/signing-in.md`:
   ```md
   Type in the box at the bottom and press **Enter** to send. Press
   **Shift+Enter** to start a new line without sending.
   ```
   Bold the literal UI text, numbers and durations (`**Enter**`, `**5 failed attempts**`,
   `**15 minutes**`) instead of describing them loosely.
   Wrong: `guides/customer-chat.md` explaining `CustomerMessageRouter` internals — that belongs in a developer page.

3. **`admin/*` and `operators/*` pages are concept pages**: they mix an admin or
   platform-operator task with the domain rule that governs it, including
   tables and matrices for the rule, not just click-paths. See
   `apps/docs/content/docs/admin/roles-and-groups.md`:
   ```md
   - **View** — see the group's tickets and their full conversation, including
     internal notes. Without View, a group's tickets are invisible to the
     role — they don't appear in lists, search, or counts.
   ```
   and `apps/docs/content/docs/operators/tenants.md`, which documents
   platform-console actions (suspend, reactivate, support sessions) separately
   from tenant-side `admin/*` pages. Still second person, still no code, but
   explains *why* (effects, reversibility, what's kept vs removed) alongside
   the *how*.
   Wrong: an `admin/*` page that is just a numbered click-path with no explanation of the rule's effects (e.g. what deactivation vs delete vs erase actually does).

4. **`developers/*` pages are for engineers**: third person, cite real files
   and symbols, use tables for state/decision matrices, use a fenced ` ```ts `
   or ` ```mermaid ` block for a sequence, and end complex ones with a
   checklist. See `apps/docs/content/docs/developers/conversation-routing.md`:
   ```md
   `CustomerMessageRouter.accept(ctx, customer, { body, clientMessageId, attachmentIds })`
   (`apps/api/src/messaging/customer-message-router.ts`) handles
   `POST /customer/messages` in **one transaction**:
   ```
   and `developers/authorization.md`'s closing `## Checklist when adding a module`.
   Every code path, class or function named must be backed by a path in
   backticks the first time it's mentioned on the page.
   Wrong: a developer page describing behavior ("the router picks a ticket") with no file path or symbol to find it by.

5. **Frontmatter is exactly `title` and `description`, both one line, no
   trailing period on `title`.** `description` is a full sentence (it feeds
   search results and social previews) and states what the reader does or
   learns, not just the topic noun:
   ```md
   ---
   title: Conversation routing
   description: How a customer's message finds its ticket, stays idempotent under concurrency, and reaches the customer as a ticket-free projection.
   ---
   ```
   Wrong: `description: Conversation routing.` (repeats the title, says nothing new).

6. **One page = one topic; link sideways instead of repeating.** Cross-link
   with the site-relative path in parentheses, e.g.
   `[Signing in](/guides/signing-in/)` (trailing slash, no `.md`). Don't
   restate another page's rules — link to it.
   Wrong: copying the lockout rule from `guides/signing-in.md` into another guide instead of linking it.

7. **Constitution: no ticket concepts leak into customer-facing pages.**
   `guides/*` pages describing the customer experience (e.g. `customer-chat.md`)
   must never mention tickets, groups, states or owners — only conversations,
   messages and support. That vocabulary is reserved for `admin/*`,
   `operators/*` and `developers/*` pages.
   Wrong: telling a customer their message "created ticket #42" in a guide page.

## Checklist (before reporting done)
- [ ] Page is under the folder matching its audience (concepts/guides/admin/operators/developers) and listed in that folder's `meta.json` — no new group added.
- [ ] Frontmatter has only `title` and `description`, description is a full sentence.
- [ ] Guide pages have no file paths, code, or ticket vocabulary; developer pages cite a real path for every named symbol.
- [ ] Cross-links use `/section/page/` (trailing slash, no `.md`), and `pnpm --filter docs build && pnpm --filter docs check:links` reports 0 broken links.
