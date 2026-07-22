import {
  assessLinkageSatisfiability,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@psilink/core";

import {
  disclosedColumnNames,
  payloadSendForMetadata,
} from "@psi/metadataEditing";

import type { LinkageField, LinkageTerms, Metadata } from "@psilink/core";

/**
 * The pure model behind the console "Direct exchange" bench: the symmetric spine's
 * steps and the browser-side terms preview the confirm screen renders. No React,
 * no I/O -- the tested boundary for "the previewed terms match what the CLI infers
 * from the same columns".
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
    satisfiableKeyCount,
    unsatisfied,
  };
}
