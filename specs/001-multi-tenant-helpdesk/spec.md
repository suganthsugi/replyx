# Feature Specification: Multi-Tenant Customer Support Platform

**Feature Branch**: `001-multi-tenant-helpdesk` (spec directory; no git branch was created)

**Created**: 2026-09-24

**Status**: Draft

**Input**: User description: "Build a multi-tenant customer support platform ("help desk") with two experiences: an agent/admin workspace for support teams and a simple chat-style experience for customers. Every piece of business data belongs to exactly one tenant, and no tenant can ever see, infer, or affect another tenant's data. The domain is inspired by Zammad (tenants, users, roles, permissions, groups, tickets, ticket states, views), but the user interface is an original, modern design that does not copy Zammad." (Full description: `2-speckit-specify.md`.)

## Clarifications

### Session 2026-09-24

- Q: Should platform operators be able to see a tenant's tickets, messages, and customer data? → A: Only when a tenant admin grants temporary, time-limited support access. Access is read-only and every action is logged in that tenant's audit log.
- Q: How should customers sign in to the chat? → A: Customers sign in with a one-time email link and can optionally set a password; staff use email and password.
- Q: Should staff be able to start a new conversation with a customer themselves? → A: Yes, for existing customers. Staff with create access on a group can start a ticket with a public message, and it shows up in the customer's chat.
- Q: What accessibility standard should both apps meet? → A: WCAG 2.2 Level AA for both the customer chat and the agent workspace.
- Q: How long should tenant data be kept? → A: Keep everything by default. Each tenant can set an automatic deletion period for closed tickets and their attachments; the audit log is kept for at least 1 year.

## User Scenarios & Testing *(mandatory)*

Stories are ordered by priority. P1 stories together make up the MVP; each story can still be demonstrated and tested on its own once the stories it builds on exist.

### User Story 1 - Customer gets help through a single chat (Priority: P1)

A customer signs in to their organization's support page, types "My order has not arrived", and presses Send. They never pick a category, write a subject, or see a ticket number. Behind the scenes a ticket is created and staff are alerted. When an agent replies, the reply appears in the same chat without a refresh, with the agent's name, avatar, and a typing indicator. Past issues stay in the same scrolling thread, separated by a friendly "resolved" marker.

**Why this priority**: The customer chat is the product's promise to customers. Without it there is nothing to support.

**Independent Test**: Sign in as a customer, send a message, confirm a ticket exists for staff, reply as staff, and confirm the customer sees the reply live, with no ticket terminology anywhere in the customer experience.

**Acceptance Scenarios**:

1. **Given** a signed-in customer with no previous tickets, **When** they write "My order has not arrived" and press Send, **Then** a new ticket is created with a title generated from the message, the chat shows a plain-language status such as "Support has your message", and staff with access are notified in real time.
2. **Given** a customer with an active (new, open, or pending) ticket, **When** they send another message, **Then** it is added to that same ticket and the ticket moves to (or stays) open.
3. **Given** an agent is typing a reply, **When** the customer has the chat open, **Then** the customer sees a typing indicator with the agent's name, and then the reply without refreshing.
4. **Given** the customer has the chat open on a phone and a laptop, **When** a message is sent or received on either, **Then** both show the same thread, including delivery and read status.
5. **Given** any state of the customer's tickets, **When** the customer views the chat, **Then** they never see ticket numbers, states, groups, priorities, owners, SLA information, or internal notes.
6. **Given** the tenant has business hours and an out-of-hours message configured, **When** a customer opens the chat outside business hours, **Then** they see that message and can still send.
7. **Given** a customer is offline when an agent replies, **When** the reply is sent, **Then** the customer is notified through the channel the tenant has configured.

---

### User Story 2 - Tenant isolation and tenant lifecycle (Priority: P1)

The platform operator creates a tenant with a name and a unique identifier used in its URL, invites its first admin, and can later suspend or reactivate it. Each tenant is fully sealed off: no user, request, real-time update, search result, notification, attachment link, webhook, or background job ever crosses from one tenant to another.

**Why this priority**: Isolation is a hard guarantee of a multi-tenant product. A single leak is a security incident.

**Independent Test**: Create two tenants with overlapping data (same customer email, same ticket numbers). Try every resource type and access path as users of Tenant A and confirm nothing from Tenant B is ever returned, changed, or hinted at.

**Acceptance Scenarios**:

1. **Given** the platform operator, **When** they create a tenant with a name and unique identifier and invite an admin email, **Then** the tenant exists with status active, its four system roles, the Ungrouped entry, and the default views, and the invited person can become its admin.
2. **Given** users in Tenant A and Tenant B, **When** a Tenant A user tries to reach any Tenant B resource by any means (including a guessed identifier), **Then** they receive "not found" with no hint that the resource exists.
3. **Given** the same email address registered in both tenants, **When** that person signs in to each tenant, **Then** they are two separate users with separate histories.
4. **Given** an active tenant with connected users, **When** the operator suspends it, **Then** all its sessions end, its staff cannot sign in, its customers see a friendly "support is unavailable" message, and no data is deleted.
5. **Given** a suspended tenant, **When** the operator reactivates it, **Then** its users can sign in again and all data is intact.
6. **Given** a platform operator with no active support-access grant, **When** they try to open any of the tenant's tickets, messages, or customer records, **Then** access is denied.
7. **Given** a tenant admin grants support access for 24 hours, **When** the operator views a ticket, **Then** they can read it but not change it, the view is recorded in the tenant's audit log, and access ends automatically after 24 hours or as soon as the admin revokes it.

---

### User Story 3 - Sign-in and user management (Priority: P1)

Staff are invited by email and set their password. Customers sign up themselves (when the tenant allows it) or are invited, and sign in with a one-time link sent to their email; they can optionally set a password. Everyone with a password can reset it, sign out of all sessions, and manage their own profile. Admins see each user's status and last sign-in, and can deactivate users without losing history.

**Why this priority**: Nobody can use either experience without accounts and secure sign-in.

**Independent Test**: Invite an agent, accept the invitation, sign in, reset the password, get locked out by repeated failed attempts, deactivate the user, and confirm sign-in is blocked but their history remains.

**Acceptance Scenarios**:

1. **Given** a user with permission to create users, **When** they invite a staff member by email with one or more roles, **Then** the invitee receives an invitation, sets a password, and signs in with exactly those roles.
2. **Given** a tenant that allows self-registration, **When** a new customer signs up with an email not yet used in that tenant, **Then** their account is created with the Customer role, they receive a one-time sign-in link, and after opening it they can start chatting right away.
3. **Given** a tenant that does not allow self-registration, **When** someone tries to sign up, **Then** they are told to contact the organization and no account is created.
4. **Given** repeated failed sign-in attempts on one account, **When** the threshold is reached, **Then** the account is temporarily locked, the user sees a clear message, and the event is recorded in the audit log.
5. **Given** a user signed in on several devices, **When** they choose "sign out of all sessions", **Then** every session ends at once.
6. **Given** an agent who owns open tickets, **When** an admin deactivates them, **Then** they cannot sign in, their active sessions end, their tickets become unassigned, and their past messages and history remain.
7. **Given** a user with no history, **When** an admin deletes them, **Then** the user is removed. **Given** a user with history, **When** an admin tries to delete them, **Then** they are offered deactivation or the explicit data-erasure action instead.

