<!--
Sync Impact Report
- Version change: (unversioned template) → 1.0.0
- Modified principles: template placeholders PRINCIPLE_1..5 replaced with eleven principles:
  I. Tenant Isolation Is Absolute; II. One Authorization Path;
  III. Modules Plug In, Infrastructure Doesn't Change; IV. The Database Is the Source of Truth;
  V. Side Effects Are Event-Driven; VI. Security by Default; VII. Tests Guard the Critical Paths;
  VIII. Simple Over Clever; IX. Clean Contracts; X. Observable, Without Leaking;
  XI. Original, Consistent UX
- Added sections: Architecture Constraints; Development Workflow & Quality Gates; Governance
- Removed sections: none
- Templates: plan/spec/tasks templates read this file at runtime; not modified by this command
- Follow-up TODOs: none
-->

# ReplyX Constitution

ReplyX is a multi-tenant customer support platform (help desk) whose domain structure is inspired
by Zammad. These principles are non-negotiable: every spec, plan, and task MUST comply with them.

## Core Principles

### I. Tenant Isolation Is Absolute

- Every tenant-owned record MUST belong to exactly one tenant.
- Isolation MUST be enforced in the backend data-access layer (tenant-scoped repositories and
  queries). It MUST NOT be enforced only in the UI or in controllers. Database-level isolation
  SHOULD be added as defense in depth where practical.
- Every access path MUST enforce tenant context: API requests, real-time connections, search,
  notifications, attachments, exports, background jobs, and webhooks.
- A request for another tenant's resource MUST behave exactly like a request for a resource that
  does not exist.

**Rationale**: A single cross-tenant leak is a security incident for every customer of the
platform. Enforcing isolation at the lowest shared layer makes it impossible to forget.

### II. One Authorization Path

- Authentication (who are you), tenant resolution (which tenant), and authorization (what may you
  do) MUST be separate steps.
- They MUST always run in this order: authenticate → resolve tenant → load user → check
  permission → check resource scope → business logic.
- All authorization decisions MUST go through one central policy service. Scattered, ad-hoc
  checks are forbidden.
- Permissions are the source of truth. No role, including Admin, may bypass the permission
  system through hard-coded logic.

**Rationale**: One path is auditable and testable. Scattered checks drift, and hard-coded
bypasses hide privilege from the permission model.

### III. Modules Plug In; Infrastructure Doesn't Change

- Adding a new resource or module MUST NOT require rewriting tenancy, authentication,
  authorization, audit, domain events, notifications, search, or API infrastructure.
- A new module declares its resources and actions and then automatically gets tenant scoping,
  registered permissions, audit logging, and standard API conventions.

**Rationale**: The product grows module by module. Cross-cutting guarantees must come for free,
or they will be skipped.

### IV. The Database Is the Source of Truth

- State MUST be persisted first, then published. Real-time delivery is a convenience, never the
  record.
- Clients MUST always be able to recover missed events after reconnecting.
- Operations that may be retried MUST be idempotent, including sending a message, delivering a
  notification, and delivering a webhook.

**Rationale**: Networks drop and clients retry. Messages must never be lost or duplicated.

### V. Side Effects Are Event-Driven

- Business logic MUST emit domain events (for example TicketCreated, TicketAssigned,
  MessageCreated, TicketClosed).
- Notifications, SLA tracking, automation, webhooks, search indexing, and analytics MUST consume
  those events rather than being called inline from business logic.
- Slow or external work MUST run in background jobs, never inside the user's request.

**Rationale**: Events decouple the core ticket model from its many consumers and keep user
requests fast.

### VI. Security by Default

- The following protections are REQUIRED:
  - secure password storage and secure sessions/tokens
  - authorization on every protected operation, including real-time subscriptions
  - input validation and output sanitization (XSS)
  - CSRF protection where applicable
  - rate limiting
  - safe file uploads with private access
  - protection against IDOR/BOLA and cross-tenant enumeration
- Security MUST live in the data model and service layer, not only in middleware.

**Rationale**: Help desks hold personal data and are internet-facing; protections must be the
default, not an add-on.

### VII. Tests Guard the Critical Paths

- Authorization, tenant isolation, the ticket lifecycle, and customer message routing MUST be
  covered by automated tests before they ship.
- Every new tenant-scoped resource MUST ship with cross-tenant isolation tests.
- The end-to-end customer ↔ agent conversation flow MUST be covered by an automated
  end-to-end test.

**Rationale**: These are the paths where a regression causes data leaks or lost customer
messages.

### VIII. Simple Over Clever

- The system MUST start as a modular monolith with clear domain boundaries that could be
  extracted later (see Architecture Constraints).
- Microservices or extra infrastructure MUST NOT be added without a documented reason.
- Prefer boring, well-understood technology.
- When requirements are ambiguous, choose the simplest production-ready option and record it as
  a decision with its trade-offs.

**Rationale**: Complexity is the main risk to a small team shipping a secure product.

### IX. Clean Contracts

- APIs MUST NOT expose storage models directly; they use explicit request/response schemas.
- APIs MUST validate all input and return one consistent error format.
- Customer-facing and staff-facing APIs MUST be kept separate where their rules differ.

**Rationale**: Explicit contracts stop internal fields leaking and let storage evolve safely.

### X. Observable, Without Leaking

- Structured logs MUST carry request, tenant, and user identifiers.
- Errors, background jobs, and real-time connections MUST be monitored.
- Passwords, tokens, and message content MUST NOT be logged unless strictly necessary.

**Rationale**: Operators need to diagnose problems per tenant without logs becoming a data leak.

### XI. Original, Consistent UX

- The UI MUST be an original design. It MUST NOT copy Zammad's look, layout, or interaction
  patterns.
- Both apps (agent/admin workspace and customer chat) MUST be built from a shared, reusable
  component system rather than one-off screens.
- Customers MUST never see internal ticketing concepts.

**Rationale**: Zammad informs the data model only. A consistent component system keeps both
experiences coherent as features grow.

## Architecture Constraints

- Domain boundaries of the modular monolith are: Identity, Tenancy, Authorization, Customers,
  Tickets, Messaging, Routing & Automation, Notifications, Groups, Views, Tags, Attachments, SLA,
  Audit, and Integrations.
- Modules communicate through their public interfaces and domain events, not through each
  other's storage.
- Any new infrastructure component (queue, cache, search engine, service) requires a recorded
  decision with its reason and trade-offs.

## Development Workflow & Quality Gates

- Every feature follows Spec Kit: specify → (clarify) → plan → tasks → implement.
- Every plan MUST include a Constitution Check against these principles; any deviation MUST be
  justified in writing in the plan's complexity tracking.
- Reviews MUST verify tenant scoping, central authorization, and the required tests
  (Principle VII) before a change is accepted.
- Commits MUST follow `docs/commit-guidelines.md`: one-line messages, one functionality change
  per commit, and no co-author or AI references.

## Governance

- This constitution overrides conflicting guidance in specs, plans, and tasks.
- Amendments MUST be documented with the reason and a version bump, using semantic versioning:
  MAJOR for removing or redefining a principle, MINOR for adding a principle or materially
  expanding guidance, PATCH for clarifications and wording.
- Compliance is checked at plan time (Constitution Check) and at review time; non-compliant work
  is not merged.

**Version**: 1.0.0 | **Ratified**: 2026-09-24 | **Last Amended**: 2026-09-24
