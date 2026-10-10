# Contract: Theme tokens for the docs site and its illustrations

Source of truth: `designSystemTokens` in `apps/web/src/theme/tokens.ts`. The docs `global.css` defines these on `:root` (light) and `.dark` (dark). Illustrations may use **only** these variables, and no hex values.

| Variable | Light | Dark | Use |
|---|---|---|---|
| `--rx-bg` | `#F8FAFC` | `#0B1120` | page / hero background |
| `--rx-surface` | `#FFFFFF` | `#0F172A` | node fill |
| `--rx-surface-2` | `#F1F5F9` | `#1E293B` | node fill (muted), gauge track |
| `--rx-border` | `#E2E8F0` | `#1E293B` | node strokes, non-AI paths |
| `--rx-text` | `#0F172A` | `#F1F5F9` | labels |
| `--rx-text-2` | `#475569` | `#94A3B8` | secondary labels |
| `--rx-primary` | `#0D9488` | `#2DD4BF` | brand accent, links |
| `--rx-ai` | `#0D9488` | `#2DD4BF` | AI node and path strokes |
| `--rx-ai-glow` | `rgb(13 148 136 / 0.35)` | `rgb(45 212 191 / 0.85)` | neon filter flood colour |
| `--rx-ai-glow-2` | `rgb(34 211 238 / 0.20)` | `rgb(34 211 238 / 0.55)` | outer neon halo (cyan tint) |
| `--rx-warning` | `#92400E` | `#FBBF24` | Needs Triage node |
| `--rx-level-fast` | `#047857` | `#34D399` | Fast level |
| `--rx-level-standard` | `#0D9488` | `#2DD4BF` | Standard level |
| `--rx-level-advanced` | `#6D28D9` | `#A78BFA` | Advanced level (violet, reads as "premium" and is distinct from teal) |

Fumadocs mapping:
- `--color-fd-background` → `--rx-bg`
- `--color-fd-card` → `--rx-surface`
- `--color-fd-border` → `--rx-border`
- `--color-fd-foreground` → `--rx-text`
- `--color-fd-muted-foreground` → `--rx-text-2`
- `--color-fd-primary` → `--rx-primary`

Fonts: headings use Sora and body text uses Inter, both self-hosted.

Contrast requirements (checked by axe and a unit test over the table): text tokens are ≥ 4.5:1 on `--rx-bg` and `--rx-surface`. Stroke and level tokens are ≥ 3:1 on `--rx-bg`, in both themes.

`--rx-level-advanced` is a new token. It is added to the docs only, and the app tokens are unchanged.