---

### User Story 4 - Roles, permissions, and group access (Priority: P1)

An admin creates custom roles such as "Support Agent" and, in the role editor, sets the role's permissions and a matrix of groups × ticket actions (view, create, edit, delete), including the built-in Ungrouped entry. Users hold one or more roles and get the combination of all of them. Changes apply immediately, even to users who are already signed in.

**Why this priority**: Every other staff capability depends on this model deciding who may see and do what.

**Independent Test**: Create a role with view and edit on Support only, assign it to a user, and confirm the user can work Support tickets and sees nothing from other groups. Remove edit while the user is connected and confirm further changes are blocked at once.

**Acceptance Scenarios**:

1. **Given** a new tenant, **When** an admin opens the role editor, **Then** the four system roles exist (Customer, Agent, Manager, Admin), cannot be deleted, and have the documented default access.
2. **Given** an admin grants a role view and edit on the Support group, **When** a user with that role signs in, **Then** they can view and edit Support tickets and cannot see or act on tickets in any other group or on ungrouped tickets.
3. **Given** that user is signed in and viewing a Support ticket, **When** the admin removes edit on Support from the role, **Then** the user can no longer reply, add notes, or change fields, without having to sign in again.
4. **Given** the user owns Support tickets, **When** they lose edit on Support, **Then** they are removed as owner of those tickets and the tickets become unassigned.
5. **Given** a new module is added to the product, **When** an admin opens the role editor, **Then** the module's permissions appear automatically, granted to Admin and denied to every other role.
6. **Given** a custom role held by at least one user, **When** an admin tries to delete it, **Then** deletion is refused with an explanation.
7. **Given** a new group is created, **When** it is saved, **Then** only Admin has access to it until an admin grants access to other roles.
8. **Given** a customer, **When** they try to open the agent workspace or any staff-only function, **Then** access is denied.

---

### User Story 5 - Triage of ungrouped tickets (Priority: P1)

A manager opens the Needs Triage view, sees new tickets that no routing rule placed in a group, and assigns one to Support (optionally with an owner, priority, and tags) in as few steps as possible. The ticket leaves Needs Triage, appears in Support's Unassigned & Open, and Support staff are notified.

**Why this priority**: Without triage, tickets that match no rule would never reach a team.

**Independent Test**: Create an ungrouped ticket, triage it as a manager into a group the manager cannot otherwise access, and confirm it moves between views, the manager loses sight of it, and the group's staff are notified.

**Acceptance Scenarios**:

1. **Given** a new ticket that matched no routing rule, **When** it is created, **Then** it appears in Needs Triage within 2 seconds for every connected user with view on Ungrouped.
2. **Given** a manager with edit on Ungrouped, **When** they assign an ungrouped ticket to the Support group, **Then** it leaves Needs Triage, appears in Unassigned & Open for users who can view Support, and those users are notified.
3. **Given** the manager has no access to Support, **When** they finish triaging a ticket into Support, **Then** the ticket disappears from their lists and any open screen showing it.
4. **Given** a triage user choosing an owner, **When** they pick from the owner list, **Then** only active users whose roles grant edit on the chosen group are offered.
5. **Given** no one with triage access is online, **When** ungrouped tickets arrive, **Then** they collect visibly in Needs Triage, and admins can always see them.
6. **Given** two managers triaging the same ticket at the same time, **When** both submit, **Then** exactly one change takes effect and the other manager is clearly told the ticket was already triaged.

---

### User Story 6 - Agents work the conversation (Priority: P1)

An agent opens a ticket from one of their views, sees the full conversation, properties, and history, and a basic customer profile. They take ownership, reply to the customer, add internal notes that @mention teammates, change state, priority, or group, and add tags, all subject to their group access. Everything updates live for everyone watching.

**Why this priority**: This is the core daily work of support staff.

**Independent Test**: As an agent with edit on a group, open a ticket, assign it to yourself, reply, add an internal note with an @mention, and change priority. Confirm the customer sees only the reply, the mentioned teammate is notified, and each change appears in the ticket history.

**Acceptance Scenarios**:

1. **Given** an agent with edit on a ticket's group, **When** they assign the ticket to themselves and reply, **Then** the customer sees the reply live and the ticket's state changes from new to open.
2. **Given** an agent adds an internal note, **When** it is saved, **Then** other staff who can view the group see it live, and the customer neither sees it nor is notified.
3. **Given** a note that @mentions a teammate, **When** it is saved, **Then** the teammate is notified, provided they can view the ticket.
4. **Given** any change to a ticket (owner, state, priority, group, tags, messages), **When** it is saved, **Then** the ticket history records who changed what and when.
5. **Given** an agent sets a ticket to pending reminder with a date, **When** the date is reached, **Then** the ticket appears in the owner's "My Pending Reminders Reached" view and the owner is notified.
6. **Given** an agent sets a ticket to pending close with a date, **When** the date passes with no customer message, **Then** the ticket closes automatically. If the customer writes first, the ticket returns to open.
7. **Given** an agent opens the customer's profile from a ticket, **When** it loads, **Then** they see the customer's name, email, tags, and previous tickets they have access to.
8. **Given** an agent attaches a file of a disallowed type or over the size limit, **When** they try to send, **Then** the file is rejected with a clear message saying why.
9. **Given** a ticket is linked to another as follow-up of, related, or duplicate, **When** either ticket is viewed by staff with access, **Then** the link is shown.
10. **Given** an agent with create access on the Support group and an existing active customer, **When** the agent starts a new ticket in Support with a title and a public message, **Then** the ticket is created in Support with state open and waiting on customer, it skips routing, the message appears in the customer's chat like any other reply, and the customer is notified if offline.

---

### User Story 7 - Resolution, grace period, and returning customers (Priority: P1)

An agent resolves a ticket and the customer sees a friendly marker in the chat. If the customer replies within the tenant's grace period (default 3 days), the same ticket reopens with its group and owner. After the grace period the ticket closes, and a later message follows the tenant's setting: by default a new, linked follow-up ticket is created silently and goes through routing.

**Why this priority**: Customers return. How their next message is handled decides whether the conversation feels continuous and whether work gets lost.

**Independent Test**: Resolve a ticket, reply within the grace period (same ticket reopens), let the period elapse (ticket closes), then send again and confirm a new follow-up ticket is created and linked while the customer sees one continuous thread.

**Acceptance Scenarios**:

