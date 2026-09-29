/**
 * Parse `input` as a URL on `host` (a leading `www.` is ignored on both
 * sides; a missing `http(s)://` scheme is tolerated, since people paste
 * `github.com/owner/repo` as often as the full URL). Returns the decoded,
 * non-empty path segments plus the query string, or null when `input` isn't
 * a URL on that host at all.
 *
 * Shared by the Hangar/Spiget/GitHub clients' ref parsers so each matches
 * on the real hostname rather than a substring (`notgithub.com/...` must not
 * look like a GitHub URL).
 */
export function parseSourceUrl(
  input: string,
  host: string,
): { segments: string[]; searchParams: URLSearchParams } | null {
  const s = input.trim();
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, '');
  if (strip(url.hostname) !== strip(host)) return null;
  const segments: string[] = [];
  for (const raw of url.pathname.split('/')) {
    if (!raw) continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return { segments, searchParams: url.searchParams };
}
