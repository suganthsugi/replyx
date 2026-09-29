---
title: Triaging ungrouped tickets
description: How to send an ungrouped ticket from Needs Triage to the right group, owner, priority, and tags in a single step.
---

Some tickets arrive with no group — nothing in your tenant's routing rules matched them. This guide
covers finding and triaging them; see [Working tickets](/guides/working-tickets/) for everything
else you can do with a ticket once it has a group.

## Needs Triage

**Needs Triage** is the default view for ungrouped tickets. You only see it if you have access to
Ungrouped — admins always do. If you don't have that access, ungrouped tickets never appear in any
of your views. See [Roles and groups](/admin/roles-and-groups/) for how access is granted.

## Triaging a ticket

Open an ungrouped ticket and use the triage bar at the top:

1. Choose a **Group** — required. Only active groups can be chosen.
2. Optionally choose an **Owner** — the list only offers people who can edit the group you picked.
3. Optionally set a **Priority** and **Tags**.
4. Select **Assign**.

Choosing a group and assigning is at most three actions. Keyboard shortcuts speed this up further:

| Key | Action |
|-----|--------|
| `G` | Focus the Group field |
| `O` | Focus the Owner field |
| `Enter` | Assign, while the Group or Owner field has focus |

## After you assign

The ticket leaves Needs Triage right away. It appears in the destination group's **Unassigned &
Open** view, or in the owner's **My Tickets** if you set one, and the group's staff get a
notification. See [Views and notifications](/guides/views-and-notifications/) for how views and
notifications work.

If you don't have access to the group you just assigned, the ticket screen closes and the ticket disappears from
your own lists — it's still been triaged, just out of your view.

## If triage doesn't go through

- **"Someone else already triaged this ticket."** — another user assigned it first; refresh to see
  where it went (if you still have access to that group).
- An **inactive group** can't be chosen as a destination.
- An **owner** who doesn't have edit access to the group you picked is refused — pick a different
  owner or leave it unassigned.