1. **Given** an open ticket, **When** an agent resolves it, **Then** the customer's chat shows a friendly resolved marker such as "Glad we could help, just reply if you need anything else".
2. **Given** a resolved ticket within the grace period, **When** the customer replies (even just "thanks"), **Then** the same ticket reopens with its group and owner kept, and an agent can re-resolve it in one action.
3. **Given** a resolved ticket, **When** the grace period ends with no customer reply, **Then** the ticket closes automatically.
4. **Given** a customer whose last ticket is closed and the tenant uses the default setting, **When** they send a message, **Then** a new ticket is created silently, linked as a follow-up of the previous one, and routed like any new ticket.
5. **Given** the same customer and a tenant set to "reopen previous ticket", **When** they send a message, **Then** the previous ticket reopens instead.
6. **Given** a customer message arrives at the same moment their resolved ticket auto-closes, **When** both are processed, **Then** the message lands on exactly one ticket and is never lost or duplicated.
7. **Given** a customer with more than one active ticket (for example after a split), **When** they send a message, **Then** it attaches to the most recently updated active ticket, and an agent can move it to another of the customer's tickets.

---

### User Story 8 - Default views, real-time updates, and in-app notifications (Priority: P1)

Staff see the default views with live counts, filter and sort ticket lists, and get an in-app notification center with an unread count. Everything (new tickets, messages, assignments, state changes, counts) updates without refreshing, and nothing is lost while a user is disconnected.

**Why this priority**: Support teams cannot respond quickly if they must refresh to find work.

**Independent Test**: With two staff users and a customer connected, create and change tickets. Confirm view counts and lists update live for both staff, notifications arrive once each, and a staff member who was offline sees everything they missed when they return.

**Acceptance Scenarios**:

1. **Given** a new tenant, **When** staff open the workspace, **Then** they see the default views they are allowed to see (Needs Triage only for users with access to Ungrouped), each with a live count.
2. **Given** a view is open, **When** a ticket starts or stops matching it, **Then** the list and count update within 2 seconds without refreshing.
3. **Given** a customer sends several messages before any agent replies, **When** they are processed, **Then** all land on the same ticket and staff get one "new ticket" notification, not one per message.
4. **Given** a user performs an action, **When** notifications are generated, **Then** that user is not notified about their own action.
5. **Given** a user has the workspace open on two devices, **When** they mark a notification as read on one, **Then** it shows as read on the other immediately.
6. **Given** a user loses connection and reconnects, **When** the connection returns, **Then** every message and notification they missed is delivered exactly once.
7. **Given** a user is offline, **When** they next sign in, **Then** all notifications they missed are waiting in the notification center.

---

### User Story 9 - Audit log (Priority: P1)

Admins with permission open an append-only audit log, filter it by actor, action, resource, and time, and see a record of ticket events and security and configuration events.

**Why this priority**: Accountability and incident investigation require a trustworthy record from day one.

**Independent Test**: Perform a ticket assignment, a failed sign-in, and a role permission change, then confirm each appears in the audit log with actor, action, resource, time, and details, and that no one can edit or delete entries.

**Acceptance Scenarios**:

1. **Given** audited events happen (ticket created, assigned, reassigned, state, priority, or group changed, message or note added, merged, split, or deleted; sign-ins and failed sign-ins; user, role, permission, group-access, tenant-setting, and webhook changes), **When** an admin with permission opens the audit log, **Then** each event is listed with actor, action, resource, time, and relevant details.
2. **Given** any user, including admins, **When** they try to change or delete an audit entry, **Then** they cannot.
3. **Given** a user without audit log permission, **When** they look for the audit log, **Then** it is not shown and cannot be reached.

---

### User Story 10 - Custom view builder (Priority: P2)

A manager builds a view from conditions (state, priority, group including "ungrouped", owner including "me" and "unassigned", customer, tags, waiting on, created, updated, and last-customer-message time, SLA status) combined with AND/OR groups, chooses the sort order and columns, and shares it with all staff, specific roles, or specific groups. Agents can make personal views.

**Why this priority**: Default views cover the basics, and teams need their own work queues as they grow.

**Independent Test**: Build a view with three conditions, share it with one role, and confirm members of that role see it with the correct tickets, and never tickets outside their group access.

**Acceptance Scenarios**:

1. **Given** a user with view permissions, **When** they create a view with three conditions and share it with a role, **Then** it takes under one minute and users with that role see it with a live count.
2. **Given** a shared view whose conditions match tickets in groups a viewer cannot access, **When** that viewer opens it, **Then** those tickets are excluded from both list and count.
3. **Given** an agent, **When** they create a personal view, **Then** only they can see it.
4. **Given** an admin, **When** they edit, hide, or reorder a default view, **Then** the change applies to everyone the view is shared with.

---

### User Story 11 - Routing rules (Priority: P2)

An admin defines ordered routing rules that run when a new ticket is created. A rule matches words or phrases in the first message or customer attributes (tags, email domain) and sets the group, and optionally the priority and tags. The first matching rule wins; otherwise the ticket stays ungrouped.

**Why this priority**: Routing removes most manual triage, but triage alone is enough for the MVP.

**Independent Test**: Create two overlapping rules and send customer messages that match one, both, and neither. Confirm the first matching rule wins and unmatched tickets go to Needs Triage.

**Acceptance Scenarios**:

1. **Given** a rule "message contains 'refund' → group Billing, tag refund", **When** a customer's first message says "I want a refund", **Then** the new ticket is placed in Billing with the tag refund.
2. **Given** two rules that both match, **When** a ticket is created, **Then** only the higher-ordered rule is applied.
3. **Given** no rule matches, **When** a ticket is created, **Then** it stays ungrouped and appears in Needs Triage.
4. **Given** a rule targets a group that has since become inactive, **When** it would match, **Then** it is skipped and the ticket continues to the next rule or to Needs Triage.

---

### User Story 12 - SLA policies, business hours, and the dashboard (Priority: P2)

An admin sets business hours and SLA policies with first-response, next-response, and resolution targets and a warning threshold, applied by conditions such as priority or group. Tickets show time remaining; warnings and breaches feed the Escalated view, notifications, and a live dashboard of operational numbers.

**Why this priority**: SLAs make response commitments visible, but the core help desk works without them.

**Independent Test**: Create an "urgent: first response 15 minutes" policy, create an urgent ticket, let the warning and breach thresholds pass, and confirm the countdown, the Escalated view, the notifications, and the dashboard all reflect it.

**Acceptance Scenarios**:

1. **Given** a policy "urgent: first response 15 minutes, resolution 4 hours", **When** an urgent ticket is created, **Then** the ticket shows time remaining for each target, counted from creation (including time spent ungrouped) and measured in business hours.
2. **Given** a ticket reaches its warning threshold or breaches, **When** that happens, **Then** it appears in the Escalated view and subscribed users receive an SLA warning or breach notification.
3. **Given** a staff user, **When** they open the dashboard, **Then** they see live counts (open, ungrouped, unassigned, waiting on customer, waiting on support, urgent, SLA breaches, created and resolved today), average first-response and resolution times, and satisfaction score, computed only from tickets they can access.

---

### User Story 13 - Search (Priority: P2)

Staff search across ticket number, customer name and email, ticket title, message content, and tags, and see only results they are allowed to access.

**Why this priority**: Search speeds up work but is not needed to handle incoming tickets.

