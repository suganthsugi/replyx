---
name: docs-style
description: Starlight guide/concept/developer page style, frontmatter, and sidebar groups for apps/docs. Use when adding or editing a page under apps/docs/src/content/docs/.
---

# docs-style

Scope: writing or editing Markdown pages in `apps/docs/src/content/docs/`. Loaded
by documentator and dev-documentator.

## Rules

1. **Directory picks the sidebar group and the page type.** `apps/docs/astro.config.mjs`
   autogenerates four sidebar groups from directories, plus a static link to the
   Scalar-rendered API reference:
   ```js
   // from apps/docs/astro.config.mjs
   sidebar: [
     { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
     { label: 'Admin', items: [{ autogenerate: { directory: 'admin' } }] },
     { label: 'Operators', items: [{ autogenerate: { directory: 'operators' } }] },
     { label: 'Developers', items: [{ autogenerate: { directory: 'developers' } }] },
     { label: 'API reference', link: 'http://localhost:3000/api/docs', attrs: { target: '_blank' } },
   ]
   ```
   Never hand-author API reference pages — that group only links to the
   generated Scalar UI over `apps/api/openapi.yaml`. Put a new page in the one
   directory whose audience matches it; don't add a fifth top-level group.
   Wrong: adding `label: 'FAQ'` as a new sidebar entry instead of an `items` array under an existing group's directory.

2. **`guides/*` pages are for the end user doing the task now** — customers or
   staff, second person, one flow per page, no file paths or code. See
   `apps/docs/src/content/docs/guides/customer-chat.md` and `guides/signing-in.md`:
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
   `apps/docs/src/content/docs/admin/roles-and-groups.md`:
   ```md
   - **View** — see the group's tickets and their full conversation, including
     internal notes. Without View, a group's tickets are invisible to the
     role — they don't appear in lists, search, or counts.
   ```
   and `apps/docs/src/content/docs/operators/tenants.md`, which documents
   platform-console actions (suspend, reactivate, support sessions) separately
   from tenant-side `admin/*` pages. Still second person, still no code, but
   explains *why* (effects, reversibility, what's kept vs removed) alongside
   the *how*.
   Wrong: an `admin/*` page that is just a numbered click-path with no explanation of the rule's effects (e.g. what deactivation vs delete vs erase actually does).

4. **`developers/*` pages are for engineers**: third person, cite real files
   and symbols, use tables for state/decision matrices, use a fenced ` ```ts `
   or ` ```mermaid ` block for a sequence, and end complex ones with a
   checklist. See `apps/docs/src/content/docs/developers/conversation-routing.md`:
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
- [ ] Page is under the directory matching its audience (guides/admin/operators/developers) — no new sidebar group added.
- [ ] Frontmatter has only `title` and `description`, description is a full sentence.
- [ ] Guide pages have no file paths, code, or ticket vocabulary; developer pages cite a real path for every named symbol.
- [ ] Cross-links use `/section/page/` (trailing slash, no `.md`).
