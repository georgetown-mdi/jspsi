import { UsageError } from "@psilink/core";

/**
 * Render a URL as a string with any embedded credentials (the userinfo
 * component) removed, for echoing in a user-facing hint. `URL.href` preserves an
 * embedded password, which must never reach the terminal, logs, or shell
 * history; the partner supplies their own credentials, so the username is
 * dropped too and only the locator remains.
 *
 * @internal exported for testing
 */
export function redactUrlCredentials(url: URL): string {
  const safe = new URL(url.href);
  safe.username = "";
  safe.password = "";
  return safe.href;
}

/**
 * Decode a percent-encoded URL component (host, path, username, or password) to
 * the literal value the SFTP layer expects. The WHATWG `URL` parser keeps these
 * components percent-encoded -- including an `sftp://` host, which is parsed as
 * an opaque host whose non-ASCII (e.g. an internationalized domain) becomes
 * UTF-8 escapes -- but ssh2/ssh2-sftp-client consume them verbatim, so every
 * URL-to-config builder must decode before storing -- otherwise a path
 * `/my%20drop` opens a directory literally named `my%20drop` and a password
 * `p%20w` is sent to SSH as the literal string `p%20w`. A malformed escape (e.g.
 * a lone `%`) makes `decodeURIComponent` throw a `URIError`; surface it as a
 * `UsageError`, routed through `redactUrlCredentials` since the offending
 * component may be the password and must not be echoed.
 *
 * @internal exported for testing
 */
export function decodeUrlComponent(value: string, url: URL): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new UsageError(
      `malformed percent-encoding in URL: ${redactUrlCredentials(url)}`,
    );
  }
}