**Independent Test**: Search for a term that appears in tickets across several groups and in another tenant, and confirm only tickets in the searcher's accessible groups within their tenant are returned.

**Acceptance Scenarios**:

1. **Given** a ticket whose message contains "invoice 4471", **When** a user with access to its group searches "4471", **Then** the ticket appears in the results.
2. **Given** the same search by a user without access to that group, **When** it runs, **Then** the ticket does not appear and nothing hints that it exists.

---

### User Story 14 - Agent productivity: macros, merge/split, collision awareness, availability (Priority: P2)

Agents apply macros that insert a reply and set fields in one action, merge duplicate tickets, split a message into a new ticket, see which teammates are viewing or typing on the same ticket, and set themselves as online, away, or offline.

**Why this priority**: These features save time and prevent duplicate work, but agents can work without them.

**Independent Test**: Apply a macro that inserts text and sets state, merge two tickets, split a message out, and open one ticket as two agents to confirm each sees the other's presence and typing.

**Acceptance Scenarios**:

1. **Given** a macro "Refund issued" that inserts a reply, adds tag refund, and sets state resolved, **When** an agent applies it, **Then** all three effects happen in one action and are recorded in history.
2. **Given** two tickets from the same customer in groups where the agent has edit and merge permission, **When** the agent merges them, **Then** one ticket contains the combined conversation, the other is marked as merged into it, and the customer's thread shows no duplicate messages.
3. **Given** a message on a ticket, **When** an agent with split permission splits it, **Then** a new ticket is created with that message and linked to the original.
4. **Given** two agents with the same ticket open, **When** one starts typing, **Then** the other sees who is viewing and who is typing.
5. **Given** two agents replying to, assigning, or triaging the same ticket at the same time, **When** both submit, **Then** both replies are kept in order, and for conflicting field changes the later one wins with no silent data loss; each agent sees the result live.

---

### User Story 15 - Notification preferences, desktop and email notifications (Priority: P2)

Users choose which events notify them and through which channels (in-app, desktop, email), with a master switch. Tenants set the defaults.

**Why this priority**: In-app notifications cover the MVP. Other channels and fine-grained preferences reduce noise and missed work.

**Independent Test**: Turn off email for "ticket assigned to me" but keep desktop on, assign a ticket to that user, and confirm a desktop notification but no email.

**Acceptance Scenarios**:

1. **Given** a user who has granted desktop permission and enabled an event, **When** that event happens, **Then** they receive a desktop notification.
2. **Given** a user turns off the master switch, **When** events happen, **Then** they receive no desktop or email notifications. In-app entries are still recorded in the notification center but produce no alerts.
3. **Given** a burst of customer messages on one ticket, **When** notifications are sent, **Then** the user gets one grouped notification per channel, and the same event never produces duplicates.

---

### User Story 16 - Satisfaction ratings and full customer profile (Priority: P2)

When a ticket is resolved, the customer can optionally leave a quick rating in the chat. Staff see a full customer profile: contact details, tags, open and closed tickets, and full conversation history.

**Why this priority**: Satisfaction and full profiles add insight but are not required to resolve issues.

**Independent Test**: Resolve a ticket, rate it as the customer, and confirm the rating appears on the ticket, in the customer profile, and in the dashboard satisfaction score.

**Acceptance Scenarios**:

1. **Given** a ticket was just resolved, **When** the customer views the chat, **Then** they are offered an optional quick rating that they can skip.
2. **Given** a staff user with the right access, **When** they open a customer's profile, **Then** they see contact details, tags, open and closed tickets, and the full conversation history they are allowed to see.

---

### User Story 17 - Automation rules (Priority: P3)

Admins define rules: when an event occurs (ticket created, ticket updated, message received, time elapsed) and the conditions match, perform actions (set group, owner, priority, state, or tags; send an auto-reply to the customer; notify users).

**Why this priority**: Automation is valuable for mature teams but not needed for launch.

**Independent Test**: Create a rule "ticket waiting on customer for 2 days → send reminder auto-reply and set pending close", let 2 days elapse, and confirm both actions ran exactly once.

**Acceptance Scenarios**:

1. **Given** a rule whose event and conditions match, **When** the event occurs, **Then** its actions run and are recorded in the ticket history as performed by the rule.
2. **Given** a rule whose own action would match its own conditions again, **When** it runs, **Then** its own changes do not trigger it again.

---

### User Story 18 - Webhooks (Priority: P3)

Admins configure webhook endpoints with a signing secret, an on/off switch, and chosen events (ticket created, ticket updated, message created, ticket assigned, ticket closed). Deliveries are signed, retried on failure, and visible in a delivery history.

**Why this priority**: Integrations matter for some tenants but not for core support.

**Independent Test**: Configure an endpoint for "ticket created" that fails twice and then succeeds, create a ticket, and confirm the signed delivery arrives, the retries appear in the delivery history, and only this tenant's events are sent.

**Acceptance Scenarios**:

1. **Given** an enabled endpoint subscribed to "ticket created", **When** a ticket is created in that tenant, **Then** a signed delivery is sent to the endpoint and recorded in its history.
2. **Given** the endpoint fails, **When** delivery is attempted, **Then** it is retried with increasing delays, and each attempt and its outcome appear in the delivery history.
3. **Given** an endpoint is switched off, **When** events occur, **Then** nothing is sent to it.

---

### Edge Cases

**Messages and tickets**

- A customer sends several messages before any agent replies: all land on the same ticket, with one "new ticket" notification.
- A customer taps Send twice, or a flaky connection retries: the message appears exactly once.
- A customer message arrives at the same moment a resolved ticket auto-closes: it lands on exactly one ticket, never lost or duplicated.
- A customer replies just "thanks" to a resolved ticket: it reopens, and an agent can re-resolve it in one action.
- A customer floods messages: further sends are rate-limited with a friendly message, and no accepted message is lost.
- Two agents reply to, assign, or triage the same ticket at the same time: both replies are kept, and conflicting field changes resolve predictably without silent loss.
- An attachment is too large or of a disallowed type: it is rejected with a clear message.
- An attachment has not yet passed the malware-scanning step: it is shown as "processing" and cannot be opened until cleared. If it is flagged, it is blocked and the sender is told.
- Staff start a ticket for a customer who already has an active ticket: both tickets exist, and the customer's next message goes to the most recently updated one (FR-050).
- A closed ticket reaches the tenant's retention period while it is linked to a newer ticket as follow-up: the old ticket is deleted, and the newer ticket shows that its linked ticket was removed by retention.
- A customer writes after their last ticket was purged by retention: a new ticket is created with no follow-up link.
- Staff try to start a ticket for a deactivated customer or in an inactive group: the action is refused with a clear reason.
- A ticket is deleted: its messages disappear from the customer's thread, and the deletion is recorded in the audit log.

**Access and permissions**

