---
name: shell-edit-pitfalls
description: Bash-tool edits that silently mangle backslashes/backticks, CRLF working copies, and audit detail keys that get dropped
metadata:
  type: project
---

- Backslashes in inline `node - <<EOF` / bash heredocs reaching the Bash tool get halved (`\\unset` became `\unset`, so `\g`, `\u` escapes broke or vanished silently). For files with psql meta-commands (`infra/postgres/init.sql`) or backticks, write the patch script to the scratchpad with the Write tool and run it, or use Edit.
- `.env.example` has a CRLF working copy (index is LF); string replaces with `\n` do not match. Normalize `\r\n` -> `\n`, replace, convert back. `init.sql` and `compose.yaml` are LF.
- `AuditService.record` drops detail keys named messages/message/body/text/content/link/token(s)/secret at any depth (`audit/audit.service.ts` FORBIDDEN_KEY). Name count fields `messageCount`, `ticketCount`, ... or they vanish from the audit entry.
- `grant_app_dml` only accepts replyx_app/replyx_platform; a third role (replyx_retention, migration 0012) needs a raw GRANT. init.sql retention password is optional (role NOLOGIN without it) so existing test/dev env keeps working without REPLYX_RETENTION_PASSWORD.

**Why:** each cost a failed edit or a silently wrong result during T193.

**How to apply:** check the diff after any scripted edit; verify a role over the network (second container), see [[project_postgres-rls-gotchas]].
