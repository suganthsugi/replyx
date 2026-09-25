/**
 * Which of the three route areas a URL belongs to (research D21):
 * - the console host → the platform operator console;
 * - `/desk` and below on a tenant host → the agent/admin workspace;
 * - anything else on a tenant host → the customer chat.
 *
 * The console host is recognised by its first label, `console`: a reserved slug the API never
 * gives a tenant (RESERVED_SLUGS), so this needs no build-time config (`console.localhost` in
 * development, `console.replyx.app` in production).
 */

export type Area = 'console' | 'workspace' | 'customer';

export const WORKSPACE_BASE = '/desk';

export function isConsoleHost(hostname: string): boolean {
  return hostname.toLowerCase().split('.')[0] === 'console';
}

export function isWorkspacePath(pathname: string): boolean {
  return pathname === WORKSPACE_BASE || pathname.startsWith(`${WORKSPACE_BASE}/`);
}

export function resolveArea(hostname: string, pathname: string): Area {
  if (isConsoleHost(hostname)) return 'console';
  return isWorkspacePath(pathname) ? 'workspace' : 'customer';
}