- No one with triage access is online: ungrouped tickets still accumulate visibly in Needs Triage. Admins always have access, so no ticket is ever invisible to everyone.
- A triage user assigns a ticket to a group they cannot access: it immediately disappears from their lists and open screens.
- A role loses access to a group while its users are viewing those tickets: access ends immediately.
- An agent who owns tickets is deactivated: their tickets become unassigned.
- A group is deleted or made inactive: deletion requires moving its tickets first; an inactive group keeps its tickets but receives no new or moved ones.
- A user guesses an identifier for another tenant's resource, or for a ticket outside their access: they get "not found", with no hint that it exists.
- A customer tries to open the agent workspace or staff-only functions: access is denied.
- A tenant is suspended while its users are connected: their sessions end.
- An admin tries to remove Admin's full access or delete a system role: the change is refused.
- A user holds several roles with different access to the same group: they get the combination (the most permissive set of actions) across their roles.

**Connectivity**

- An agent or customer loses connection and reconnects: no messages or notifications are missing or duplicated.
- A customer has the chat open in several tabs: every tab stays in sync, and a message sent from one appears once in all.

## Requirements *(mandatory)*

### Functional Requirements

#### Tenants and isolation

- **FR-001**: Platform operators MUST be able to create tenants with a name, a unique URL identifier, and an initial admin invitation; and to suspend, reactivate, and configure tenants. Platform operators belong to no tenant.
- **FR-001a**: Platform operators MUST NOT be able to see a tenant's tickets, messages, attachments, or customer data unless a tenant admin has granted support access. A grant MUST be time-limited (the admin chooses the duration, up to a maximum of 7 days), read-only, and revocable by the admin at any time, and it MUST end automatically when it expires. Every grant, revocation, expiry, and every operator action under a grant MUST be recorded in that tenant's audit log, visible to the tenant's admins.
- **FR-002**: Every piece of business data MUST belong to exactly one tenant. No user, request, real-time update, search result, notification, attachment link, webhook delivery, scheduled job, or report may read, reveal, or change another tenant's data.
- **FR-003**: Requests for resources in another tenant, or outside the requester's access, MUST get the same "not found" response as a resource that does not exist.
- **FR-004**: Suspending a tenant MUST end all its active sessions, block staff sign-in, show customers a friendly "support is unavailable" message, pause its outgoing webhooks and notifications, and delete no data.
- **FR-005**: Each tenant MUST have settings for: name, logo, colors, and chat welcome message; timezone and business hours; customer self-registration on/off; resolved-ticket grace period (default 3 days); behavior when a customer writes after closure (create new follow-up ticket, the default, or reopen the previous ticket); offline customer notification on/off and channel; and an optional out-of-hours chat message.
- **FR-005a**: Tenant data MUST be kept indefinitely by default. Tenant admins MUST be able to set a retention period (between 1 and 7 years after closure, or "keep forever") after which closed tickets, their messages, and their attachments are permanently deleted automatically. The deletion MUST also remove those messages from the customer's chat thread, MUST NOT affect tickets that are not closed, and MUST record in the audit log how many tickets were purged and when (without their content). Audit log entries MUST be kept for at least 1 year; tenants MAY choose a longer audit retention.
- **FR-006**: A new tenant MUST start with the four system roles, the Ungrouped entry, the default views, and default notification preferences.

#### Users and authentication

- **FR-007**: Each user MUST belong to exactly one tenant, and email MUST be unique within that tenant (the same email may exist in other tenants as a separate user).
- **FR-008**: Users with the right permission MUST be able to create (invite), view, edit, and deactivate users. Deactivation MUST block sign-in, end active sessions, unassign the user's tickets, and preserve all history.
- **FR-009**: Hard deletion of a user MUST be allowed only when the user has no history, or through an explicit data-erasure action that is recorded in the audit log.
- **FR-010**: Staff MUST be invited by email with one or more roles chosen at invitation. Customers MUST be able to self-register when the tenant allows it, or be invited. New self-registered users MUST get the Customer role.
- **FR-011**: Staff sign-in MUST use email and password. Sign-in for all users MUST support password reset by email (for users with a password), session expiry after inactivity, "sign out of all sessions", and temporary lockout after repeated failed attempts.
- **FR-012**: Customers MUST be able to sign up and sign in with a one-time link sent to their email, with no password required. Sign-up MUST ask only for name and email. A link MUST work once, expire after 15 minutes, and be invalidated when a newer link is requested. Customers MAY set a password and then sign in with either method. Customer sessions MUST stay signed in on trusted devices.
- **FR-012a**: Requests for sign-in links MUST be rate-limited per email address, and the response MUST be the same whether or not the email has an account, so that accounts cannot be discovered through it.
- **FR-013**: Users MUST be able to manage their own name, avatar, password, and notification preferences.
- **FR-014**: Admins MUST be able to see each user's status (invited, active, deactivated, locked) and last sign-in time.
- **FR-015**: Staff MUST be able to set their availability to online, away, or offline, and teammates MUST see it.

#### Roles, permissions, and group access

- **FR-016**: Permissions MUST be actions on resources, with standard actions create, view, edit, and delete, plus resource-specific actions (for example ticket.merge, ticket.split, ticket.bulk_update).
- **FR-017**: Permissions MUST come from a registry in which each module declares its resources and actions. Newly registered permissions MUST appear in the role editor automatically, granted to Admin and denied to all other roles.
- **FR-018**: The initial registry MUST cover users, roles, groups, tickets, views, tags, macros, SLA policies, routing rules, automation rules, webhooks, tenant settings, audit log, and dashboard.
- **FR-019**: Each tenant MUST have the system roles Customer (default for new users), Agent, Manager, and Admin. System roles MUST NOT be deletable. Admin MUST receive every permission and full group access through the same permission checks as every other role, with no hidden bypass, and Admin's full access MUST NOT be removable.
- **FR-020**: Admins MUST be able to create, edit, and delete custom roles. A role MUST NOT be deletable while any user holds it.
- **FR-021**: A user MAY hold several roles. Their effective access MUST be the union of all their roles' permissions and group access.
- **FR-022**: Each role MUST define, per group and for the built-in Ungrouped entry, which ticket actions it allows: view (see tickets and full conversation including internal notes), create (start tickets for customers in the group, or move tickets into it), edit (reply, add notes, change state, priority, owner, and tags), and delete. Admins MUST manage this as a groups × actions matrix in the role editor.
- **FR-023**: Ticket-specific registry actions (merge, split, bulk update) MUST apply only within groups where the user has edit access.
- **FR-024**: Default group access MUST be: Admin full on every group including Ungrouped; Manager view and edit on Ungrouped; Agent none; Customer none (customers only ever reach their own conversation).
- **FR-025**: Changes to permissions, roles, role membership, or group access MUST take effect immediately for all affected users, including already signed-in and connected users, and MUST immediately remove content they can no longer access from their open screens.
- **FR-026**: When an owner loses edit access to a ticket's group, they MUST be removed as owner and the ticket MUST become unassigned.
- **FR-027**: The access model MUST allow finer scopes (for example "only tickets assigned to me") to be added later without redesign.

#### Groups

