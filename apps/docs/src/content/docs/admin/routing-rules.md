---
title: Routing rules
description: Send new tickets to the right group automatically by matching the customer's first message, email domain, or tags, and try a message against your rules before relying on them.
---

Routing rules decide which group a new ticket lands in. Each rule says "if the
first message and customer look like this, put the ticket in this group", with
an optional priority and tags. When no rule matches, the ticket stays in
**Ungrouped** and appears in Needs Triage (see [Triage](/guides/triage/)).

Go to **Desk → Admin → Routing rules**. The entry appears for users whose
roles include the `routing_rule.view` permission.

## When rules run

Rules run **once**, when a **new** ticket is created from a customer's first
message. They don't run when:

- a customer message reopens a closed ticket or is added to an open one,
- a staff member starts a ticket themselves.

Rules are checked from top to bottom. The **first enabled rule that matches
and whose group is active wins**; later rules are not looked at.

## Conditions

The **When a new ticket starts** section of the rule form holds the
conditions. Fill in at least one. **Every list you fill in must match**
(AND); leave the others empty. Within one list, matching any entry is enough,
except "contains all of".

| Field | Matches when |
|---|---|
| **First message contains any of** | The message has at least one of the words or phrases |
| **First message contains all of** | The message has every one of the words or phrases |
| **Customer has any of the tags** | The customer carries at least one of the tags |
| **Customer email domain is** | The part after the `@` equals one of the domains |

Type an entry and press **Enter** to add it as a chip (for phrases and
domains).

- Phrases match **whole words** and ignore capitalization. "refund" matches
  "I want a refund." but not "refunded".
- Spaces inside a phrase are flexible.
- Domains match **exactly**: `example.com` does not match
  `mail.example.com`. A leading `@` is ignored.
- Each list holds up to **20** entries.

If you save without any condition, the form shows **Fill in at least one
condition.**

## Actions

The actions section describes what happens to the ticket when the rule is the
first to match.

- **Assign to group** (required) — only active groups can be chosen;
  inactive ones appear as "(inactive)" and can't be selected.
- **Set priority** — optional; leave it as **None** to keep the default.
- **Add tags** — optional; added to the new ticket.

## Add a rule

1. Select **Add rule**.
2. In **Details**, enter a **Name** (up to 80 characters).
3. Leave the switch on **Enabled**, or turn it off to save the rule as
   **Disabled: skipped when tickets are routed**.
4. Fill in the conditions and actions.
5. Select **Add rule** at the bottom of the drawer.

The new rule is added at the end of the list. To change a rule, select
**Edit** on its row and select **Save changes**. Closing the drawer with
unsaved changes asks **Discard your changes?**.

A workspace can have up to **100** rules. At the limit, **Add rule** is
disabled.

## Order, disable, delete

- Use **Move up** and **Move down** on a row to change the order. Put
  specific rules above general ones, because the first match wins.
- Use the **Enable** switch on a row to disable a rule without deleting it.
  Disabled rules show a **Disabled** chip.
- **Delete** asks for confirmation and is permanent. The rules after it move
  up one place. Tickets already routed are not changed.

**Edit**, **Delete**, **Add rule**, and the switch and move controls appear
only for roles that hold the matching permission.

## Inactive or deleted groups

If a rule's group becomes inactive, the rule is skipped when routing and its
row shows **Group inactive - skipped**. If the group no longer exists, the row
shows **Group deleted - skipped**. Edit the rule and choose an active group to
fix it, or reactivate the group (see
[Roles and groups](/admin/roles-and-groups/)).

You can't enable a rule whose group is inactive, or save an enabled rule with
one. A disabled rule can still be saved.

## Try a message

Below the list, the **Try a message** panel shows which rule would catch a
customer's first message. Nothing is created or changed, and you don't need a
customer: enter a sample and select **Run**.

- **Message** (required) — the sample first message.
- **Customer email** — optional, used by email domain conditions.
- **Customer tags** — optional, used by tag conditions.

The result names the winning rule, for example "Matches rule 1: Refunds to
Billing -> Billing", with priority and tags when the rule sets them. With no
match it says **No rule matches: the ticket would stay in Needs Triage.**
Rules skipped because of their group are listed under the result.

## Examples

| Goal | Conditions | Actions |
|---|---|---|
| Refunds go to Billing | First message contains any of: `refund`, `money back` | Assign to group: Billing |
| Outages from a key account | Contains any of: `outage`, `down`; email domain: `bigcustomer.com` | Group: Support, priority: urgent |
| Invoice and overdue together | Contains all of: `invoice`, `overdue` | Group: Billing, tag: `collections` |
| VIP customers | Customer has any of the tags: `vip` | Group: Support, priority: high |

New development workspaces include a **Refunds to Billing** rule, so you can
try the panel right away.

## Permissions and audit

Four permissions control this area: `routing_rule.view`, `routing_rule.create`,
`routing_rule.edit` (edit, enable, disable, reorder), and
`routing_rule.delete`. Admin has all of them. Creating, editing, reordering,
and deleting rules are recorded in the
[audit log](/admin/audit-and-retention/).

A ticket's history shows the group, priority, and tag changes made by
routing as done by **Routing**. The name of the rule isn't shown there yet.

## Troubleshooting

- **A ticket wasn't routed.** Check that it was a new ticket from a customer
  message, that the rule is enabled, and that an earlier rule didn't match
  first. Paste the message into **Try a message**.
- **"refund" doesn't match "refunded".** Phrases match whole words. Add both.
- **A subdomain doesn't match.** Add each domain you need.
- **Can't save an enabled rule.** Its group is inactive. Choose an active
  group.
- **Add rule is disabled.** The workspace has reached **100** rules. Delete
  one you no longer need.
- **The new order was not saved.** The list changed since you opened it.
  Reload the page and try again.
