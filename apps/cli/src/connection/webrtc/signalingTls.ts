import { isIP } from "node:net";
import { connect } from "node:tls";

import type { BrokerLocation } from "./brokerClient";
import type { TLSSocket } from "node:tls";

/**
 * Why a TLS signaling socket would not come up, answered after it has already
 * failed.
 *
 * The `WebSocket` the broker client dials reports a failed `wss://` handshake
 * as an `error` event holding an empty `TypeError` -- no code, no message, and
 * no certificate (measured against the Node global `WebSocket`) -- so the one
 * failure an operator on a managed network hits most, a TLS-intercepting proxy
 * whose certificate authority this machine does not trust, is indistinguishable
 * from a broker that is simply down. This module answers that question by
 * handshaking with the same endpoint once more and reporting what the
 * certificate check said.
 *
 * Verification stays ON for the handshake, so no unverified TLS socket exists
 * at any point: `authorizationError` is set exactly when the certificate check
 * is what failed, and is null for a connection that never got that far
 * (measured: a refused port reports `ECONNREFUSED` with a null
 * `authorizationError`). The socket is destroyed as soon as either outcome is
 * known and nothing is ever written to it.
 *
 * The probe dials the configured endpoint's own host and port directly, so
 * what it answers is about that connection. A run with Node's environment
 * proxying configured dials the `WebSocket` through the proxy instead, which
 * is a different path and can present a different certificate, so a caller
 * asks {@link environmentProxyingConfigured} first and reports such a failure
 * without a certificate verdict rather than with one about the origin.
 */

/**
 * Ceiling on the diagnostic handshake. The failure it explains has already
 * happened, so a server that accepts the connection and then says nothing --
 * a plaintext port answering a TLS dial, measured to hang rather than fail --
 * must not hold the report open.
 */
export const SIGNALING_TLS_PROBE_TIMEOUT_MS = 5_000;

/**
 * Answers what the certificate check said about a signaling endpoint: the
 * verification failure's code, or `undefined` when the certificate was not the
 * problem. `signal` releases the handshake, answering `undefined` at once.
 */
export type SignalingCertificateProbe = (
  location: BrokerLocation,
  signal?: AbortSignal,
) => Promise<string | undefined>;

/**
 * The one value `NODE_USE_ENV_PROXY` opts in with: measured on Node 26 against
 * a CONNECT proxy, "true", "yes" and "0" all leave a `wss://` dial direct.
 */
const ENVIRONMENT_PROXY_OPT_IN = "1";

/**
 * The variables the proxy for a `wss://` dial is read from. Measured on the
 * same run: each of the four routes the dial, the `http` pair included, and
 * `ALL_PROXY` routes nothing. Both measurements are held against a real proxy
 * by test/integration/webrtc/signalingCertificate.test.ts, so a Node upgrade
 * that moves either is a failing test rather than an operator told about a
 * certificate their dial never reached.
 */
const PROXY_ENVIRONMENT_VARIABLES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
];

/**
 * Whether this run has the environment proxying configured that a `wss://`
 * dial follows and {@link probeSignalingCertificate} does not.
 *
 * It answers for the run, not for one endpoint: `NO_PROXY` excludes hosts from
 * the proxy per dial, which is Node's resolution to make rather than one to
 * reproduce here, so a run excluding the signaling host is still answered yes.
 * Node reads the opt-in as the process starts, so a value written into
 * `process.env` after that changes this answer without changing the dial.
 */
export function environmentProxyingConfigured(): boolean {
  if (process.env.NODE_USE_ENV_PROXY !== ENVIRONMENT_PROXY_OPT_IN) return false;
  return PROXY_ENVIRONMENT_VARIABLES.some(
    (variable) => (process.env[variable] ?? "") !== "",
  );
}

/**
 * The host to hand `tls.connect`: the URL parser's, with an IPv6 literal's
 * brackets removed.
 *
 * The brackets are URL syntax rather than part of the address, and `tls.connect`
 * resolves what it is given as written -- measured against a self-signed
 * listener on `::1`, "[::1]" reports `ENOTFOUND` with no certificate check
 * having run, "::1" reports `DEPTH_ZERO_SELF_SIGNED_CERT`. Parsing rather than
 * reading `host` is what makes this the same authority the signaling socket
 * dialed, IDNA normalization included.
 */
function dialedHost(location: BrokerLocation): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(`wss://${location.host}`);
  } catch {
    return undefined;
  }
  const { hostname } = parsed;
  return hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
}

/** Read `authorizationError`, which Node sets as a code string or an Error. */
function verificationFailureCode(socket: TLSSocket): string | undefined {
  const failure: unknown = socket.authorizationError;
  if (typeof failure === "string") return failure === "" ? undefined : failure;
  if (failure instanceof Error) {
    const code = (failure as { code?: unknown }).code;
    return typeof code === "string" ? code : failure.message;
  }
  return undefined;
}

/**
 * Handshake with `location` once and report the certificate verification
 * failure, if that is what stopped it.
 *
 * Never rejects: every outcome that is not a verification failure -- the
 * handshake succeeding, the connection failing before TLS, the ceiling
 * expiring, `signal` aborting, a `host` that does not parse -- is `undefined`,
 * because the caller already has a failure to report and this only adds to it.
 */
export const probeSignalingCertificate: SignalingCertificateProbe = (
  location,
  signal,
) =>
  new Promise<string | undefined>((resolve) => {
    const host = dialedHost(location);
    if (!location.secure || host === undefined || signal?.aborted === true) {
      resolve(undefined);
      return;
    }
    // SNI is what an endpoint holding more than one certificate selects by, so
    // a probe that sends a different one answers about a different certificate.
    // Measured on Node 26: `tls.connect` sends no server name unless
    // `servername` is given, while the `WebSocket` dial does send the host's.
    // RFC 6066 excludes an IP literal, which Node enforces by throwing on one.
    const port = location.port;
    let socket: TLSSocket;
    try {
      socket =
        isIP(host) === 0
          ? connect({ host, port, servername: host })
          : connect({ host, port });
    } catch {
      resolve(undefined);
      return;
    }
    // The socket is left referenced although the ceiling above is not: both
    // unreferenced, a run whose last live handle is this handshake exits before
    // the failure it explains is reported (measured: the answer never arrives).
    // An interrupt releases it by destroying it below instead.
    const timer = setTimeout(
      () => settle(undefined),
      SIGNALING_TLS_PROBE_TIMEOUT_MS,
    );
    timer.unref();
    function settle(code: string | undefined): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(code);
    }
    function onAbort(): void {
      settle(undefined);
    }
    signal?.addEventListener("abort", onAbort);
    socket.on("secureConnect", () => settle(undefined));
    socket.on("error", () => settle(verificationFailureCode(socket)));
  });
