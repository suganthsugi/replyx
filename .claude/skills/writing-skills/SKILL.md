---
name: writing-skills
description: How to write or update a skill in .claude/skills/ for this repo. Use when creating a "planned" catalog skill or revising an existing one.
---

# writing-skills

Skills are loaded into a specialist agent's context for a single task, so every line has to earn its place.

## Hard rules

1. **Location.** Put the skill in `.claude/skills/<name>/SKILL.md`. `<name>` is kebab-case and matches the catalog name in `CLAUDE.md`.
2. **Frontmatter.** Use exactly `name` and `description`. The description is one line that says what the skill covers, followed by a "Use when ..." clause. The description is always in context, so keep it under about 200 characters.
3. **Length.** Keep the file under about 200 lines. If it grows past that, split it into a second skill, or put reference tables in `.claude/skills/<name>/reference.md` and link to that file from SKILL.md.
4. **Concrete rules only.** Every rule must be checkable in a diff: "every repository method takes `tenantId` as its first argument", not "be careful with tenancy". Remove generic advice such as clean code, SOLID, "write good tests", or anything else a senior developer already knows.
5. **Real examples.** Take examples from our codebase and cite the path, e.g. `// from apps/api/src/tickets/ticket.repository.ts`. Read the actual files first with Grep and Read. Keep each snippet to 25 lines or fewer and cut it to the part that illustrates the rule.
   - If the code does not exist yet, write the example from `specs/<feature>/plan.md` or `contracts/`. Mark it `// target shape (from plan.md §X)` and replace it with real code once the code exists.
6. **Anti-examples.** Include a short "Wrong" snippet for each rule that agents commonly break.
7. **Constitution first.** A skill must never contradict `.specify/memory/constitution.md` or the non-negotiables in `CLAUDE.md`. Where they apply, restate them as concrete rules.
8. **No secrets or real data.** Examples use fake tenants and users (`tenant_a`, `agent@example.test`).

## Template

```markdown
---
name: <name>
description: <what it covers>. Use when <trigger: task type / files touched>.
---

# <name>

<1–2 lines: scope, and which agent(s) typically load it>

## Rules
1. <rule> — see `path/to/file.ts`
   ```ts
   // from apps/api/src/...
   <≤25 lines>
   ```
   Wrong: `<one-line anti-example>`

## Checklist (before reporting done)
- [ ] <verifiable item>
```

## Procedure

1. Read the catalog line for the skill in `CLAUDE.md` and the task handoff that triggered the request.
2. Grep the codebase for existing patterns. If a pattern exists, the skill documents it; it does not invent a new one. If two patterns conflict, report that instead of choosing one.
3. Write the SKILL.md.
4. **Update the catalog in `CLAUDE.md`.** Change the skill's status from `planned` to `exists` and adjust its one-line summary if the scope changed. A new skill that isn't in the catalog gets a new line there too.
5. Report the skill path, its line count, and the catalog change.

## Updating an existing skill

- Replace outdated examples with the current code. Don't append "update:" notes.
- Keep the file under 200 lines after the change. Delete stale rules rather than piling on new ones.
