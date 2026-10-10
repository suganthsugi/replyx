---
title: Support access
description: Grant, review, and revoke the platform's read-only access to your workspace.
---

Support access lets the platform's operators read your workspace to help you
— for example, when you contact them with an issue. Access is always:

- **Read-only** — operators can never change or delete anything.
- **Time-limited** — you choose how long it lasts, up to 7 days.
- **Audited** — every page an operator opens during a session is recorded in
  your audit log.

You can end access at any moment.

Admins have the `support_access.create` permission needed for this page.

## Granting access

Go to **Desk → Admin → Support access** (`/desk/admin/support-access`) and
choose:

- **For how long** — 1 hour, 4 hours, 1 day, 3 days, or 7 days (the maximum).
- **Reason** — optional; shown in your audit log.

Select **Grant access**. The platform's operators can now open a support
session for your workspace, read-only, until the grant expires or you revoke
it.

## Grants

The grants table lists every grant for your workspace, with:

- **Status** — **Active**, **Revoked**, or **Expired**.
- **Granted by** — who at your workspace granted it.
- **From** and **Until** — the grant's window.
- **Reason** — the optional reason given when it was granted.

## Revoking access

Select **Revoke** on an active grant to end it immediately. The platform's
operators lose access to your workspace right away.
