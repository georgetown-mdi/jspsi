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
 * ever added, `frame-ancestors 'none'` subsumes `X-Frame-Options: DENY`.
 */
export const securityResponseHeaders: Readonly<Record<string, string>> = {
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

/**
 * Returns a copy of `response` carrying {@link securityResponseHeaders}. It
 * rebuilds the response rather than mutating the original's headers in place, so
 * it applies the headers regardless of whether the source's headers are mutable
 * (a redirect or `fetch`-derived response is immutable) without resting on that.
 */
export function withSecurityHeaders(response: Response): Response {
  const hardened = new Response(response.body, response);
  for (const [name, value] of Object.entries(securityResponseHeaders)) {
    hardened.headers.set(name, value);
  }
  return hardened;
}
