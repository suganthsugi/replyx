---
title: Audit log and data retention
description: Review who changed what in your workspace, and choose how long closed tickets and the audit log are kept before they are deleted for good.
---

## The audit log

Go to **Desk → Admin → Audit log**. The page is listed for roles with the
`audit_log.view` permission. See [Roles and groups](/admin/roles-and-groups/)
for how to grant it.

The audit log is **append-only**. No one can edit or delete an entry, including
admins. Entries are removed only by the retention period you choose below.
Entries never contain message text or passwords.

### What is recorded

- Sign-ins and failed sign-ins.
- Changes to users, roles, permissions and group access.
- Changes to organization settings, including the old and new values.
- Support-access grants, revocations and reads. See
  [Support access](/admin/support-access/).
- Ticket activity, such as assignments and state changes.

### Read and filter the list

Entries are shown newest first, with **Time**, **Actor**, **Action** and
**Resource** columns. Choose **Load more** at the bottom to see older entries.

To narrow the list, fill in any of these fields and choose **Apply filters**.
**Clear** resets them.

| Field | What to enter |
| --- | --- |
| **Actor ID** | The ID of the person who made the change. |
| **Action** | An action code, such as `ticket.assigned`. |
| **Resource type** | The kind of thing that changed. |
| **Resource ID** | The ID of the thing that changed. |
| **From** and **To** | A time range. **To** must be after **From**. |

Actor ID and Resource ID must be valid IDs, or the page asks you to correct
them.

Select a row to open the **Audit entry** drawer. It shows the time, actor and
actor type, action and action code, resource, IP address, entry ID, and any
further details that were recorded.

## Data retention

Go to **Desk → Admin → Organization** and find **Data retention**. Saving
needs `tenant_settings.edit`. See
[Organization settings](/admin/organization-settings/).

### Keep closed tickets

**Keep closed tickets** offers **Forever** or **1 year** to **7 years**. Once a
ticket has been closed for longer than the period, it is deleted for good. The
purge runs daily at **03:15 UTC**. Open and resolved tickets are never purged.

A purge removes the ticket with its messages, attachments and files, history
and tags. If a newer follow-up ticket survives, its link to the deleted ticket
shows as "removed". The audit log gets one entry per purge that records the
counts only, not the content.

### Keep audit log

**Keep audit log** offers **Forever**, **1**, **2**, **3**, **5**, **7** or
**10 years**. The period is at least **1 year**. Older entries are removed
daily at **03:45 UTC**, and the removal records one entry with the number
deleted.

### Shortening ticket retention

If your change would delete tickets that are kept today, such as going from
**Forever** to **3 years**, or from **5 years** to **2 years**, the page asks
you to confirm before saving. The **Delete closed tickets?** dialog says how
many tickets will be deleted and that this can't be undone. Choose **Delete N
tickets and save** to continue, or **Cancel** to keep your current setting.

If the number changes while the dialog is open, the dialog shows the new count
and asks you to confirm again. Deletion is permanent, so export anything you
need first. Lengthening a period never deletes anything.
