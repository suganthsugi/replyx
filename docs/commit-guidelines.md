# Commit Guidelines

These rules are mandatory for every commit in this repository.

## 1. One-line commit messages

A commit message is a single line — a subject only, no body.

- Keep it concise and imperative: `Add ticket severity filter`, not `Added a filter...`.
- No blank line + body paragraph. No bullet lists. One line, full stop.

## 2. Unit commits (one functionality change per commit)

Each commit captures exactly one functionality change.

- If a change touches multiple concerns, split it into separate commits — one per concern.
- Do not batch unrelated changes (e.g. a bug fix and a refactor) into a single commit.
- Staging should be scoped per change (`git add -p` when needed) so each commit stands alone and could be reverted independently.

## 3. No co-author or AI references

Commit messages must not contain:

- `Co-Authored-By:` trailers.
- Any mention of AI tools or assistants (e.g. Claude, Copilot, "generated with", "AI-assisted").
- Emoji/attribution footers referencing tooling.

The message describes the change only.

## Examples

Good:

```
Add pnpm-based CI workflow
Fix null ticket category crash
Rename classifier config key
```

Bad:

```
Update stuff and fix things            # vague + batches multiple changes

Add filter

Co-Authored-By: Some Bot <bot@example.com>   # forbidden trailer + multi-line
```
