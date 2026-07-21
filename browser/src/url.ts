/** First pass over user-typed text (address bar, new-tab search): keeps
 * anything that already looks like a url or host, otherwise turns it into a
 * google search. The controller runs the result through normalizeUrl before
 * loading it. */
export function searchOrUrl(text: string): string {
  const trimmed = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (!trimmed.includes(" ") && trimmed.includes(".")) return trimmed;
  if (/^[\w-]+:\d+(\/.*)?$/.test(trimmed)) return trimmed;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

/** Turns navigation input into a loadable url: bare hosts get a scheme
 * (http for localhost, https otherwise), anything unparseable becomes a
 * google search. */
export function normalizeUrl(value: string): string {
  const input = value.trim();
  if (!input) return "about:blank";
  try {
    return new URL(input).toString();
  } catch {}
  if (/^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(input)) {
    const host = input.split(/[:/]/)[0].toLowerCase();
    const scheme = host === "localhost" || host === "127.0.0.1" ? "http" : "https";
    return new URL(`${scheme}://${input}`).toString();
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

/** Compact form shown in the tab strip. */
export function displayUrl(url: string): string {
  if (!url || url === "about:blank") return "new tab";
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
