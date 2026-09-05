import {
  safeParseFileSyncOptions,
  withRetainModeImplications,
} from "@psilink/core";

import {
  PEER_ID_SHAPE_MESSAGE,
  isAdmissiblePeerId,
} from "@psi/transport/peerIdLabel";

import type { JobExchangeOptions } from "@jobs/intent";

/**
 * The pure model behind the console's "Exchange files" authoring card: how the
 * operator's retain-mode and file-sync choices become the tuning `options` a
 * server job takes, and what the card refuses before the run starts.
 *
 * No React and no I/O, so the implication chain, the schema-rejection path, and
 * the emitted option block are the tested boundary. Every rule about the values
 * themselves is core's: {@link withRetainModeImplications} resolves what retain
 * mode implies and {@link safeParseFileSyncOptions} decides whether a combination
 * is admissible, so the card can neither drift from the CLI nor invent a stricter
 * rule of its own.
 */

/**
 * A file-sync toggle as the card holds it. `auto` leaves the field unset, so
 * retain mode's implication (or core's own default) decides it; `on` and `off`
 * state it explicitly, exactly as the CLI's flag and its negation do.
 *
 * The three states are not decoration: stating `on` is how an operator gets a
 * `peer_id` without retain mode (core requires `timestamp_in_filename` for one),
 * and stating `off` is how they can author a combination core refuses -- which
 * the card shows as a form problem rather than a failed run.
 */
export type FileSyncToggle = "auto" | "on" | "off";

/**
 * The foreign-file policy as the card holds it. `auto` leaves the field unset, so
 * core's mode-coupled default applies (`error` on a plain delete-mode transport,
 * `warn` once retain mode or lockless rendezvous is on); the other three state
 * core's `unexpected_files` values explicitly.
 */
export type UnexpectedFilesChoice = "auto" | "error" | "warn" | "ignore";

/** The operator's authored file-handling choices for one exchange. `peerId` is
 * held as the raw field text; blank means unset. */
export interface ExchangeFilesDraft {
  retainFiles: boolean;
  timestampInFilename: FileSyncToggle;
  locklessRendezvous: FileSyncToggle;
  peerId: string;
  unexpectedFiles: UnexpectedFilesChoice;
}

/** The card's starting state: retain mode off and every other choice left to
 * core's defaults, which is the behaviour a console exchange has today. */
export const EXCHANGE_FILES_DEFAULT: ExchangeFilesDraft = {
  retainFiles: false,
  timestampInFilename: "auto",
  locklessRendezvous: "auto",
  peerId: "",
  unexpectedFiles: "auto",
};

/**
 * What the card states about retain mode before the run starts, mirroring the
 * fact the CLI announces at run time (`announceRetainMode`): the trio is a
 * bilateral agreement with no negotiation, and a mismatch is only detected at
 * rendezvous. Stated up front here because the console is where the operator can
 * still act on it -- by telling their partner -- rather than after a failed run.
 */
export const RETAIN_MODE_BILATERAL_NOTICE =
  "Retain mode is an agreement, not a negotiation. Your partner must turn on " +
  "the same three settings (retain, timestamped filenames, lockless " +
  "rendezvous) on their side, and you must both start from an empty shared " +
  "directory. A mismatch is only discovered when the two sides meet, and the " +
  "exchange then stops with an error.";

/** Resolve a {@link FileSyncToggle} to the boolean the option block holds, or
 * undefined for `auto` (the field is left off entirely). */
function toggleValue(toggle: FileSyncToggle): boolean | undefined {
  if (toggle === "on") return true;
  if (toggle === "off") return false;
  return undefined;
}

/**
 * The tuning `options` block a draft contributes to a job intent, or undefined
 * when the operator changed nothing (so the intent omits the block and the
 * composed config holds no `options` at all).
 *
 * Retain mode's implications are resolved through core's
 * {@link withRetainModeImplications}: turning retain on and leaving the other two
 * on `auto` yields all three, exactly as `--retain-files` alone does at the
 * command line. An explicitly-off toggle is left as the operator stated it, so
 * the contradiction reaches {@link exchangeFilesProblems} rather than being
 * silently corrected.
 *
 * `unexpectedFiles` is included only when the caller's flow can hold it (see
 * {@link ExchangeFilesCapabilities}); a flow that cannot must not put a value on
 * the intent that would be dropped downstream.
 */
export function exchangeFilesOptions(
  draft: ExchangeFilesDraft,
  capabilities: ExchangeFilesCapabilities = { unexpectedFiles: true },
): JobExchangeOptions | undefined {
  const timestampInFilename = toggleValue(draft.timestampInFilename);
  const locklessRendezvous = toggleValue(draft.locklessRendezvous);
  const peerId = draft.peerId.trim();
  const stated: JobExchangeOptions = {
    ...(draft.retainFiles ? { retainFiles: true } : {}),
    ...(timestampInFilename !== undefined ? { timestampInFilename } : {}),
    ...(locklessRendezvous !== undefined ? { locklessRendezvous } : {}),
    ...(peerId !== "" ? { peerId } : {}),
    ...(capabilities.unexpectedFiles && draft.unexpectedFiles !== "auto"
      ? { unexpectedFiles: draft.unexpectedFiles }
      : {}),
  };
  const resolved = withRetainModeImplications(stated);
  return Object.keys(resolved).length === 0 ? undefined : resolved;
}

/** Which of the card's controls the calling flow can actually hold. A zero-setup
 * (Direct) run composes no configuration document, and `unexpected_files` has no
 * CLI flag, so that one control is offered only where a config document is
 * composed. */
export interface ExchangeFilesCapabilities {
  unexpectedFiles: boolean;
}

/** The capabilities of a flow that composes a `psilink.yaml` (the invitation
 * flows): every control the card offers reaches the run as a configuration key. */
export const CONFIG_EXCHANGE_FILES: ExchangeFilesCapabilities = {
  unexpectedFiles: true,
};

/**
 * The capabilities of a flow whose whole configuration is the command line (the
 * Direct, zero-setup flow). `unexpected_files` is a configuration-only key with no
 * CLI flag, so it cannot ride a zero-setup command and the card withholds it here
 * rather than accepting a value the run would drop. Retain mode's trio and the
 * party name all have flags, so those are included in full.
 */
export const ZERO_SETUP_EXCHANGE_FILES: ExchangeFilesCapabilities = {
  unexpectedFiles: false,
};

/**
 * Everything wrong with the draft, as messages to show beside the card -- empty
 * when it is admissible. The run is blocked while this is non-empty, so a
 * combination core would refuse is caught here, at authoring time, instead of
 * failing the job.
 *
 * The peer-id SHAPE rule is this boundary's ({@link isAdmissiblePeerId}: the
 * label becomes a filename in a server-owned directory). Every other rule --
 * `peer_id` requires timestamped filenames, `peer_id` may not be the reserved
 * `temp`, retain mode requires both of its implications -- comes from core's own
 * schema, reported in core's words, so the console never states a rule the CLI
 * does not enforce.
 */
export function exchangeFilesProblems(
  draft: ExchangeFilesDraft,
  capabilities: ExchangeFilesCapabilities = { unexpectedFiles: true },
): Array<string> {
  const peerId = draft.peerId.trim();
  if (peerId !== "" && !isAdmissiblePeerId(peerId))
    return [PEER_ID_SHAPE_MESSAGE];
  const options = exchangeFilesOptions(draft, capabilities);
  if (options === undefined) return [];
  const validation = safeParseFileSyncOptions(options);
  if (validation.success) return [];
  return validation.error.issues.map((issue) => issue.message);
}
