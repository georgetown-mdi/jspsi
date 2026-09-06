import {
  assessLinkageSatisfiability,
  decideLinkageTermsVerdict,
  getDefaultLinkageTerms,
  inferMetadata,
  overlongDisclosedColumnPositions,
} from "@psilink/core";

import {
  disclosedColumnNames,
  payloadSendForMetadata,
} from "@psi/metadataEditing";

import { linkageRefusalFor } from "@psi/linkageRefusal";

import type { LinkageStrategy, LinkageTerms, Metadata } from "@psilink/core";

import type { LinkageRefusal } from "@psi/linkageRefusal";

/**
 * The pure model behind the "Direct exchange" console: the symmetric spine's
 * steps, the agreed-server step's continue gate, and the browser-side terms
 * preview the confirm screen renders. No React, no I/O -- the tested boundary for
 * "the previewed terms match what the CLI infers from the same columns" and for
 * which unresolved surface the step names.
 */

/** The transport a direct exchange runs over. SFTP composes its connection from
 * the console's effective authored server (`PUT /api/jobs/sftp`); filedrop from
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
 * The identity the preview stands the operator's label in for. The preview is
 * memoized on the committed file rather than rebuilt per keystroke, so it does
 * not read the identity field at all. That costs nothing: the preview is never
 * displayed with an identity -- the confirm screen's self-terms ("proposing")
 * framing does not show the identity string -- and a run that leaves the field
 * blank sends no identity rather than a stand-in.
 */
export const DEFAULT_PREVIEW_IDENTITY = "you";

/** The strategy a direct run uses until the operator chooses otherwise: the
 * CLI's own default, which a zero-setup command selects by including no
 * `--linkage-strategy` at all. */
export const DIRECT_LINKAGE_STRATEGY_DEFAULT: LinkageStrategy = "cascade";

/**
 * What the confirm screen states beside the strategy choice. A zero-setup
 * exchange has each party infer terms from its own file rather than one party
 * authoring them for both, and the strategy is a mandatory-consistency term, so
 * the two parties must select the same value or the exchange aborts -- the same
 * thing `docs/CLI.md` says of `--linkage-strategy` on the zero-setup command.
 */
export const DIRECT_LINKAGE_STRATEGY_AGREEMENT_NOTICE =
  "You and your partner must choose the same option. Each of you reads terms " +
  "from your own file here, so a mismatch stops the exchange before any " +
  "records are compared.";

/**
 * The strategy field a zero-setup intent holds for the operator's choice.
 * Only a non-default choice is emitted, matching every other zero-setup flag
 * (see `zeroSetupOptionsArgv`): a zero-setup run loads no configuration file
 * for a flag to override, so `--linkage-strategy=cascade` and no flag select
 * the same strategy, and the graduated command line stays the shortest one
 * that runs what was prototyped.
 */
export function directLinkageStrategyIntentFields(strategy: LinkageStrategy): {
  linkageStrategy?: LinkageStrategy;
} {
  return strategy === DIRECT_LINKAGE_STRATEGY_DEFAULT
    ? {}
    : { linkageStrategy: strategy };
}

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
  /** Whether the diagnostics-and-recovery card holds an unconfirmed sweep. A
   * third separate card, gated separately for the same reason. */
  runDiagnosticsBlocked: boolean;
  /** Whether the authored connection and the retain choice disagree over the
   * split-directory precondition. The remedy is stated in full by the step's own
   * alert, so the gate holds the state rather than a second copy of it. */
  splitDirectoryBlocked: boolean;
}

/**
 * Why the agreed-server step cannot be left yet, as the sentence shown beside
 * the disabled Continue button -- `undefined` exactly when nothing blocks,
 * which is what the step enables on. The gate and the explanation are ONE
 * derivation, so a state that disables the button while saying nothing is
 * unrepresentable. The chain follows the step's own reading order, sending
 * the operator to the first unresolved surface, and each sentence names the
 * card to open (both authoring cards are collapsed disclosures whose problem
 * notice is invisible until opened).
 */