- **FR-028**: Groups MUST have a name, description, and status (active or inactive). Inactive groups MUST NOT receive new or moved tickets but MUST keep their existing tickets.
- **FR-029**: A newly created group MUST be accessible only to Admin until access is granted to other roles.
- **FR-030**: A group with tickets MUST NOT be deletable until its tickets are moved to another group or back to Ungrouped.

#### Tickets

- **FR-031**: Each ticket MUST have a human-readable number unique within the tenant; a title (auto-generated from the first customer message, or entered by staff when staff start the ticket) editable by staff with edit access; a customer; an optional group; an optional owner; a priority (low, normal, high, urgent; default normal); tags; created, updated, resolved, and closed times; and the times of the last customer message and last agent reply.
- **FR-032**: Each ticket MUST show a derived "waiting on" value: waiting on support if the customer wrote last, waiting on customer if staff replied last.
- **FR-033**: Tickets MUST have the states new, open, pending reminder (with a reminder date), pending close (with a close date), resolved, and closed. The first agent public reply MUST move a new ticket to open. A customer message on a new, open, or pending ticket MUST move it to (or keep it at) open.
- **FR-034**: When a pending reminder's date is reached, the ticket MUST surface to its owner (view and notification). When a pending close date passes with no customer message, the ticket MUST close automatically.
- **FR-035**: Resolved tickets MUST close automatically when the tenant's grace period ends. A customer message within the grace period MUST reopen the ticket and keep its group and owner.
- **FR-036**: A ticket's timeline MUST contain customer messages, public replies (visible to the customer), and internal notes (visible to staff only); each may carry attachments. Sent messages MUST NOT be editable or deletable.
- **FR-037**: Every ticket change MUST be recorded in the ticket's history with who changed what and when.
- **FR-038**: Tickets MUST be linkable as follow-up of, related, or duplicate.
- **FR-038a**: Staff with create access on an active group MUST be able to start a ticket for an existing, active customer of the tenant by choosing the group and entering a title and a first public message (optionally an owner, priority, and tags). The ticket MUST start in state open, waiting on customer, MUST skip routing, and its first message MUST appear in the customer's chat thread like any other public reply. Staff MUST NOT be able to create new customer accounts through this action.
- **FR-039**: Staff MUST be able, subject to group access, to assign or reassign the owner; change state, priority, or group; add or remove tags; add internal notes with @mentions; merge tickets; and split a message into a new ticket.
- **FR-040**: An owner MUST only be assignable if their roles grant edit on the ticket's group.
- **FR-041**: Moving a ticket between groups MUST require edit on the current group and create on the destination. Exception: a user with edit on Ungrouped MUST be able to assign an ungrouped ticket to any active group, and keeps access afterwards only if their roles grant it for that group.
- **FR-042**: Staff MUST be able to move a customer message to another of the same customer's tickets.
- **FR-043**: The ticket model MUST allow custom states, priorities, and fields to be added later without redesign.

#### Tags

- **FR-044**: Each tenant MUST have its own tag list, managed by users with tag permissions. Staff with edit access MUST be able to add or remove tags on tickets, and users with permission to edit users MUST be able to tag customers.

#### Attachments

- **FR-045**: Customers and staff MUST be able to attach images and files to messages. Allowed file types and a maximum size MUST be enforced, with a clear message when a file is rejected.
- **FR-046**: Only people who can see a message MUST be able to open its attachments. Attachment links MUST be private and expire after a short time.
- **FR-047**: There MUST be a malware-scanning step before an attachment becomes available. Until cleared, the attachment MUST show as processing; if flagged, it MUST be blocked and the sender told.

#### Customer chat

- **FR-048**: Each customer MUST see exactly one continuous chat thread per tenant in one chat window, containing their full history across all their tickets. There MUST be no separate list of tickets or conversations.
- **FR-049**: The customer experience MUST never show ticket numbers, states, groups, priorities, owners, SLA information, or internal notes, and MUST never ask the customer to create a ticket or choose a category, priority, group, agent, or subject.
- **FR-050**: Each customer message MUST be routed as follows: to the customer's active ticket (new, open, or pending), or the most recently updated one if there are several; otherwise to the most recent resolved ticket still within the grace period, reopening it; otherwise per the tenant setting, either a new ticket linked as follow-up of the previous one (default) or reopening the previous ticket. New tickets MUST then go through routing.
- **FR-051**: Each customer message MUST land on exactly one ticket, exactly once, including under double-tap, network retries, concurrent sends, and state changes happening at the same time (such as auto-close).
- **FR-052**: The chat MUST separate resolved issues with a subtle, friendly marker, and MUST show a plain-language status (for example "Support has your message", "Support is replying") with no ticket terminology.
- **FR-053**: The chat MUST show the replying agent's name and avatar, agent typing indicators, and delivery/read status for the customer's messages.
- **FR-054**: The chat MUST show the tenant's out-of-hours message outside business hours, when configured, and still accept messages.
- **FR-055**: Customers offline when an agent replies MUST be notified per tenant settings, only about public replies.
- **FR-056**: The chat thread MUST stay in sync across all of the customer's tabs and devices and MUST work well on phone-sized screens.
- **FR-057**: The chat MUST rate-limit customers who send too many messages in a short time, with a friendly message.
- **FR-058**: The chat MUST display the tenant's name, logo, colors, and welcome message.

#### Routing and assignment

- **FR-059**: Admins MUST be able to define ordered routing rules evaluated when a new ticket is created; the first matching rule wins. Conditions MUST include words or phrases in the first message and customer attributes (tags, email domain). Actions MUST set the group and optionally priority and tags. Rules targeting inactive groups MUST be skipped.
- **FR-060**: If no routing rule matches, the ticket MUST stay ungrouped and appear in Needs Triage.
- **FR-061**: The routing design MUST allow another routing source (for example an automatic classifier) to be added later without redesign.
- **FR-062**: Staff with access MUST be able to assign a group and then optionally an owner from the users eligible for that group. Tickets MAY sit in a group with no owner.
- **FR-063**: Triage MUST let a user with edit on Ungrouped set group, and optionally owner, priority, and tags, in a single step from the Needs Triage view.
- **FR-064**: The assignment design MUST allow automatic assignment strategies (round-robin, least-loaded, skill-based) to be added later without redesign.

#### Agent workspace

