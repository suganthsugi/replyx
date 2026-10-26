# Security policy

## Reporting a vulnerability

Please do not report security issues in public issues, discussions or pull requests.

Report them privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Include the affected version or commit, steps to reproduce and the
impact you expect.

You should get a first response within 7 days. We will keep you updated while we work on a fix
and credit you in the release notes unless you would rather stay anonymous.

## Scope

Reports we are most interested in:

- Data from one tenant visible to or changeable by another tenant.
- Authentication or session bypass, privilege escalation between roles.
- Server-side request forgery through webhooks or store connections.
- Injection, cross-site scripting or CSRF in the staff desk, customer chat or console.

## Supported versions

Only the latest release on the `main` branch receives security fixes.

## Deployment hardening

When you self-host ReplyX, generate fresh values for every secret in `infra/.env.prod`
(`infra/scripts/init-env.sh` does this) and never reuse the development values from `.env.example`.
Keep PostgreSQL, Valkey and the internal Caddy port off the public network.
