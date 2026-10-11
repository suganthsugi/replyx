---
title: SLA and business hours
description: Set up business hours calendars, an out-of-hours message and SLA policies, understand how the timers run, and read the desk dashboard.
---

Service level agreements (SLAs) set how quickly your team should respond to
and resolve tickets. Times are counted in **business minutes**, so they only
run while your business hours calendar says you are open. This page covers
calendars, the out-of-hours message, SLA policies, how timers behave, and the
desk dashboard.

Go to **Desk → Admin → SLA policies** or **Desk → Admin → Business hours**,
next to **Routing rules**. One set of permissions covers both (see
[Permissions](#permissions)).

## Business hours calendars

In **Business hours**, select **Add calendar**. A calendar describes when your
team is available. Each row has **Edit** and **Delete**.

- **Name** — unique in the workspace, ignoring capitalization.
- **Time zone** — an IANA time zone such as `Europe/London`.
- **Opening hours** — for each weekday, up to **6** opening ranges. A range of
  **00:00–00:00** means open all day. A day with no range is closed.
- **Holidays** — dates on which you are closed all day.

You can't delete a calendar while an SLA policy or the workspace settings use
it. Switch those to another calendar first.

## Out-of-hours message

Go to **Desk → Admin → Organization** (see
[Organization settings](/admin/organization-settings/)). Choose the workspace's
calendar under **Business hours** and write the **Out-of-hours message**. Outside business hours, the customer chat
shows that message. The chat still accepts messages, which are handled as
usual once you are open.

## SLA policies

In **SLA policies**, select **Add policy**. If you have no calendar yet, the
page says **Add a business-hours calendar first.** Policies are an ordered
list. For each ticket, the **first policy from the top
whose conditions match applies**; later policies are not looked at. Put
specific policies above general ones.

The editor has a **Name** and these settings.

**Conditions** — at least one is required:

- **Priority** is / is not a value.
- **Group** is / is not a group.

**Calendar** — each policy uses one calendar.

**Targets** are in business minutes. Leave a target blank for no target.

| Field | Meaning |
|---|---|
| **First response target (minutes)** | Time until the first public staff reply |
| **Next response target (minutes)** | Time to answer a customer who wrote again |
| **Resolution target (minutes)** | Time until the ticket is resolved or closed |

**Warn at (percent of target)** — **50–99 %**, default **80 %**. When a
ticket reaches it, it is flagged as at risk before it breaches.

There is no drag-and-drop. Use **Move up** and **Move down** on a row to change
the order. **Edit** and **Delete** are on each row too.

Editing a policy or a calendar recalculates the due times of open tickets.

## How the timers run

| Timer | Starts | Stops |
|---|---|---|
| First response | When the ticket is created | The first public staff reply. Internal notes don't count |
| Next response | The first customer message after a staff reply | The next public staff reply |
| Resolution | When the ticket is created | The ticket is resolved or closed |

Details that surprise people:

- Timers start at creation, so time spent in **Ungrouped** counts.
- The pending states (**Pending (reminder)** and **Pending (auto-close)**) pause the
  **resolution** timer only. Response timers keep running.
- If a ticket is reopened, resolution time counts from creation again.

## Warnings and breaches

A warning and a breach each happen **once per target per ticket**.

- The ticket's owner is notified. With no owner, everyone who can view the
  ticket's group is notified.
- Warning and breached tickets appear in the default **Escalated** view.
- The ticket shows the time remaining.
- Breaches count on the dashboard.

## Dashboard

The desk dashboard shows live counts:

- open, ungrouped, unassigned, waiting on customer, waiting on support, urgent,
  and SLA breaches
- created today and resolved today
- average first-response and resolution times over the last **7 days**
- customer satisfaction: the average rating from the last **7 days** (see
  [Customer profile and satisfaction](/guides/customer-profile-and-satisfaction/))

Only tickets the viewer can access are counted, so two people can see
different numbers (see [Roles and groups](/admin/roles-and-groups/)). The
dashboard needs the dashboard permission.

## Permissions

`sla_policy.view`, `sla_policy.create`, `sla_policy.edit` and
`sla_policy.delete` cover both policies and business hours calendars. Admin
has all of them.

## Troubleshooting

- **A ticket has no SLA.** No policy matched it. Check the order and
  conditions of your policies.
- **Can't delete a calendar.** A policy or the workspace settings still use it.
- **Times look wrong after an edit.** Open tickets are recalculated; reload the
  ticket.
- **Resolution time keeps growing while pending.** Only **Pending (reminder)**
  and **Pending (auto-close)** pause it. Other states don't.
