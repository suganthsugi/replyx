---
title: Users
description: Invite staff, manage roles, and deactivate, delete, or erase users.
---

Admins with the `user.view`, `user.create`, `user.edit`, `user.delete`, or `user.erase`
permission manage users from **Admin → Users**.

## Invite a staff member

1. Go to **Admin → Users** and select **Invite user**.
2. Enter the person's email and choose one or more roles. Roles control what
   the person can see and do.
3. Send the invitation.

The invitee gets an email with a link. The link is valid for **7 days**. When
they open it, they set their name and a password, then they are signed in.
Passwords must be at least **12 characters**.

If the invitation expires before it is accepted, invite the person again.

Staff get exactly the roles chosen at invitation — they do not automatically
get the Customer role. A person can hold both a staff role and the Customer
role, and use both experiences with the same email.

## Edit a user

Open a user's page to change their name or roles. Role changes take effect
immediately, including for that user's open sessions.

## Deactivate, delete, or erase

Use the action that matches what you need:

### Deactivate

Deactivating a user:

- Blocks sign-in.
- Ends their active sessions.
- Unassigns their open tickets.
- Keeps their history (messages, tickets, audit trail).

Deactivation is reversible — reactivate the user from the same page.

Use this for someone who has left the team or should temporarily lose access,
while keeping their past work visible.

### Delete

Deleting a user permanently removes them. This only works when the user has
**no history** — no messages, no tickets, nothing recorded against them. If
the user has history, the delete action fails and you are offered
deactivation instead.

Use this only for users created by mistake, such as a bad invitation.

### Erase

Erasing a user removes their personal data. This cannot be undone, and an
audit entry records that it happened. What is removed depends on the kind of
user:

- **Customers**: their tickets and messages are removed.
- **Staff**: their name is replaced with "Former user" on messages and
  history. Ticket content stays intact; only the staff member's identity is
  removed from it.

To erase a user, type `ERASE` to confirm. This confirmation step is required
so erasure cannot happen by accident.

Use erasure when someone has asked for their personal data to be removed and
deactivation isn't enough.

## User status

The users list shows each person's status — invited, active, deactivated, or
locked — and their last sign-in time. A locked user has been temporarily
blocked after repeated failed sign-in attempts; see
[Signing in](/guides/signing-in/) for how lockout works.
