/** Default subdomain suggestion for mc-router: lowercase, url-safe, max 30 chars.
 *  Mirrors the backend's subdomain validation regex in servers.controller.ts. */
export function slugify(input: string, maxLen = 30): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.slice(0, maxLen).replace(/-$/, '');
}
