# Feature Specification: Product Documentation Site

**Feature Branch**: `003-product-docs-site` (spec directory; no git branch was created)

**Created**: 2026-10-11

**Status**: Draft

**Input**: User description: "i need a product documentation use fumadocs.dev to build, refer https://cards.flixlix.com/ this is the benchmark, it should have flow in home page, how decsion model routes the ticket to correct group, then how complexity is analysed and routed to the model this flow should be playing in home page, like a highend graphic design, generate high quality svgs and use that, it also should have dark and light mode system by default"

## Clarifications

### Session 2026-10-11

- Q: Should the new site replace the existing documentation site or sit beside it? → A: Replace it. All 21 existing pages move to the new site and the old site is removed.
- Q: Where does the home page live? → A: The docs home page is the public landing page at the bare product domain (https://replyx.example.com/), which serves the docs today. The new home page with the animated flow takes its place there.
- Q: Visual direction? → A: Keep the current ReplyX theme (logo, palette, brand accent). Use a neon treatment (glowing strokes and particles) only on AI elements: the decision model, the complexity analysis, and the model levels. Non-AI stages (intake, rules, groups, Needs Triage) use the regular theme.
- Q: How is the site served at the bare domain? → A: Through the host nginx on the VM, which can be changed as needed for this feature.

## Context

ReplyX already has a documentation site with 21 pages: guides, admin, developer, and operator pages. The owner wants a product documentation site that looks as polished as the benchmark (cards.flixlix.com). That benchmark has a clean docs layout and a landing page whose hero shows a live, animated flow diagram, with particles moving along paths between labelled nodes. The ReplyX home page should tell the AI story from spec 002 the same way, as an animation that plays on its own:

1. A customer message arrives as a new ticket.
2. Routing rules are checked first. If none match, the **decision model** reads the message, compares it with each group's AI description, and sends the ticket to the best group with a confidence score. If confidence is too low, the ticket stays in **Needs Triage**.
3. The **complexity analysis** scores the ticket with weighted factors: questions to the decision model (yes/no, choice, score) and fixed signals (customer tags, reopen count, SLA breach).
4. The total score falls into one of three bands, and the reply is prepared by the **Fast**, **Standard**, or **Advanced** model level. Most tickets go to the cheaper levels.

The owner chose the documentation framework (Fumadocs). The plan records it, and this spec does not depend on it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Home page shows how ReplyX AI routes and answers a ticket (Priority: P1)

A prospective customer, admin, or agent opens the documentation home page. Above the fold they see a large animated illustration. A ticket enters, passes the routing-rules check, reaches the decision model, and moves to one of several groups with a confidence badge. The animation then continues into the complexity analysis: factor gauges fill, a score builds up, and the ticket travels to one of the three model levels (Fast, Standard, Advanced). The loop then repeats with a different ticket. Over a few cycles the viewer sees a low-confidence ticket fall back to Needs Triage, and sees that most tickets end at Fast or Standard. Short captions name each stage, and each stage links to the docs page that explains it.

**Why this priority**: This is the centrepiece the owner asked for, and it is the first impression of the product. It explains the main AI value in seconds without reading.

**Independent Test**: Open the home page in a fresh browser and watch for 30 seconds without touching anything. Confirm that the flow plays without interaction, shows every stage (intake, rules check, decision model, groups, triage fallback, complexity factors, score, three model levels), loops seamlessly, and that every stage caption links to an existing docs page.

**Acceptance Scenarios**:

1. **Given** a visitor opens the home page, **When** it loads, **Then** the routing-and-complexity flow starts playing on its own within 1 second of the illustration appearing.
2. **Given** the flow is playing, **When** a full cycle completes, **Then** the viewer has seen a ticket routed to a group with a confidence value and then assigned a model level from a visible complexity score.
3. **Given** several cycles, **When** the visitor keeps watching, **Then** the cycles show different outcomes, including at least one Needs Triage fallback and at least one ticket at each model level, and Fast and Standard together appear more often than Advanced.
4. **Given** the visitor has turned on "reduce motion" in their operating system, **When** the home page loads, **Then** the illustration appears as a complete static diagram with all stages and captions visible, and nothing moves.
5. **Given** a visitor using a screen reader, **When** they reach the illustration, **Then** they hear a text description of the whole flow, and the decorative motion is not announced.
6. **Given** the visitor hovers over or focuses a stage, **When** they activate its link, **Then** they reach the matching docs page.
7. **Given** a phone-sized screen, **When** the home page loads, **Then** the flow is rearranged to read top to bottom, stays legible, and does not cause horizontal scrolling.

---

### User Story 2 - Light, dark, and system themes (Priority: P1)

A visitor opens the site. It follows their operating system's light or dark preference by default. A theme switch lets them choose Light, Dark, or System, and the choice is remembered on later visits. Every illustration, including the animated flow, the diagrams, and the logos, looks intentional in both themes, with no white boxes on dark pages and no washed-out lines on light pages.

**Why this priority**: The owner asked for it explicitly, and illustrations that break in one theme would undo the high-end look.

**Independent Test**: Switch the operating system between light and dark with the site open and confirm the site follows. Pick Light and then Dark manually, reload, and confirm the choice sticks. Check every page that has an illustration in both themes.

**Acceptance Scenarios**:

1. **Given** a first-time visitor whose system is in dark mode, **When** the site loads, **Then** it renders dark without a flash of the light theme.
2. **Given** the theme switch is set to System, **When** the operating system changes theme, **Then** the site follows without a reload.
3. **Given** the visitor picks Light or Dark, **When** they come back later, **Then** their choice is applied.
4. **Given** any illustration, **When** it is viewed in either theme, **Then** its colours come from that theme's palette and all text and lines meet contrast requirements.

---

### User Story 3 - All existing documentation available in the new site (Priority: P1)

Agents, admins, operators, and developers find every page that exists today (guides, admin, developer, operator) in the new site. Pages are grouped in a sidebar, can be searched, and use the same wording, so nothing is lost in the move. The new site replaces the existing documentation site; the old site is removed once every page has moved.

**Why this priority**: A good-looking site with missing content is a regression for current readers.

**Independent Test**: Compare the list of current pages with the new site's sidebar. Open each one and confirm the content, headings, and internal links are present and working. Search for three known terms and confirm the right pages come up.

**Acceptance Scenarios**:

1. **Given** the current set of documentation pages, **When** the new site is published, **Then** every page is reachable from the sidebar under a matching group (Guides, Admin, Developers, Operators).
2. **Given** a visitor types a term into search, **When** results appear, **Then** they include matching pages across all groups.
3. **Given** a page links to another page, **When** the visitor follows the link, **Then** it opens the right page. No broken internal links exist.
4. **Given** a visitor arrives at an old page address, **When** the page has moved, **Then** they are sent to its new location.

---

### User Story 4 - Concept pages explain routing and complexity with matching illustrations (Priority: P2)

An admin setting up AI wants more detail than the home page shows. From a home page caption or the sidebar they open "How AI routing works" and "How complexity picks a model". Each page uses still illustrations in the same visual language as the home page animation. For routing, they see rules first, then the decision model, the confidence threshold, and the Needs Triage fallback. For complexity, they see factor types with weights, the summed score, the two thresholds, and the three levels. Each illustration includes a worked example with numbers.

**Why this priority**: It turns the home page's promise into understanding admins can act on, but the site still works without it.

**Independent Test**: Open both concept pages and confirm that each has at least one illustration matching the home page style, a worked numeric example, and links to the related admin settings guide.

**Acceptance Scenarios**:

1. **Given** the routing concept page, **When** an admin reads it, **Then** they can say in which order rules and AI routing run, what the confidence threshold does, and when a ticket stays in Needs Triage.
2. **Given** the complexity concept page, **When** an admin reads the worked example, **Then** they can work out which model level a given set of factor answers leads to.
3. **Given** either page, **When** viewed in light or dark mode, **Then** the illustrations follow the theme as in User Story 2.

---

### User Story 5 - Product overview cards on the home page (Priority: P3)

Below the animated hero, the home page shows a grid of cards in the style of the benchmark's product cards. Each card has an icon or small illustration, a title, and a one-line summary for one of the main areas: Agent desk, Customer chat, AI assist, Routing & SLA, Administration, and Developers. Each card links to the start of that section.

**Why this priority**: It helps people get around the site, and the hero and docs work without it.

**Independent Test**: Confirm that each card links to an existing section start page and renders correctly in both themes and on a phone.

**Acceptance Scenarios**:

1. **Given** the home page, **When** a visitor clicks a card, **Then** they land on that section's first page.
2. **Given** a phone-sized screen, **When** the cards render, **Then** they stack into a single column without overflow.

---

### Edge Cases

- The visitor's browser has scripts disabled: the home page still shows the complete flow as a static illustration with captions, and all docs pages remain readable.
- The tab is hidden or the illustration is scrolled out of view: the animation pauses, and it resumes when visible, so it uses no processing power in the background.
- The visitor switches theme while the animation is playing: colours change in place without restarting or flickering.
- A very wide or very narrow screen: the illustration scales without clipped labels. Below phone width it switches to the vertical layout.
- A slow connection: the page layout does not shift when the illustration loads, and the hero area keeps its size from the start.
- The illustration's sample tickets, group names, and scores are made up. They must never look like real customer data, and they must not contradict the real defaults (confidence threshold 0.7, three levels).
- The product's AI behaviour changes later, for example by adding a level: the illustration and the concept pages are the documented places to update, and the flow must not hard-code wording that contradicts the docs.

## Requirements *(mandatory)*

### Functional Requirements

**Site and content**

- **FR-001**: The site MUST provide a home page, a sidebar of grouped documentation pages (Guides, Admin, Developers, Operators, and a new Concepts group), page-level table of contents, full-text search, and previous/next navigation between pages.
- **FR-002**: The site MUST carry over all 21 existing documentation pages with their wording, headings, and internal links intact, and MUST replace the existing documentation site. The old site MUST be removed once the new one is live.
- **FR-003**: Moved pages MUST stay reachable at their old addresses through redirects.
- **FR-004**: The site MUST include two new concept pages: "How AI routing works" and "How complexity picks a model". Their content MUST match the behaviour defined in spec 002 (rules first, AI routing only when no rule matched, active groups with an AI description only, default confidence threshold 0.7, Needs Triage fallback, question and fixed-signal factors with weights, two thresholds, three levels, Fast used when complexity is not set up or fails).

**Animated home page flow**

- **FR-005**: The home page hero MUST show an animated illustration of the full flow: ticket intake → routing rules check → decision model → group selection with confidence (or Needs Triage fallback) → complexity factors → weighted score → model level (Fast / Standard / Advanced).
- **FR-006**: The animation MUST start on its own, loop continuously, and vary outcomes across cycles as described in User Story 1, scenario 3.
- **FR-007**: Each stage MUST have a short visible caption, and each caption MUST link to the docs page that explains it.
- **FR-008**: All illustrations MUST be scalable vector graphics made for ReplyX: original artwork in a consistent visual language (shared stroke weights, corner radii, node shapes, iconography, and palette). Stock clip-art and raster images are not allowed. The illustrations MUST stay sharp at any zoom level.
- **FR-009**: The animation MUST respect the operating system's reduce-motion setting by showing a complete static version instead.
- **FR-010**: The animation MUST pause when not visible (tab hidden or scrolled away) and resume when visible again.
- **FR-011**: The illustration MUST have a text alternative that describes the whole flow in order. Purely decorative motion MUST be hidden from assistive technology.
- **FR-012**: On phone-sized screens the flow MUST switch to a vertical layout that keeps every stage legible.

**Theming**

- **FR-013**: The site MUST support Light, Dark, and System themes, with System as the default for first-time visitors, and MUST remember a manual choice.
- **FR-014**: The site MUST apply the stored or system theme before first paint, so there is no flash of the wrong theme.
- **FR-015**: Every illustration MUST take its colours from the active theme and change when the theme changes, including mid-animation.
- **FR-016**: The site's colours and brand accent MUST match the current ReplyX theme (logo, favicon, theme colour) so the docs feel like part of the same product.
- **FR-016a**: AI elements in illustrations (decision model, complexity analysis, model levels, and the paths between them) MUST use a neon treatment (glowing strokes and particles) built from theme colours. Non-AI elements MUST NOT use it. The glow MUST stay legible and meet contrast requirements in light mode as well as dark.

**Quality**

- **FR-017**: All pages, including the home page, MUST meet WCAG 2.2 AA in both themes: contrast, keyboard access, visible focus, and landmarks.
- **FR-018**: The home page MUST stay usable with scripts disabled, showing the static flow and all navigation.
- **FR-019**: The site MUST be built and served the same way as the other ReplyX apps (containerised, deployable to the owner's VM alongside the product).
- **FR-020**: The home page MUST be served at the root of the bare product domain (https://replyx.example.com/), where the docs home page is served today. Tenant, console, and customer addresses MUST keep working unchanged.
- **FR-021**: The site MUST work under the production security headers already used for ReplyX (for example, no scripts from other origins), or any change to those headers MUST be limited to the docs site and recorded as a decision.

### Key Entities

- **Docs Page**: a titled page in one sidebar group, with an order, a summary, and an optional old address to redirect from.
- **Flow Stage**: one step of the home page flow, with a caption, a target docs page, and its illustrated element.
- **Flow Scenario**: one animated cycle, made up of a sample message (fictional), its routing outcome (group with confidence, or Needs Triage), its factor answers, its score, and its model level. A fixed set of scenarios makes up the loop.
- **Illustration**: a vector artwork used on the home page or a concept page, drawn with the shared palette and taking its colours from the theme.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a hallway test, at least 4 out of 5 people who watch the home page for 30 seconds can correctly explain, unprompted, that tickets are routed to a group by the decision model and that a complexity score picks a cheaper or stronger model.
- **SC-002**: The home page's main content and illustration are visible within 2.5 seconds on a typical mobile connection, and the layout does not visibly jump while loading.
- **SC-003**: The animation runs smoothly (no visible stutter) on a mid-range laptop and phone, and uses no noticeable processing power while the tab is hidden.
- **SC-004**: 100% of existing documentation pages are reachable in the new site, and an automated link check finds zero broken internal links.
- **SC-005**: Automated accessibility checks report zero serious or critical issues on the home page and on every concept page, in both light and dark themes.
- **SC-006**: All illustrations pass a visual review in both themes: no hard-coded backgrounds, all text and lines meet contrast requirements, and no wrong-theme flash occurs on load.
- **SC-007**: The owner signs off that the home page and docs layout match or exceed the polish of the benchmark site.
- **SC-008**: After release, https://replyx.example.com/ shows the new home page with the animated flow, and no address of the old docs site returns an error.

## Assumptions

- The illustrated flow is a product explanation, not a live demo. It uses fictional sample tickets and group names and does not connect to any ReplyX tenant or AI provider.
- The flow shows model levels by name (Fast, Standard, Advanced), not specific vendor model names, because models are configurable per tenant and may change. The decision model is shown as "Decision model", with no version.
- English only for this release, like the current docs.
- The current docs writing style (plain, short sentences, task-focused) is kept. The `docs-style` guidance will be updated to describe the new site instead of the old one.
- The generated API reference, if any, is out of scope beyond carrying over existing developer pages.
- Out of scope: blog, versioned docs, localisation, analytics, a marketing site separate from the docs, interactive playgrounds, and video.
