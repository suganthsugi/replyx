# Data Model: Product Documentation Site

There is no database. The entities below are content files and typed constants in `apps/docs`.

## Docs Page (MDX/Markdown file)

| Field | Source | Rules |
|---|---|---|
| path | `content/docs/<group>/<slug>.md(x)` | `group` ∈ {concepts, guides, admin, operators, developers}. The slug is kebab-case and is the same as today's file name for migrated pages. |
| url | derived: `/<group>/<slug>/` | Must equal the Starlight URL for migrated pages (see `contracts/routes.md`). |
| title | frontmatter | One line, no trailing period (docs-style rule 5). |
| description | frontmatter | One full sentence. |
| order | the parent folder's `meta.json` `pages` array | Every file must be listed. Unlisted files fail a unit check. |

**Group (folder `meta.json`)**: `title` and `pages[]`. The root `meta.json` orders the groups and holds the external "API reference" link.

## Flow Stage

| Field | Type | Rules |
|---|---|---|
| id | `'intake' \| 'rules' \| 'decision' \| 'groups' \| 'triage' \| 'factors' \| 'score' \| 'levels'` | Unique. |
| caption | string ≤ 40 chars | Visible label. |
| href | docs URL | Must resolve to an existing page or anchor (checked by the link checker). |
| ai | boolean | true for `decision`, `factors`, `score` and `levels`, which get the neon treatment. All other stages are false. |

## Flow Scenario

| Field | Type | Rules |
|---|---|---|
| id | string | Unique. |
| message | string ≤ 90 chars | Made up. No real names, emails or order numbers that look real (use `#10xx`). |
| ruleMatch | `{ rule: string, group: string } \| null` | When set, `routing` is skipped and the ticket goes straight to `group`. |
| routing | `{ candidates: { group: string, confidence: number }[] } \| null` | Required when `ruleMatch` is null. Confidences are in [0,1]. The top candidate wins only if confidence ≥ 0.70, otherwise the outcome is `triage`. |
| factors | `{ frustration: number, severalIssues: number, technical: number, vip: 0 \| 1 } \| null` | Each value is in [0,1]. Null when the outcome is `triage`, because complexity is not shown. |
| expected | `{ group: string \| 'Needs Triage', score?: number, level?: 'Fast' \| 'Standard' \| 'Advanced' }` | Must equal what `complexity.ts` computes. A unit test asserts it. |

**State per cycle** (player): `idle → intake → rules → (decision →) groups|triage → factors → score → level → hold → next scenario`. A triage outcome ends the cycle after `triage`. With reduce-motion or no JS, the player stays in the static `complete` state.

## Complexity (mirror of spec 002 R12)

- `score = (2·frustration + 1·severalIssues + 1·technical + 1·vip) / 5`
- `level = score < 0.45 ? 'Fast' : score < 0.80 ? 'Standard' : 'Advanced'`

## Illustration

An SVG React component. It has a `title` (for a standalone figure), it uses only the CSS variables in `contracts/theme-tokens.md`, and it has no hard-coded fill or stroke colours. A lint-style unit test greps the components for `#[0-9a-f]{3,6}` and allows hex values only in `Logo.tsx`.
