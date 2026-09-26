---
title: Working tickets
description: How agents move a ticket through its states, add internal notes, assign owners, link and organize tickets, and use the default views.
---

A ticket is the record of one customer conversation. This guide covers what you can do with a
ticket once you have view or edit access to its group — see [Roles and groups](/admin/roles-and-groups/)
for how that access is granted.

## Ticket states

| State | Meaning |
|-------|---------|
| New | No agent has replied yet. |
| Open | An agent has replied, or the ticket is otherwise actively worked. |
| Pending, reminder | Waiting, with a date you set. When that date arrives, the ticket is flagged as a reminder reached — it does not close or change state on its own. |
| Pending, close | Waiting, with a date you set. When that date arrives, the ticket **closes automatically**. |
| Resolved | You've marked the issue solved. It closes automatically after a grace period unless the customer replies first. |
| Closed | The conversation is finished. |

A customer reply always reopens a pending or resolved ticket to **Open** (within resolved's grace
period; after that it has already closed). Reopening a closed ticket keeps its group and owner —
you don't lose that context.

## Replies vs internal notes

You can add two kinds of message to a ticket:

- **Replies** are public — the customer sees them in their conversation.
- **Internal notes** are visible only to staff who can view the ticket's group. The customer never
  sees them and is never notified about them.

Type an **@** followed by a teammate's name in a note to mention them; the mentioned person is
notified. Mentions only work in internal notes, since replies already reach the customer directly.

Once sent, a message — reply or note — cannot be edited or deleted.

## Pending dates

Setting a ticket to a pending state requires a date. What happens when that date is reached
depends on which pending state you chose:

- **Pending, reminder** fires once: the ticket appears in **My Pending Reminders Reached** for its
  owner, but its state doesn't change.
- **Pending, close** closes the ticket automatically when the date passes, with no further action
  needed from you.

Either pending state ends early and returns the ticket to **Open** if the customer replies, or if
you change it yourself.

## Assigning an owner

You can assign or reassign a ticket to anyone who has edit access to the ticket's current group —
that's the full list of eligible owners; there's no separate membership list to maintain. If
someone's access to a group is later removed (their role changes, or the group access changes),
any ticket they own in that group becomes unassigned automatically, so it doesn't sit invisible to
everyone else on the team.

## Moving between groups

Moving a ticket to another group needs edit access on its current group and create access on the
destination group. Ungrouped tickets are the one exception: if you have edit access to Ungrouped,
you can assign an ungrouped ticket to any active group. After the move, you keep access to it only
if your own roles grant you access to that destination group — moving it doesn't grant you
anything extra.

Only active groups can receive tickets, whether by moving or by routing.

## Tags

You can add or remove tags on a ticket, subject to your usual edit access. Tags help you filter and
search; several default views and macros can also match on them.

## Links

You can link one ticket to another as a **follow-up**, **related**, or **duplicate**. Creating a
link requires edit access on the ticket you're linking from and view access on the ticket you're
linking to.

If a linked ticket is later purged under data retention, or you simply lose view access to the
group it's in, the link stays but shows without the other ticket's details — you'll still see that
a link of that kind exists, just not its title, number, or state.

## Moving a customer message

If a customer's message landed on the wrong one of their tickets, you can move it to another of
that same customer's tickets. The message keeps its place in the timeline of its new ticket.

## History

Every change to a ticket — state, priority, group, owner, tags — is recorded in its history, along
with who made it and when. Ticket history is visible to anyone who can view the ticket.

## Staff-started tickets

If you have create access on an active group, you can start a new ticket yourself for an existing
customer of the tenant: choose the group, and write a title and a first message (you can also set
an owner, priority, and tags up front). This skips the usual routing step, since you've already
chosen the group. The first message appears in the customer's conversation exactly like any other
reply, and the customer isn't told a ticket was created on their behalf. You can't create a new
customer account through this action — only start a ticket for someone who's already a customer.

## Default views

Every tenant starts with a set of built-in views, each scoped to what you're allowed to see:

| View | Shows |
|------|-------|
| Needs Triage | Ungrouped tickets, not closed — visible only if you have access to Ungrouped. |
| Unassigned & Open | Grouped tickets with no owner, not closed. |
| My Tickets | Tickets you own, not closed. |
| My Pending Reminders Reached | Tickets you own, pending on a reminder whose date has passed. |
| Waiting on Support | New or open tickets currently waiting on a staff reply. |
| All Open | New, open, or either pending state. |
| New | Tickets no agent has replied to yet. |
| Pending | Either pending state. |
| High & Urgent | High or urgent priority, not closed. |
| Escalated | SLA breached or about to breach, not closed. |
| Resolved | Resolved tickets. |
| Closed | Closed tickets. |

An admin can edit, hide, or reorder these views, and you can build your own — see
[Roles and groups](/admin/roles-and-groups/) for how group access shapes what any view can show
you. No matter which view you use, it only ever lists tickets in groups you have access to.
