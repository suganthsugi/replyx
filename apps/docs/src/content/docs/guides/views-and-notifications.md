---
title: Views and notifications
description: How default views filter and count tickets you can access, how to hide or reorder views, and which events trigger an in-app notification.
---

Views group tickets by a shared condition so you can work through them without searching every
time. Notifications tell you when something needs your attention without watching every view. Both
only ever show you tickets in groups you have access to — see
[Roles and groups](/admin/roles-and-groups/) for how that access is granted.

## Default views

Every tenant starts with these built-in views:

| View | Shows |
|------|-------|
| Needs Triage | Ungrouped tickets — visible only if you have access to Ungrouped. |
| Unassigned & Open | Grouped tickets with no owner, not closed. |
| My Tickets | Tickets you own, not closed. |
| My Pending Reminders Reached | Tickets you own, pending on a reminder whose date has passed. |
| Waiting on Support | New or open tickets currently waiting on a staff reply. |
| All Open | New, open, or either pending state. |
| New | Tickets no agent has replied to yet. |
| Pending | Either pending state. |
| High & Urgent | High or urgent priority, not closed. |
| Escalated | SLA breached or about to breach, not closed — matches nothing until your tenant has SLA policies. |
| Resolved | Resolved tickets. |
| Closed | Closed tickets. |

A view and its count only ever include tickets in groups you have access to — the same view looks
different to different people depending on what they can see.

## Live counts

Each view shows a count of matching tickets. When a ticket changes in a group you can see, the
count updates within about a second. For a condition based purely on elapsed time (for example, a
reminder reached within the last few hours), the count can take up to **30 seconds** to catch up.

## Hiding and reordering views

You can freely reorder or hide any personal view you built yourself. Shared views — including the
default views above — can only be reordered or hidden by someone with permission to edit views, and
a change they make applies to everyone the view is shared with. Default views can be hidden, but
they can't be deleted.

## Notifications

The notification center shows an unread count and lists the events below as they happen. You're
notified about:

- A new ungrouped ticket (only if you have access to Ungrouped).
- A ticket arriving in a group you can view, whether it was just created there or moved in.
- A new customer message on a ticket assigned to you.
- A new customer message on an unassigned ticket in a group you can view — but only once staff has
  already replied; a brand-new ticket's first messages are covered by the "new ticket" notification
  instead.
- A ticket assigned to you.
- One of your tickets reopened by the customer, or its state or priority changed by someone else.
- An **@mention** of you, in a reply or an internal note.
- An SLA warning or breach (once your tenant has SLA policies).
- A pending reminder reached on a ticket you own.

You're never notified about your own actions, and you only ever get notified about tickets you can
currently access — if you lose access to a ticket's group, you stop hearing about it. Customers are
never notified about internal notes; see [Working tickets](/guides/working-tickets/) for how notes
differ from replies.

If a customer sends several messages on the same ticket within **2 minutes**, they arrive as one
notification with a count, not one per message. The same event never notifies you twice.

Read and unread status stays in sync across every open tab and device — marking something read in
one place clears it everywhere, right away. If you were offline, signing back in or reconnecting
shows you what you missed while you were away.

## Notification preferences

You have a master switch for notifications, plus a toggle for each event type above. Your defaults
come from your organization, and you can adjust them from there. In-app delivery is available now;
browser push and email toggles can be set today but aren't delivered yet — that arrives in a later
release.
