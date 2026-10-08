---
title: Macros, merging, splitting and bulk changes
description: How to answer common questions in one step with macros, merge duplicate tickets, split a message into its own ticket, change many tickets at once, and see who else is working on a ticket.
---

These tools save time on repeated work: macros send a saved reply and update the ticket in one
step, merge and split fix conversations that ended up in the wrong place, and bulk changes update
many tickets at once. While you work, the ticket shows who else is looking at it or typing.

## Use a macro

A macro is a saved reply that can also change the ticket, for example setting it to **Resolved**,
raising the priority, adding tags or assigning it to you.

1. Open a ticket and make sure **Reply** is selected in the composer.
2. Type **/** at the start of the reply box. A list of the macros shared with you appears.
3. Keep typing to narrow the list by name, then use the arrow keys and press **Enter**, or select a macro.
4. The macro's text appears in the reply box. Edit it if you need to. Under the box, a chip shows the macro's name and what else it will do, such as "Sending will also set state to Resolved".
5. Select **Send and apply macro**. The reply is sent and the ticket changes are made together. If one of the changes is not allowed, nothing is sent and you see why.

To send a plain reply instead, remove the chip with its **×** button. Macros are not available in
internal notes, because a macro's reply is always visible to the customer.

A macro that only changes the ticket has no text. Insert it and select **Send and apply macro**
with the reply box empty.

## Manage macros

Admins and anyone with permission to manage macros can do this under **Admin › Macros**.

1. Select **Add macro**, or **Edit** next to an existing one.
2. Enter a **Name** and the **Reply text**. Leave the text empty for a macro that only changes the ticket.
3. Under **Ticket changes**, choose what the macro also does: **Set state**, **Set priority**, **Add tags**, and whether to assign the ticket to whoever uses it. A pending state also needs the number of hours the ticket stays pending.
4. Under **Who can use it**, share the macro with everyone on the team, with people who have certain roles, or with people in certain groups.
5. Select **Add macro** or **Save changes**.

Deleting a macro removes it for everyone it was shared with. Replies already sent with it are not changed.

## Merge duplicate tickets

When a customer writes about the same problem twice, merge one ticket into the other.

1. Open the ticket you want to fold away and select **Merge**.
2. Enter the number of the ticket to keep, for example `1042`, and select **Merge**.

The merged ticket is closed and its messages appear in the timeline of the ticket you kept. Nothing
is copied, so the customer still sees each message once in their conversation. Both tickets must
belong to the same customer, and you need permission to edit both.

## Split a message into a new ticket

When a customer raises a new problem inside an existing conversation, split it out.

1. Open the ticket and select **Split**.
2. Choose the message that starts the new problem. Internal notes cannot be split.
3. Optionally enter a title. Without one, the first line of the message is used.
4. Select **Split**.

The message moves to a new ticket for the same customer and group, linked to the original. The
customer's next message goes to the new ticket, because it is now their most recently updated one.

## Change many tickets at once

1. In a ticket list, select the checkbox on each ticket you want to change, or move to a ticket with the arrow keys and press **X**.
2. A bar appears at the bottom of the list showing how many tickets are selected.
3. Choose **Set state**, **Set priority** or **Assign to me**.

You can select up to 100 tickets. Each ticket is checked on its own, so if some cannot be changed
(for example, you cannot edit their group, or a closed ticket cannot move to that state), the rest
are still updated. A message tells you how many were updated and why the others were not, and the
ones that were not updated stay selected.

## See who else is working on a ticket

The top of an open ticket shows the people viewing it and anyone typing a reply, so two people do
not answer the same customer at once. Nothing about who viewed a ticket is saved to its history.

Your availability (**Online**, **Away** or **Offline**, set from the menu at the top of the
workspace) is shown to colleagues straight away, including next to your name when they choose an
owner.

For the rest of the ticket screen, see [Working tickets](/guides/working-tickets/).
