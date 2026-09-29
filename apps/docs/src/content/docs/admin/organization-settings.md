---
title: Organization settings
description: Set your workspace name, chat color, messages, grace period and after-close behavior, and learn what each setting does for customers.
---

Go to **Desk → Admin → Organization**. The page is listed for roles with the
`tenant_settings.view` permission. Saving needs `tenant_settings.edit`. With
view only, the fields are read-only and the page says you can view the
settings but not change them. See [Roles and groups](/admin/roles-and-groups/)
for how to grant these permissions to a role.

Change any fields and choose **Save changes**. Only the fields you changed are
saved, and the button stays disabled until something valid has changed.

## Organization

- **Organization name** — required, up to **120 characters**. Customers see it
  in the chat header and in emails.
- **Time zone** — used for business hours and the times shown in emails.

## Branding

**Primary color** fills the customer's chat bubbles and the send button, with
white text on top. Enter a six-digit hex color such as `#1D4ED8`, or use the
color picker next to the field.

The color must have a contrast ratio of at least **4.5:1** with white text
(WCAG AA). Below the field, a live preview shows a mock chat with your color,
a **Passes AA** or **Fails AA** label and the measured ratio. If the color
fails, a warning offers **Use suggested color**, the closest color that
passes. The server checks the ratio again when you save and refuses a color
that fails.

Logo and accent color settings are not available yet.

## Customer chat

- **Welcome message** — greets customers who open the chat. Up to **500
  characters**. It also appears in the branding preview.
- **Out-of-hours message** — shown when nobody is available. Up to **500
  characters**.
- **When a customer has left the chat** — choose how a customer hears about a
  reply sent while they are away:
  - **Email them the reply** — the customer gets the reply by email.
  - **Do not notify** — the customer sees the reply only when they come back.

Clear a message field and save to remove that message.

## Sign-up and closing

- **Let customers sign up themselves** — when on, anyone with an email address
  can start a chat. When off, customers cannot create their own account.

### Grace period

**Grace period (hours)** is how long a resolved ticket stays open to a reply.
Enter a whole number from **1** to **720**. The default is **72 hours**
(3 days).

- If the customer writes within the grace period, the ticket reopens and keeps
  its group and owner.
- If the grace period ends with no reply, the ticket closes automatically.

### After-close behavior

**When a customer writes after it closed** decides what happens to a message
that arrives once the ticket is closed:

| Option | Result |
| --- | --- |
| **Start a new conversation** (default) | A new ticket is created and linked to the old one as a follow-up. It is routed like any new ticket. |
| **Reopen the previous conversation** | The closed ticket reopens instead. |

Customers never see this split. They see one continuous conversation either
way.

## Audit log

Each save is recorded in the audit log with who made the change and the old
and new values.
