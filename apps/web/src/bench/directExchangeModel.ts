import {
  assessLinkageSatisfiability,
  getDefaultLinkageTerms,
  inferMetadata,
  overlongDisclosedColumnPositions,
} from "@psilink/core";

import {
  disclosedColumnNames,
  payloadSendForMetadata,
} from "@psi/metadataEditing";

import type { LinkageField, LinkageTerms, Metadata } from "@psilink/core";

/**
 * The pure model behind the console "Direct exchange" bench: the symmetric spine's
 * steps, the agreed-server step's continue gate, and the browser-side terms
 * preview the confirm screen renders. No React, no I/O -- the tested boundary for
 * "the previewed terms match what the CLI infers from the same columns" and for
 * which unresolved surface the step names.
 */

/** The transport a direct exchange runs over. SFTP composes its connection from
 * the appliance's effective authored server (`PUT /api/jobs/sftp`); filedrop from
 * the operator-configured rendezvous mount. No WebRTC arm, mirroring the CLI's
 * zero-setup channels. */
export type DirectTransport = "sftp" | "filedrop";

/** The four steps of the direct-exchange spine: choose the mounted input, author
 * the agreed server, confirm the inferred terms and affirm the trust model, then
 * run. Symmetric -- both parties walk the same steps against their own file. */
export type DirectStep = "file" | "server" | "confirm" | "run";

/** The step labels the top-bar stepper shows. */
export const DIRECT_STEP_LABELS: Record<DirectStep, string> = {
  file: "Your file",
  server: "Agreed server",
  confirm: "Confirm & run",
  run: "Results",
};

/** The spine order the stepper walks. */
export const DIRECT_STEP_ORDER: ReadonlyArray<DirectStep> = [
  "file",
  "server",
  "confirm",
  "run",
];

/**
 * The identity the preview uses when the operator leaves the optional identity
 * field blank. The real run defaults `--identity` to the appliance user (the
 * container account), which the browser cannot read, so the preview uses this
 * neutral placeholder. It is never displayed: the confirm screen shows the
 * inferred terms under a self-terms ("proposing") framing that does not surface
 * the identity string, and the preview copy states plainly that a blank field
 * runs as the appliance user.
 */
export const DEFAULT_PREVIEW_IDENTITY = "you";

/** What the agreed-server step is waiting on, by the reading order of the screen
 * itself: the transport at the top, then the two authoring cards below it, then
 * the retain-mode precondition stated just above the button. */
export interface DirectServerGates {
  transport: DirectTransport;
  /** Whether the chosen transport is usable: an authored SFTP connection, or a
   * mounted rendezvous directory. */
  transportReady: boolean;
  /** Whether the file-handling card holds a combination core refuses. */
  exchangeFilesBlocked: boolean;
  /** Whether the connection-tuning card holds a value the run would refuse.
   * Separate from {@link exchangeFilesBlocked} because the two are separate
   * cards, and the sentence below names the one to open. */
  connectionTuningBlocked: boolean;
  /** Whether the authored connection and the retain choice disagree over the
   * split-directory precondition. The remedy is stated in full by the step's own
   * alert, so the gate carries the state rather than a second copy of it. */
  splitDirectoryBlocked: boolean;
}

/**
 * Why the agreed-server step cannot be left yet, as the sentence shown beside the
 * disabled Continue button -- `undefined` exactly when nothing blocks, which is
 * what the step enables on. The gate and the explanation are ONE derivation, so a
 * state that disables the button while saying nothing is unrepresentable rather
 * than merely tested against.
 *
 * The chain follows the step's own reading order, so an operator working down the
 * screen is sent to the first unresolved surface they meet, and each sentence
 * names the card to open: both authoring cards are collapsed disclosures whose
 * own problem notice is invisible until they are.
 */
export function directServerBlockedReason(
  gates: DirectServerGates,
): string | undefined {
  if (!gates.transportReady)
    return gates.transport === "sftp"
      ? "Set up the SFTP connection above to continue."
      : "Mount a shared directory on this appliance, or choose SFTP, to continue.";
  if (gates.exchangeFilesBlocked)
    return "Resolve the file-handling settings above to continue.";
  if (gates.connectionTuningBlocked)
    return "Resolve the connection-tuning settings above to continue.";
  if (gates.splitDirectoryBlocked)
    return "Resolve the retain-mode requirement above to continue.";
  return undefined;
}

/** The browser-side preview of the terms this file is EXPECTED to produce at run
 * time, computed from its columns exactly as the CLI's zero-setup command does
 * (`inferMetadata` -> `getDefaultLinkageTerms`), plus the disclosed payload set the
 * inferred metadata sends and the satisfiability verdict. Read-only display -- the
 * CLI re-infers over the real file at run time, and a file edited between preview
 * and run desyncs, caught by the runtime two-party terms check. */
export interface DirectTermsPreview {
  /** The inferred linkage terms, with `payload.send` authored from the disclosed
   * columns so the terms display honestly reflects what leaves the machine (the
   * default terms carry no payload block; disclosure rides the metadata at run
   * time). */
  linkageTerms: LinkageTerms;
  /** The inferred column metadata the terms derive from. */
  metadata: Metadata;
  /** The columns the inferred metadata discloses to the partner for matched
   * records -- what this file contributes on the wire. */
  disclosedPayloadColumns: Array<string>;
  /** The 1-based positions of the disclosed columns whose name is too long to
   * carry ({@link overlongDisclosedColumnPositions}); non-empty means the run
   * would be refused at prepare time, so the confirm screen refuses it here
   * instead. This spine has no disclosure control -- the inferred metadata sends
   * every non-linkage column -- so the remedy is a shorter header. */
  overlongDisclosedColumns: Array<number>;
  /** The count of default linkage keys the columns can satisfy; zero means the
   * file backs no match and the exchange would run to a silent empty result. */
  satisfiableKeyCount: number;
  /** The default linkage fields the columns cannot produce, to name the missing
   * field types when the file is unlinkable. */
  unsatisfied: Array<LinkageField>;
}

/**
 * Compute the direct-exchange terms preview from the input file's columns. Mirrors
 * the CLI's zero-setup inference (`prepareForExchange({}, identity, rows, columns)`
 * infers metadata then default terms) so the preview matches what actually runs;
 * `payload.send` is authored from the inferred metadata's disclosed set the same
 * way the quick-invitation mint does, so the "columns sent" display is honest
 * rather than empty. Satisfiability is assessed against the FULL default terms so
 * the unsatisfied set can name the missing field types.
 *
 * `inferMetadata` throws on an empty column name; the picker's commit refuses a
 * blank header before the preview is computed, so callers pass only named columns.
 */
export function previewInferredTerms(
  columns: Array<string>,
  identity: string,
): DirectTermsPreview {
  const metadata = inferMetadata(columns);
  const linkageTerms = getDefaultLinkageTerms(identity, metadata);
  const payload = payloadSendForMetadata(metadata);
  if (payload !== undefined) linkageTerms.payload = payload;
  const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
    columns,
    getDefaultLinkageTerms(identity),
  );
  return {
    linkageTerms,
    metadata,
    disclosedPayloadColumns: disclosedColumnNames(metadata),
    overlongDisclosedColumns: overlongDisclosedColumnPositions(metadata),
    satisfiableKeyCount,
    unsatisfied,
  };
}
