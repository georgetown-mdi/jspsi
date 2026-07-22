/**
 * The one bare-host rule for an SFTP locator, shared by the authoring form
 * ({@link ../bench/sftpConnectionForm}), the server's `PUT /api/jobs/sftp`
 * backstop ({@link ../jobs/sftpServer}), and the accept-side admission check
 * ({@link ../bench/acceptorModel}). Extracted so the three cannot drift: a value
 * one accepts as bare, the others must too.
 */

/**
 * The characters a bare SFTP host must not contain: userinfo (`@`), a scheme or
 * path separator (`/`, which also rules out `://`), and any ASCII whitespace. A
 * value carrying any of these is a URL fragment or login string, never a bare
 * address a partner-facing invitation endpoint may mint verbatim.
 */
const SFTP_HOST_DISALLOWED_CHAR = /[@/\t\n\v\f\r ]/;

/**
 * Whether `host` is a bare server address -- a hostname, an IPv4, or a bracketed
 * IPv6 literal -- carrying no userinfo, scheme, path, or whitespace. The single
 * predicate the form validation, the server PUT check, and the accept-side
 * refusal all consult, so the rule stays one authority.
 */
export function isBareSftpHost(host: string): boolean {
  return !SFTP_HOST_DISALLOWED_CHAR.test(host);
}
