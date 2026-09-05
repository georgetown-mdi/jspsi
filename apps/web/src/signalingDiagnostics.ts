import { getLogger } from "@psilink/core";

import type { SignalingDiagnosticSink } from "@psilink/peerjs-broker";

const log = getLogger("peerjs-broker");

/**
 * Where the signaling broker mounted in this server writes its diagnostics: a
 * prefixed `@psilink/core` logger, so a report lands beside the rest of the
 * server's output with the same timestamp, level and context on it.
 *
 * A module of its own rather than a closure inside the mount, so the unit suite
 * can drive the broker through the sink the deployment attaches rather than a
 * restatement of it. It is wired with no flag in front of it: an unwatched
 * broker is the case these reports exist for.
 *
 * The text arrives escaped, capped and rate limited from the broker's
 * diagnostics module, which is the one altitude that escapes
 * (CONTRIBUTING.md, Operator-facing escaping).
 */
export const signalingDiagnosticSink: SignalingDiagnosticSink = (message) => {
  log.warn(message);
};
