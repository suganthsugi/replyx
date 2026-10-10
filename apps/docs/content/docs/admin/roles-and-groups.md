---
title: Roles and groups
description: Control what your agents and managers can see and do with roles, permissions, and group access.
---

Roles decide what a user can do. Groups organize tickets and control who can
see them. Every user holds one or more roles, and each role's group access
determines which groups' tickets that role can view, create, edit, or delete.

Go to **Desk → Admin → Roles** (`/desk/admin/roles`) and **Desk → Admin →
Groups** (`/desk/admin/groups`). These sections only appear for users whose
roles include the `role.view` and `group.view` permissions.

## System roles

Every workspace starts with four system roles:

- **Admin** — full access to everything, always. Admin holds every
  permission and full access (view, create, edit, delete) to every group,
  including Ungrouped. This can't be reduced, and any new permission added
  by a product update is granted to Admin automatically.
- **Manager** — view and edit on Ungrouped by default.
- **Agent** — no group access by default.
- **Customer** — held by customers. Customers only ever reach their own
  conversation; the group access matrix doesn't apply to them.

System roles can't be renamed or deleted. You can still edit their
permissions and group access (except Admin, which is fixed).

## Custom roles

Create additional roles for the access patterns your workspace needs — for
example, a "Billing agent" role scoped to one group.

To create a role:

1. On the Roles page, select **New role**.
2. Enter a name (1–60 characters, unique regardless of capitalization).
3. Set its permissions and group access (see below), then save.

A role held by any user can't be deleted. Reassign or remove that role from
its users first, then delete it.

A user can hold several roles at once. Their effective access is the union
of everything all their roles grant — permissions and group access alike.

## Permissions

The permission list is grouped by module: users, roles, groups, tickets,
views, tags, macros, SLA policies, routing rules, automation rules,
webhooks, tenant settings, audit log, and dashboard. Each module offers
standard actions (view, create, edit, delete) plus a few module-specific
ones.

Ticket permissions (`ticket.*`) are **group scoped**: granting a role
`ticket.view` doesn't show it any tickets by itself — it only sees tickets
in the groups where its group access matrix also grants **View**. The same
applies to create, edit, and delete. Merging, splitting, bulk updates, and
moving a message to another ticket require **Edit** on the group involved.

## Group access matrix

Each role's editor includes a matrix with one row per group (plus the
built-in **Ungrouped** row) and one column per action: **View**, **Create**,
**Edit**, **Delete**.

- **View** — see the group's tickets and their full conversation, including
  internal notes. Without View, a group's tickets are invisible to the
  role — they don't appear in lists, search, or counts.
- **Create** — start tickets in the group.
- **Edit** — reply, add internal notes, change state, priority, owner, and
  tags; also required for merge, split, bulk update, and moving a message.
- **Delete** — delete tickets in the group.

Selecting Create, Edit, or Delete also selects View, and clearing View
clears the whole row, because the other actions mean nothing without it.
You can move through the matrix with the arrow keys and toggle a cell with
Space.

A user's overall access to a group is the union of what every role they
hold grants for that group.

## Groups

Groups organize tickets — for example by product, region, or team.

To create a group:

1. On the Groups page, select **New group**.
2. Enter a name (1–80 characters, unique) and an optional description.
3. Save. The group is **active** and accessible only to **Admin** until you
   grant access to other roles in their role editors.

**Active / inactive** — an active group receives new and moved tickets
normally. Marking a group **inactive** stops it from receiving new or moved
tickets, but it keeps all the tickets it already has, and those tickets
remain visible and editable to roles with access.

**Deleting a group** — a group with tickets can't be deleted. Move its
tickets to another group or back to Ungrouped first, then delete it.

## When changes take effect

Permission, role, role membership, and group access changes apply
immediately — including to users who are already signed in. There's no need
to sign out and back in.

- If a user loses View on a group they have open, that screen closes with a
  notice.
- If a role loses Edit on a group, any ticket owners who relied on that
  role's edit access are unassigned from their tickets in that group. The
  role editor warns you about this before you save a change that would
  remove edit access.
