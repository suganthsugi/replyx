---
title: Automation rules
description: Let rules change tickets, reply to customers and notify people when tickets are created, updated or answered, or after they have waited a set time, without rules looping on each other.
---

Automation rules take care of routine ticket work. Each rule says "when this
happens, and the ticket looks like this, do these things". A typical rule is
"when a ticket has waited **2 days** since the customer's last message, send a
reminder and set it to **Pending (close)**".

Go to **Desk → Admin → Automation rules**. The entry appears for users whose
roles include the `automation_rule.view` permission.

Automation rules are separate from [routing rules](/admin/routing-rules/).
Routing rules pick the group for a new ticket, once. Automation rules can run
at any point in a ticket's life.

## Triggers

The **When** section picks what starts the rule.

| Trigger | The rule is checked when |
|---|---|
| **A ticket is created** | A new ticket starts, from a customer or from staff |
| **A ticket is updated** | The ticket changes: someone edits its state, group, owner, priority or tags, a reply moves it on, or a pending date runs out |
| **The customer sends a message** | The customer writes in the chat. Staff replies and internal notes don't count |
| **Time passes** | A ticket has waited the set time since the chosen moment |

For **Time passes**, choose a **Wait** from **5 minutes** to **90 days** and
what it is counted from:

- **the customer's last message**
- **the last agent reply**
- **the ticket last changed**
- **the ticket was created**

A time rule runs **once per waiting period**. If the customer writes again, or
the chosen moment otherwise moves, the wait starts over, and the rule can run
again after the full wait. Closed tickets are never picked up. Time rules are
checked about **once a minute**, so a rule can run up to a minute after the
wait ends.

## Conditions

Under **Only for tickets that match**, choose:

- **Every ticket** — the rule runs whenever its trigger fires.
- **Only tickets that match these conditions** — build conditions the same way
  as for a [custom view](/guides/custom-views/): state, priority, group,
  owner, tags, waiting on, dates and SLA status, combined with **All** or
  **Any**, and nested up to three levels.

The ticket must match when the trigger fires, and again when the rule
actually runs a moment later. If someone changed the ticket in between so that
it no longer matches, the rule does nothing.

"Owner is me" is not offered: a rule runs on its own, so there is no "me".

## Actions

Under **Then**, fill in what the rule should do. Leave a field as
**Don't change** to keep it as it is. Choose **at least one** action.

| Action | What it does |
|---|---|
| **Move to group** | Puts the ticket in the group. Only active groups can be chosen |
| **Set owner** | Assigns the ticket to the person, or **Nobody (unassign)** |
| **Set priority** | Low, Normal, High or Urgent |
| **Set state** | Open, Pending (reminder), Pending (close), Resolved or Closed |
| **Pending for** | Required with a pending state: **1** to **720** hours from when the rule runs |
| **Add tags** | Adds up to **20** tags; tags already on the ticket stay |
| **Send a reply to the customer** | A public message to the customer, up to **10,000** characters |
| **Notify people** | Up to **20** people get an in-app **Automation rule** notification |

Rules follow the same rules as a person. A rule can't give a ticket to an
owner who can't work on its group, can't move it to an inactive group, and
can't make a state change that isn't allowed. When one of its changes is
refused, **none** of that rule's actions are applied to that ticket, and the
rule doesn't try again for the same trigger.

A rule's reply is sent **once** for each time the rule runs, even if the
system retries the run. **Notify people** sends an in-app notification, and
only to people who can see the ticket and haven't turned off **Automation
rule** in their [notification preferences](/guides/notification-preferences/).

## Several rules and loops

Every enabled rule whose trigger fires and whose conditions match runs; rules
don't stop each other the way routing rules do.

A rule's changes can start other rules. For example, a rule that sets the
priority to **Urgent** updates the ticket, which can start a rule triggered by
**A ticket is updated**. To keep this safe:

- a rule never runs because of a change it made itself, and
- a chain stops after **three** rules in a row.

Changes made by a rule show in the ticket's history under the rule's name, so
you can see which rule did what.

## Add a rule

1. Select **Add rule**.
2. In **Details**, enter a **Name** (up to **80** characters). Leave the
   switch on **Enabled**, or turn it off to save the rule as
   **Disabled: never runs**.
3. In **When**, choose the trigger, and for **Time passes** the wait.
4. Choose **Every ticket** or add conditions.
5. Fill in the actions.
6. Select **Add rule** at the bottom of the drawer.

If something is missing, the form says what and moves to the field: for
example **Choose at least one action.** or
**Enter how many hours the ticket stays pending.**

To change a rule, select **Edit** on its row. Use the switch on the row to
turn a rule on or off without opening it. **Delete** removes the rule for good;
changes it already made to tickets stay.

A workspace can have up to **100** automation rules.

## Example: close quiet tickets

1. **Name**: Close quiet tickets.
2. **Trigger**: **Time passes**, **Wait** **2** **days**, since **the
   customer's last message**.
3. **Only tickets that match these conditions**: **Waiting on** is
   **Customer**.
4. **Send a reply to the customer**: "Is there anything else we can help
   with? If we don't hear from you, this conversation will close in two days."
5. **Set state**: **Pending (close)**, **Pending for** **48** hours.

Each quiet ticket gets the reminder once. If the customer answers, the ticket
reopens as usual (see [Working tickets](/guides/working-tickets/)) and the
wait starts over.

## Permissions

| Permission | Allows |
|---|---|
| `automation_rule.view` | Open the page and see the rules |
| `automation_rule.create` | Add rules |
| `automation_rule.edit` | Edit rules and turn them on or off |
| `automation_rule.delete` | Delete rules |

Every change to a rule is recorded in the [audit log](/admin/audit-and-retention/).
