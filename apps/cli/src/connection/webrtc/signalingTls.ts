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
 * problem.
 */
export type SignalingCertificateProbe = (
  location: BrokerLocation,
) => Promise<string | undefined>;

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
 * expiring -- is `undefined`, because the caller already has a failure to
 * report and this only adds to it.
 */
export const probeSignalingCertificate: SignalingCertificateProbe = (
  location,
) =>
  new Promise<string | undefined>((resolve) => {
    if (!location.secure) {
      resolve(undefined);
      return;
    }
    // `servername` is left to tls.connect, which derives SNI from `host` and
    // omits it for an IP literal, where SNI is not defined.
    let socket: TLSSocket;
    try {
      socket = connect({ host: location.host, port: location.port });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(undefined);
    }, SIGNALING_TLS_PROBE_TIMEOUT_MS);
    timer.unref();
    const settle = (code: string | undefined): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(code);
    };
    socket.on("secureConnect", () => settle(undefined));
    socket.on("error", () => settle(verificationFailureCode(socket)));
  });
