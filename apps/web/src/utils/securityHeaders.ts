/**
 * Defense-in-depth response headers set on every response the web app serves.
 *
 * The confidential invitation token rides in the URL fragment, which browsers
 * already withhold from `Referer`; `Referrer-Policy: no-referrer` extends that
 * to older clients and to any future surface that is not the fragment, and the
 * app never needs to send a referrer of its own. `X-Frame-Options: DENY` and the
 * CSP `frame-ancestors 'none'` both deny framing (clickjacking): the CSP form for
 * modern clients, the legacy header for older ones. The CSP carries only the
 * framing directive, so it imposes no other content policy; if a fuller CSP is
 * ever added, `frame-ancestors 'none'` subsumes `X-Frame-Options: DENY`. Extend
 * this one value to add such a policy rather than setting a second
 * `Content-Security-Policy` header: a browser enforces the intersection of
 * multiple CSP headers, which can silently tighten and break the page.
 */
export const securityResponseHeaders: Readonly<Record<string, string>> = {
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

/**
 * Applies {@link securityResponseHeaders} to `response`, returning a new response
 * with the original's status, statusText, body, and headers plus the security
 * headers. It rebuilds rather than setting the headers on the original in place
 * so it works even when those headers are immutable (a redirect or
 * `fetch`-derived response), and in doing so consumes the original's body stream
 * -- do not reuse the argument after calling. A response whose status is outside
 * the 200-599 range the Response constructor accepts (a status-0
 * `Response.error()`, or a 1xx) cannot be rebuilt and carries no framing- or
 * referrer-relevant document, so it is returned unchanged rather than allowed to
 * throw on this per-response chokepoint.
 */
export function withSecurityHeaders(response: Response): Response {
  if (response.status < 200 || response.status > 599) return response;
  const hardened = new Response(response.body, response);
  for (const [name, value] of Object.entries(securityResponseHeaders)) {
    hardened.headers.set(name, value);
  }
  return hardened;
}