export function directServerBlockedReason(
  gates: DirectServerGates,
): string | undefined {
  if (!gates.transportReady)
    return gates.transport === "sftp"
      ? "Set up the SFTP connection above to continue."
      : "Mount a shared directory on this console, or choose SFTP, to continue.";
  if (gates.exchangeFilesBlocked)
    return "Resolve the file-handling settings above to continue.";
  if (gates.connectionTuningBlocked)
    return "Resolve the connection-tuning settings above to continue.";
  if (gates.runDiagnosticsBlocked)
    return "Resolve the diagnostics-and-recovery settings above to continue.";
  if (gates.splitDirectoryBlocked)
    return "Resolve the retain-mode requirement above to continue.";
  return undefined;
}

/** The browser-side preview of the terms this file is EXPECTED to produce at run
 * time, computed from its columns exactly as the CLI's zero-setup command does
 * (`inferMetadata` -> `getDefaultLinkageTerms`), plus the disclosed payload set the
 * inferred metadata sends and the linkage-terms refusal, if any. Read-only display
 * -- the CLI re-infers over the real file at run time, and a file edited between
 * preview and run desyncs, caught by the runtime two-party terms check. */
interface DirectTermsPreview {
  /** The inferred linkage terms, with `payload.send` authored from the disclosed
   * columns so the terms display accurately reflects what leaves the machine (the
   * default terms hold no payload block; disclosure rides the metadata at run
   * time). */
  linkageTerms: LinkageTerms;
  /** The inferred column metadata the terms derive from. */
  metadata: Metadata;
  /** The columns the inferred metadata discloses to the partner for matched
   * records -- what this file contributes on the wire. */
  disclosedPayloadColumns: Array<string>;
  /** The 1-based positions of the disclosed columns whose name is too long to
   * hold ({@link overlongDisclosedColumnPositions}); non-empty means the run
   * would be refused at prepare time, so the confirm screen refuses it here
   * instead. This spine has no disclosure control -- the inferred metadata sends
   * every non-linkage column -- so the remedy is a shorter header. */
  overlongDisclosedColumns: Array<number>;
  /** Why this file cannot be run under the previewed terms, or `undefined` when it
   * can. Derived from the same verdict the run boundary enforces, over the very
   * terms shown above, so the screen refuses exactly the files the run would. */
  refusal?: LinkageRefusal;
}

/**
 * Compute the direct-exchange terms preview from the input file's columns.
 * Mirrors the CLI's zero-setup inference (`prepareForExchange({}, identity,
 * rows, columns)`) so the preview matches what actually runs; `payload.send`
 * is authored from the inferred metadata's disclosed set, so the "columns
 * sent" display is accurate rather than empty. The operator's selected
 * `linkageStrategy` is applied over the inferred terms, mirroring how the CLI
 * applies `--linkage-strategy` over `prepareForExchange`'s terms.
 *
 * The refusal grades the PREVIEWED terms with the inferred metadata and no
 * authored standardization -- the same inputs `prepareForExchange` grades --
 * so the screen refuses exactly what the run would; when narrowing leaves no
 * key, the unsatisfied set is assessed against the FULL default terms
 * instead. `inferMetadata` throws on an empty column name, so callers pass
 * only named columns (the picker's commit refuses a blank header first).
 */
export function previewInferredTerms(
  columns: Array<string>,
  identity: string,
  linkageStrategy: LinkageStrategy,
): DirectTermsPreview {
  // Preview over columns the file step already committed: it read the header,
  // holds the sanitized positions, and refuses an empty name before this runs.
  const metadata = inferMetadata(columns, []);
  const linkageTerms = {
    ...getDefaultLinkageTerms(identity, metadata),
    linkageStrategy,
  };
  const payload = payloadSendForMetadata(metadata);
  if (payload !== undefined) linkageTerms.payload = payload;
  const refusal = linkageRefusalFor(
    decideLinkageTermsVerdict(columns, linkageTerms, undefined, metadata),
    assessLinkageSatisfiability(columns, getDefaultLinkageTerms(identity))
      .unsatisfied,
  );
  return {
    linkageTerms,
    metadata,
    disclosedPayloadColumns: disclosedColumnNames(metadata),
    overlongDisclosedColumns: overlongDisclosedColumnPositions(metadata),
    ...(refusal !== undefined && { refusal }),
  };
}