- **FR-065**: The workspace MUST give staff quick access to their views with live counts, filterable and sortable ticket lists, each ticket's conversation, properties, and history, and the customer's profile and previous tickets.
- **FR-066**: New tickets, messages, assignments, state changes, and view counts MUST update in the workspace without refreshing.
- **FR-067**: Staff MUST see which teammates are viewing or typing on the same ticket (collision awareness).
- **FR-068**: Users with permission MUST be able to create macros that insert a reply and set fields in one action; staff MUST be able to apply them to tickets they can edit.
- **FR-069**: The full customer profile MUST show name, email, contact details, tags, open and closed tickets, and full conversation history, limited to what the viewer may access.
- **FR-070**: Search MUST cover ticket number, customer name and email, ticket title, message content, and tags, and MUST return only results the searcher can access.
- **FR-071**: The admin area MUST contain tenant profile and branding, users, roles (permissions and group-access matrix), groups, views, tags, macros, SLA policies and business hours, routing rules, automation rules, notification defaults, webhooks and integrations, and the audit log. Each section MUST be shown only to users with the matching permission.
- **FR-071a**: Both the customer chat and the agent workspace MUST meet WCAG 2.2 Level AA. This includes full keyboard operation, visible focus, sufficient color contrast (including for tenant-chosen chat colors, which MUST be checked or adjusted to keep contrast), text alternatives for images and attachments, and screen-reader announcements for new messages, typing indicators, and notifications.
- **FR-072**: The visual design, layout, navigation, and interaction patterns of both experiences MUST be original and MUST NOT imitate Zammad.

#### Views

- **FR-073**: Every tenant MUST start with these default views, which admins can edit, hide, or reorder: Needs Triage (ungrouped tickets; only for users with access to Ungrouped), Unassigned & Open (grouped, no owner, not closed), My Tickets, My Pending Reminders Reached, Waiting on Support, All Open, New, Pending, High & Urgent, Escalated (SLA breached or about to breach), Resolved, and Closed.
- **FR-074**: A view MUST have a name, description, visibility, conditions, sort order, and visible columns.
- **FR-075**: View conditions MUST support state, priority, group (including "ungrouped"), owner (including "me" and "unassigned"), customer, tags, waiting on, created time, updated time, last-customer-message time, and SLA status, with operators is, is not, contains, before, after, and within last X, combined with AND/OR groups.
- **FR-076**: Views MUST be shareable with all staff, specific roles, or specific groups; staff MUST be able to create personal views visible only to themselves.
- **FR-077**: A view's list and count MUST never include tickets outside the viewer's group access.

#### Notifications

- **FR-078**: The system MUST provide an in-app notification center with an unread count, plus desktop/browser notifications (when the user grants permission) and email.
- **FR-079**: Users MUST be able to subscribe to: a new ungrouped ticket (only users with access to Ungrouped); a ticket arriving in a group they can view (created or moved there); a new customer message on a ticket assigned to them; a new customer message on an unassigned ticket in a group they can view; a ticket assigned or reassigned to them; one of their tickets reopened or its state or priority changed by someone else; an @mention; an SLA warning or breach; a pending reminder reached.
- **FR-080**: Notification preferences MUST include a master on/off switch, per-event toggles, and per-channel toggles, with defaults set by the tenant.
- **FR-081**: Users MUST never be notified about their own actions; customers MUST be notified only about public replies, never internal notes; notifications MUST only be sent about tickets the recipient can currently access.
- **FR-082**: A burst of messages MUST produce one grouped notification rather than one per message, and the same event MUST never produce duplicate notifications.
- **FR-083**: Read/unread state MUST sync immediately across all of a user's sessions. Notifications and messages missed while disconnected MUST be delivered on reconnect or next sign-in, exactly once.

#### SLA and business hours

- **FR-084**: Admins MUST be able to define SLA policies with first-response, next-response, and resolution targets measured in business hours, and a warning threshold before breach, applied to tickets by conditions such as priority and group.
- **FR-085**: SLA timers MUST start when a ticket is created, so time spent ungrouped counts. Tickets MUST show time remaining. Warnings and breaches MUST feed the Escalated view, notifications, and the dashboard.

#### Dashboard

- **FR-086**: The dashboard MUST show live counts of open, ungrouped, and unassigned tickets; waiting on customer and waiting on support; urgent tickets; SLA breaches; tickets created and resolved today; average first-response and resolution times; and satisfaction score, computed only from tickets the viewer can access.

#### Satisfaction

- **FR-087**: When a ticket is resolved, the customer MUST be offered an optional quick satisfaction rating in the chat. Ratings MUST be visible on the ticket and in the dashboard.

#### Automation rules

- **FR-088**: Admins MUST be able to define automation rules triggered by ticket created, ticket updated, message received, or time elapsed, with conditions and actions (set group, owner, priority, state, or tags; send an auto-reply to the customer; notify users). Actions MUST respect the same group and owner rules as manual changes.
- **FR-089**: A rule's own changes MUST NOT re-trigger that rule, and rule chains MUST NOT loop endlessly.

#### Webhooks

- **FR-090**: Admins MUST be able to configure webhook endpoints with a signing secret, an on/off switch, and subscribed events (ticket created, ticket updated, message created, ticket assigned, ticket closed).
- **FR-091**: Webhook deliveries MUST be signed, retried on failure with increasing delays, and listed in a per-endpoint delivery history with attempt outcomes.

#### Audit log

- **FR-092**: The system MUST keep an append-only audit log, filterable and visible only to users with audit-log permission, recording ticket events (created, assigned, reassigned, state, priority, or group changed, message added, internal note added, merged, split, deleted) and security and configuration events (sign-ins, failed sign-ins, user and role changes, permission and group-access changes, tenant setting changes, webhook changes, support-access grants and revocations, retention setting changes and retention purges, and platform-operator actions under a grant). Each entry MUST record actor, action, resource, time, and relevant details.

### Key Entities

- **Tenant**: An isolated organization workspace. Name, unique URL identifier, status (active or suspended), and settings (branding, timezone, business hours, self-registration, grace period, post-closure behavior, offline notification, out-of-hours message). Owns all other business data.
- **Platform Operator**: A person who runs the service and manages tenants' lifecycle. Belongs to no tenant.
- **Support Access Grant**: A tenant admin's time-limited, read-only permission for platform operators to view that tenant's data. Granting admin, start, expiry, optional reason, and revoked status.
- **User**: Anyone who signs in within a tenant (customer or staff). Name, email (unique per tenant), avatar, status, last sign-in, availability (staff), notification preferences. Holds one or more roles.
- **Sign-in Link**: A single-use, short-lived link emailed to a customer to sign them in. Belongs to one user in one tenant.
- **Session**: A signed-in session of a user on a device. Can expire, be ended by "sign out of all sessions", or be ended by deactivation or tenant suspension.
- **Role**: A named set of permissions plus role–group access. System (Customer, Agent, Manager, Admin) or custom.
- **Permission**: An action on a resource (for example ticket.merge), declared by a module in the permission registry.
- **Role–Group Access**: For one role and one group (or Ungrouped), which of view, create, edit, and delete are allowed.
- **Group**: A team such as Support or Billing. Name, description, status. Plus the built-in, undeletable Ungrouped entry.
- **Ticket**: The internal unit of work. Tenant-unique number, title, customer, optional group, optional owner, priority, state (with reminder or close date for pending states), tags, timestamps, derived "waiting on", SLA status, links to other tickets.
- **Message**: An entry in a ticket timeline: customer message, public reply, or internal note. Author, time, body, attachments, delivery/read status, mentions. Immutable once sent.
- **Attachment**: A file on a message. Name, type, size, scan status. Accessible only to those who can see its message.
- **Ticket Link**: A relationship between two tickets: follow-up of, related, or duplicate (merged tickets are also linked).
- **Ticket History Entry**: A record of one change to a ticket: who, what, old and new values, when.
- **Tag**: A tenant-scoped label applied to tickets and customers.
- **View**: A saved, live ticket list: name, description, visibility (all staff, roles, groups, or personal), conditions, sort, columns. Default views are regular views.
- **Notification**: A message to a user about an event: event type, related ticket, channels, read/unread state, grouping key.
- **Notification Preference**: A user's master switch and per-event, per-channel toggles, starting from tenant defaults.
- **Routing Rule**: Ordered condition-and-action rule applied to new tickets.
- **Macro**: A reusable reply plus field changes, applied in one action.
- **Business Hours**: A tenant's working schedule in its timezone, used by SLA timers and out-of-hours chat messages.
- **SLA Policy**: First-response, next-response, and resolution targets with a warning threshold, applied by conditions.
- **Satisfaction Rating**: A customer's optional rating of a resolved ticket.
- **Automation Rule**: An event, conditions, and actions, with protection against re-triggering itself.
- **Webhook Endpoint** and **Webhook Delivery**: A configured destination with secret, switch, and events; and each delivery attempt with its outcome.
- **Audit Log Entry**: An append-only record of actor, action, resource, time, and details.

