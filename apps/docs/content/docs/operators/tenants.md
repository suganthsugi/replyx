---
title: Tenants
description: Sign in to the platform console, manage tenants, and open support sessions.
---

Platform operators manage every tenant (workspace) on ReplyX from the platform
console — a separate host from any tenant's own site, and separate from
[staff and customer sign-in](/guides/signing-in/).

## Signing in to the console

Go to the console host (for example `console.replyx.app`) and sign in with
your operator email and password. After **5 failed attempts**, the account is
locked for **15 minutes**.

## The tenant list

The console's home page lists every tenant, with:

- **Name** and **address** — the address is the tenant's slug, used in its
  URL.
- **Status** — **Active** or **Suspended**.
- **Staff** and **Customers** — how many users of each kind the tenant has.
- **Support access** — whether the tenant's admins have granted a support
  session, and until when. Shows **Not granted** otherwise.

Use **Search** to filter by name or address, and **Status** to show only
active or only suspended tenants.

## Creating a tenant

Select **Create a tenant** and provide:

- **Workspace name** — shown to the tenant's own users.
- **Address** — lowercase letters, digits and single hyphens, 3 to 40
  characters. Some addresses are reserved or already taken and will be
  rejected.
- **First admin's email** — this person receives an invitation to set their
  password and signs in with the **Admin** role.

## Suspending a tenant

Select **Suspend** on a tenant to make it unreachable without deleting
anything:

- Everyone at the tenant is signed out immediately, and any open connections
  are closed.
- Customers see **Support is unavailable** wherever they try to reach the
  workspace.
- Staff sign-in is blocked.
- The tenant's outgoing webhooks and notifications pause.
- No data is deleted.

The suspension is recorded in the tenant's audit log.

## Reactivating a tenant

Select **Reactivate** on a suspended tenant. Access returns immediately, and
the tenant's data is unchanged.

## Support sessions

A support session gives an operator temporary, read-only access to one
tenant's workspace — but only when that tenant's admins have granted
[support access](/admin/support-access/). Select **Support session** on a
tenant and then **Open a support session**.

If the tenant hasn't granted access, you'll see: "This workspace has not
granted support access. An admin there has to grant it first."

If it has, opening the session shows:

- A link to the tenant's workspace.
- An **access token**, shown once. Send it as the `X-Support-Token` header
  when you access the tenant's site.

The session is read-only — nothing you do can change the tenant's data — and
every page you open is written to the tenant's audit log. It ends at the
grant's expiry, or the moment an admin at the tenant revokes it, whichever
comes first.
