/**
 * Absolute links to a tenant host for emails (invitations, sign-in links, password resets):
 * `{scheme}://{slug}.{BASE_DOMAIN}[:{port}]{path}`. Production uses the defaults (https, no
 * port); development sets `PUBLIC_URL_SCHEME=http` and `PUBLIC_URL_PORT=5173` (the Vite server).
 */
export function tenantUrl(slug: string, path: string): string {
  const baseDomain = process.env.BASE_DOMAIN;
  if (baseDomain === undefined || baseDomain === '') throw new Error('BASE_DOMAIN is not set');
  const scheme = process.env.PUBLIC_URL_SCHEME === 'http' ? 'http' : 'https';
  const port = process.env.PUBLIC_URL_PORT ?? '';
  if (port !== '' && !/^\d{1,5}$/.test(port)) throw new Error('PUBLIC_URL_PORT must be a port number');
  if (!path.startsWith('/')) throw new Error('tenantUrl path must start with /');
  return `${scheme}://${slug}.${baseDomain}${port === '' ? '' : `:${port}`}${path}`;
}