## Success Criteria *(mandatory)*

### Measurable Outcomes

**Speed**

- **SC-001**: A signed-in customer can go from opening the chat to sending their first message in under 10 seconds.
- **SC-001a**: A returning customer who is signed out can get from requesting a sign-in link to the open chat in under 1 minute, not counting how long the email takes to arrive.
- **SC-002**: For 95% of messages and ticket changes, all connected participants see them within 2 seconds.
- **SC-003**: Every new ungrouped ticket appears in Needs Triage for connected users with access within 2 seconds.
- **SC-004**: Enabled notifications reach online users within 2 seconds; offline users see 100% of missed notifications on their next sign-in.
- **SC-005**: A triage user can assign a group (and optionally an owner, priority, and tags) to an ungrouped ticket in no more than 3 actions from the Needs Triage view.

**Correctness**

- **SC-006**: Every customer message ends up on exactly one ticket, with zero orphaned or duplicated messages, including under retries, double-taps, concurrent sends, and simultaneous auto-close.
- **SC-007**: Across reconnect tests, users receive 100% of messages and notifications they missed, with zero duplicates.
- **SC-008**: No notification is ever sent to a user about their own action, and customers receive zero notifications about internal notes.

**Access and isolation**

- **SC-009**: Across all tested role configurations, users never see or act on tickets outside their granted groups, or on ungrouped tickets without explicit access.
- **SC-010**: Cross-tenant tests across every resource type and access path (requests, real-time updates, search, notifications, attachment links, webhooks, background jobs) show zero data exposure.
- **SC-011**: After a permission or group-access change, affected signed-in users lose (or gain) access within 2 seconds, without signing in again.

**Customer experience**

- **SC-012**: In usability testing, at least 90% of first-time customers send their first message without any help, and none report seeing ticket terminology.
- **SC-013**: The customer chat is fully usable on a phone-sized screen, with every customer action available.
- **SC-013a**: Both apps pass a WCAG 2.2 Level AA audit with zero open Level A or AA issues, and every primary journey (User Stories 1, 5, 6, and 7) can be completed using only a keyboard and using a screen reader.

**Administration**

- **SC-014**: A newly added module's permissions appear in the role editor with no manual steps.
- **SC-015**: An admin can build and share a view with three conditions in under one minute.

**Testing**

- **SC-016**: The main flow (new issue, triage, conversation, internal note, resolution and return: User Stories 1, 5, 6, and 7) passes as an automated end-to-end test.

## Assumptions

- Customers must be signed in to chat. Anonymous website chat is future work.
- The UI has one language initially. Timezone is set per tenant, and each user can choose how times are displayed.
- Sent messages are immutable in the first version.
- Platform operators manage tenant lifecycle and settings and invite each tenant's first admin. They can read tenant data only under a support-access grant (FR-001a); the maximum grant length of 7 days is a default that can be adjusted later.
- Staff invited by email receive exactly the roles chosen at invitation (they do not automatically keep the Customer role). A user who holds both staff roles and the Customer role can use both experiences.
- A ticket's customer is either the user who sent its first message or, for staff-started tickets, the existing customer the staff member chose (FR-038a). A staff-started ticket counts as the customer's active ticket, so the customer's next message goes to it under the normal routing of customer messages (FR-050).
- Default security values, adjustable later: lockout after 5 failed sign-in attempts within 15 minutes, lasting 15 minutes; staff sessions expire after 12 hours of inactivity; customer sessions last up to 30 days on a trusted device; customer sign-in links expire after 15 minutes, with at most 5 link requests per email address per hour; attachment links expire after 15 minutes.
- Default attachment limits: maximum 25 MB per file; images, PDFs, common office documents, text, and archive files are allowed; executables and scripts are rejected.
- Default customer rate limit: 20 messages per minute. Default notification grouping window: 2 minutes per ticket.
- Offline customer notification defaults to email, sent only for public replies.
- Data erasure of a customer removes their personal data and their tickets and messages. Data erasure of a staff user removes their personal data and replaces their name with an anonymous placeholder on messages and history, keeping ticket content intact. Audit entries record that erasure happened.
- Retention defaults: no automatic deletion until a tenant admin sets a period; the audit log is kept indefinitely unless the tenant sets an audit retention of at least 1 year. Shortening the retention period applies to already-closed tickets on the next daily purge, after the admin confirms how many tickets will be deleted.
- Deleting a ticket removes it and its messages permanently (including from the customer's thread); the audit log keeps a record of the deletion.
- Merging keeps the target ticket and marks the source as merged into it; the customer's thread shows every message exactly once.
- When two agents change the same field at the same time, the later change wins and both changes appear in history; replies are never lost.
- Pending-reminder tickets stay in the pending reminder state when their date is reached; the owner is notified and the ticket appears in "My Pending Reminders Reached".
- A ticket in a group but with no owner has no single person responsible; group members are notified according to their subscriptions.
- Expected scale for the first version: up to a few thousand tenants, each with up to about 200 staff and 100,000 tickets per year, and up to 500 concurrently connected users per tenant.
- The P3 roadmap items automatic assignment, customer organizations, reporting and analytics, and custom states, priorities, and fields are not specified in detail here. This spec only requires that the model leave room for them (FR-043, FR-064); each will get its own specification.
- Out of scope for this spec: AI classification, AI-assisted replies, and AI routing; knowledge base / help center; email-to-ticket, WhatsApp, phone, and other channels (the conversation model must allow adding them); anonymous website chat; SSO and two-factor authentication; tenant billing; integrations with external customer/account systems; native mobile apps.
- This spec is governed by the project constitution v1.0.0 (`.specify/memory/constitution.md`), in particular tenant isolation (I), one authorization path (II), persist-then-publish with idempotent retries (IV), and original UX (XI).
