import { disclosedColumnNames, sanitizeForDisplay } from "@psilink/core";

import { commitAcceptance } from "@psi/acceptConsent";
import { isBareSftpHost } from "@psi/sftpHost";
import { summarizeInvitation } from "@psi/invitationSummary";

import { TRANSPORT_LEDGER_LABELS, dateTimeLabel } from "./inviterModel";
import { saveRailNote } from "./saveExchangeModel";

import type { InvitationToken, LinkageTerms, Metadata } from "@psilink/core";
import type { RailFact, RailStepState } from "./inviterModel";
import type { AcceptableInvitation } from "@psi/acceptInvitation";

/**
 * The pure model behind the acceptor bench's three-step spine: the step
 * progression the top bar walks, the disclosure ledger built from the decoded
 * invitation's terms and the acceptor's own live metadata disclosure, the single
 * Customize fact, and the consent-gate helper the consent step submits through. No
 * React and no I/O -- the tested boundary for "the spine derives
 * done/current/pending", "the ledger names exactly what the acceptor sends", and
 * "the consent gate blocks until both the checkbox and a non-empty name are
 * supplied".
 *
 * The send rows state what actually leaves this browser, which is governed by the
 * acceptor's OWN metadata ({@link disclosedColumnNames}, the set core's
 * `preparePayload` transmits), never by the inviter's authored request. The
 * inviter's `payload.receive` mirrors only to a data-dictionary CLAIM on the
 * acceptor's `payload.send`, which core holds equal to the disclosed set (or the
 * run aborts) -- so the disclosed metadata is the one honest source in every state.
 * Before a file exists there is no metadata, so the send rows use the invitation's
 * forward-reference wording (the exact set is confirmed after choosing a file),
 * matching {@link InvitationTerms}. Partner-controlled strings reach the ledger
 * through {@link summarizeInvitation}, the one sanitizing boundary; the acceptor's
 * own column names are sanitized per name here, as the columns-step summary does.
 */

/** The acceptor's three spine steps, in order -- the steps the top bar walks. */
export type AcceptorSpineStepName = "review" | "consent" | "columns";

/** The acceptor's working states: the three spine steps plus the terminal `launched`
 * state the columns step commits to, which drives the acceptor's run surface.
 * `launched` is not a spine step -- the top bar switches to the run timeline there. */
export type AcceptorStep = AcceptorSpineStepName | "launched";

/** The spine step labels shown in the top-bar stepper. */
export const ACCEPTOR_STEP_LABELS: Record<AcceptorSpineStepName, string> = {
  review: "Review configuration",
  consent: "Consent & your file",
  columns: "Confirm your columns",
};

/** The spine order the top bar renders and the step-state derivation walks. */
export const ACCEPTOR_STEP_ORDER: ReadonlyArray<AcceptorSpineStepName> = [
  "review",
  "consent",
  "columns",
];

/** One derived spine entry: the step's label, its position state, and whether it
 * is navigable back (a done step is, per the mockup's done-steps-are-links
 * rule). */
export interface AcceptorSpineStep {
  step: AcceptorSpineStepName;
  label: string;
  state: RailStepState;
  navigable: boolean;
}

/**
 * Derive the spine's done/current/pending states for the step the acceptor is
 * on: steps before the current one are done (and navigable back), the current
 * one is current, and later ones are pending -- the inviterModel spine pattern,
 * over the acceptor's fixed three-step order. Only the spine steps are passed; the
 * terminal `launched` state swaps the top bar for the run timeline instead.
 */
export function acceptorSpine(
  current: AcceptorSpineStepName,
): Array<AcceptorSpineStep> {
  const currentPosition = ACCEPTOR_STEP_ORDER.indexOf(current);
  return ACCEPTOR_STEP_ORDER.map((step, position) => {
    const state: RailStepState =
      position < currentPosition
        ? "done"
        : position === currentPosition
          ? "current"
          : "pending";
    return {
      step,
      label: ACCEPTOR_STEP_LABELS[step],
      state,
      navigable: state === "done",
    };
  });
}

/** The Customize group's single fact: a Cleaning tab whose value is the em-dash
 * placeholder until the columns step surfaces a reason to review cleaning
 * (silent-empty fields, dead keys, invalid steps), then an amber attention value
 * naming the count. Renders like the inviter's quiet facts. `attention` is the
 * derived fact string (undefined -> em-dash); its presence colors the row amber. */
export function acceptorRailFacts(attention?: string): Array<RailFact> {
  return [
    {
      label: "Cleaning",
      fact: attention,
      tone: attention === undefined ? undefined : "attention",
    },
  ];
}

/**
 * Result direction phrased from the ACCEPTOR's seat, mirroring the inviter's
 * `output`: `expectsOutput` is whether the inviter receives, `shareWithPartner`
 * whether the acceptor (its partner) receives -- so from the acceptor's side the
 * two roles swap.
 */
function acceptorResultsGoTo(output: LinkageTerms["output"]): string {
  const acceptorReceives = output.shareWithPartner;
  const inviterReceives = output.expectsOutput;
  if (acceptorReceives && inviterReceives) return "You and your partner";
  if (acceptorReceives) return "Only you";
  if (inviterReceives) return "Only your partner";
  return "Neither party";
}

/** One row of the acceptor's disclosure ledger: the value renders in the data
 * voice, `muted` in the empty-state voice, `value` may be a multi-line list (the
 * per-key matched-on rows). `shareBar` marks the row as one of the headline
 * disclosure facts the narrow viewport's condensed "What you will share" bar
 * keeps -- declared here by the producer, so a relabel can never silently drop
 * a row from that trust surface. */
export interface AcceptorLedgerRow {
  label: string;
  value?: string | ReadonlyArray<string>;
  muted?: string;
  shareBar?: boolean;
}

/** The forward-reference wording the pre-file send rows carry, before any file is
 * chosen and so before any metadata exists: the exact send set is not yet known,
 * so the row points ahead to the confirm-columns step rather than overclaiming a
 * count. Mirrors {@link InvitationTerms}'s pre-file outbound forward-reference. */
export const ACCEPTOR_SEND_FORWARD_REFERENCE =
  "Confirmed after you choose your file";

/** The acceptor's outbound send row, keyed to the ledger's tense. `disclosure` is
 * the acceptor's OWN live disclosed column names ({@link disclosedColumnNames} over
 * its metadata) once a file exists -- the exact set core transmits -- each
 * sanitized for display since they are operator-file strings. Undefined before a
 * file is chosen (no metadata yet), where the row carries the invitation's
 * forward-reference rather than a claim it cannot yet make. */
function acceptorSendRow(
  label: string,
  disclosure: ReadonlyArray<string> | undefined,
): AcceptorLedgerRow {
  // Whatever its tense, the outbound row is the share bar's headline fact --
  // what leaves (or left) this machine.
  if (disclosure === undefined)
    return { label, muted: ACCEPTOR_SEND_FORWARD_REFERENCE, shareBar: true };
  if (disclosure.length === 0)
    return { label, muted: "No additional columns", shareBar: true };
  return {
    label,
    value: disclosure.map((name) => sanitizeForDisplay(name)).join(", "),
    shareBar: true,
  };
}

/** The trust line under the acceptor's ledger: the same pre-run assurance the
 * inviter's surfaces state, with the step pointer at the acceptor's own
 * confirm-columns step (step 3), where its send set is decided. */
export const ACCEPTOR_LEDGER_FOOTER =
  "PII for linkage is encrypted locally before leaving your machine. Your partner " +
  "receives only the fields listed under 'you will send' (step 3 above) " +
  "and only for clients who are in common.";

/** The step-3 ledger footer, swapped in on the columns step: local-only column
 * typing and cleaning, stated exactly as the mockup. */
export const ACCEPTOR_COLUMNS_LEDGER_FOOTER =
  "Column typing and cleaning stay on your device. Your partner sees matches, " +
  "never these settings.";

/** The ledger tag naming who proposed the terms, with the partner's
 * self-asserted name sanitized for display. */
export function acceptorLedgerTag(invitingParty: string): string {
  return `Proposed by ${invitingParty}`;
}

/**
 * The acceptor's disclosure ledger: the receive/matched-on/expiry/results/agreement/
 * transport rows read from the decoded invitation (every partner string sanitized by
 * {@link summarizeInvitation}), and the "You will send" row from the acceptor's OWN
 * metadata once a file exists. `metadata` is the acceptor's live column metadata from
 * the confirm-columns step onward; its disclosed set ({@link disclosedColumnNames}) is
 * exactly what core transmits, so the ledger cannot overclaim. Undefined on the
 * review/consent steps (no file yet), where the send row forward-references the
 * confirm-columns step. The proposal's non-send rows are read-only here, so they never
 * carry a spine-step reference.
 */
export function acceptorLedgerRows(
  token: InvitationToken,
  howItRuns: string,
  metadata?: Metadata,
): Array<AcceptorLedgerRow> {
  const summary = summarizeInvitation(token);
  // What the acceptor receives for matched records is the inviter's send set
  // (summary.payload.send), which derives from the carried disclosedPayloadColumns.
  const received = summary.payload?.send ?? [];
  const disclosure =
    metadata === undefined ? undefined : disclosedColumnNames(metadata);
  return [
    acceptorSendRow("You will send", disclosure),
    {
      label: "You will receive",
      value:
        received.length > 0
          ? `Matched rows + ${received.join(", ")}`
          : "Matched rows",
    },
    summary.linkageKeys.length > 0
      ? {
          label: "Matched on",
          value: summary.linkageKeys.map(
            (key, index) => `${index + 1}. ${key.name}`,
          ),
          shareBar: true,
        }
      : { label: "Matched on", muted: "No keys", shareBar: true },
    {
      label: "Expires",
      value:
        summary.expires !== undefined
          ? dateTimeLabel(new Date(summary.expires))
          : "No expiry",
      shareBar: true,
    },
    {
      label: "Results go to",
      value: acceptorResultsGoTo(token.linkageTerms.output),
    },
    summary.legalAgreement !== undefined
      ? { label: "Agreement", value: summary.legalAgreement.reference }
      : { label: "Agreement", muted: "None" },
    { label: "How it runs", value: howItRuns },
  ];
}

/** The invitation heading names the partner: the same sanitized identity the
 * ledger tag uses, so the two surfaces cannot disagree. */
export function invitingPartyName(token: InvitationToken): string {
  return sanitizeForDisplay(token.linkageTerms.identity);
}

/**
 * The partner's advisory shared-directory locator for display, or undefined when the
 * accepted invitation carries no single-directory file-drop path. Routed through
 * {@link summarizeInvitation}, the one partner-string sanitizing boundary the ledger
 * already uses -- the value is partner-supplied and never rendered raw. Advisory
 * only: the accepting operator confirms it names the same synced folder mounted on
 * this appliance, which is server-configured; it never flows to config.
 */
export function acceptorAdvisoryLocator(
  token: InvitationToken,
): string | undefined {
  return summarizeInvitation(token).connectionPath;
}

/** The completion trust line under the settled ledger for a browser-run accept: the
 * file never left this browser, and the ledger names all the partner received. */
export const ACCEPTOR_DONE_LEDGER_FOOTER =
  "Your file never left this browser. The results above are all your partner " +
  "received about your data.";

/** The completion trust line for a console file-drop accept, which runs on the
 * appliance (the CLI reads the mounted CSV, never the browser): the
 * "never left this browser" claim would be false, so it is dropped and only the
 * honest statement about what the partner received is kept. */
export const ACCEPTOR_DONE_SERVER_JOB_LEDGER_FOOTER =
  "The results above are all your partner received about your data.";

/** The completion trust line under the settled ledger, chosen by how the accept ran:
 * a server-job (console file-drop) accept drops the "never left this browser" claim
 * the appliance cannot make, mirroring the inviter's server-job footer. */
export function acceptorDoneLedgerFooter(serverJob: boolean): string {
  return serverJob
    ? ACCEPTOR_DONE_SERVER_JOB_LEDGER_FOOTER
    : ACCEPTOR_DONE_LEDGER_FOOTER;
}

/** What a completed exchange settled for the acceptor's ledger: the matched-row
 * count that actually arrived, or that the agreed terms withheld the result table
 * from this party. */
export interface AcceptorLedgerOutcome {
  matchedRecordCount?: number;
  resultWithheld?: boolean;
}

/** The settled ledger tag once the exchange completes, naming the partner it was
 * agreed with. The identity is already sanitized ({@link invitingPartyName}). */
export function acceptorDoneLedgerTag(invitingParty: string): string {
  return `Agreed with ${invitingParty}`;
}

/**
 * The acceptor's disclosure ledger after the exchange settles: the forward-looking
 * rows are relabelled past tense ("You sent", "You received", "Results went to"),
 * the expiry row drops (the invitation is consumed), and the receive row reports
 * what actually arrived -- the matched-row count, or that the terms withheld the
 * result table. Every partner string is sanitized by {@link summarizeInvitation}.
 *
 * `metadata` is the LAUNCHED metadata -- the frozen pair that actually ran -- so the
 * "You sent" row names the exact disclosed set ({@link disclosedColumnNames}) core
 * transmitted, sanitized per name. A settled ledger always has a launched pair, so
 * unlike {@link acceptorLedgerRows} it is required here.
 */
export function acceptorDoneLedgerRows(
  token: InvitationToken,
  outcome: AcceptorLedgerOutcome,
  metadata: Metadata,
  howItRuns: string,
): Array<AcceptorLedgerRow> {
  const summary = summarizeInvitation(token);
  const received = summary.payload?.send ?? [];
  const receivedSuffix = received.length > 0 ? ` + ${received.join(", ")}` : "";
  const receivedValue =
    outcome.resultWithheld === true
      ? "No result table - withheld by the agreed terms"
      : `${new Intl.NumberFormat("en-US").format(
          outcome.matchedRecordCount ?? 0,
        )} matched rows${receivedSuffix}`;
  return [
    acceptorSendRow("You sent", disclosedColumnNames(metadata)),
    // The expiry row is gone (the invitation is consumed), so the settled
    // condensed subset is what left, what arrived, and what matched.
    { label: "You received", value: receivedValue, shareBar: true },
    summary.linkageKeys.length > 0
      ? {
          label: "Matched on",
          value: summary.linkageKeys.map(
            (key, index) => `${index + 1}. ${key.name}`,
          ),
          shareBar: true,
        }
      : { label: "Matched on", muted: "No keys", shareBar: true },
    {
      label: "Results went to",
      value: acceptorResultsGoTo(token.linkageTerms.output),
    },
    summary.legalAgreement !== undefined
      ? { label: "Agreement", value: summary.legalAgreement.reference }
      : { label: "Agreement", muted: "None" },
    { label: "How it runs", value: howItRuns },
  ];
}

/**
 * The consent gate the consent step submits through: {@link commitAcceptance}
 * returns the trimmed name to record only when the checkbox is checked AND a
 * non-empty name is given, else undefined. Never a reimplementation of that rule
 * -- the extensively-hardened gate stays the one authority, consulted here for
 * both the submit's disabled state and the handler's re-check.
 */
export function acceptorConsentName(input: {
  consented: boolean;
  name: string;
}): string | undefined {
  return commitAcceptance(input);
}

/** Whether the consent gate is satisfied -- the consent step's submit-disabled
 * predicate, derived from the same gate the handler re-checks. */
export function acceptorConsentReady(input: {
  consented: boolean;
  name: string;
}): boolean {
  return acceptorConsentName(input) !== undefined;
}

/** The consent-step legal-agreement display: the three sanitized values plus
 * whether sanitization changed how any of them reads. */
export interface AcceptorLegalAgreementDisplay {
  /** Agreement identifier, sanitized for display. */
  reference: string;
  /** Stated purpose of the disclosure, sanitized for display. */
  purpose: string;
  /** Expiration date (ISO 8601, YYYY-MM-DD), sanitized for display. */
  expirationDate: string;
  /**
   * True when the display does not read exactly as the authored value:
   * sanitizeForDisplay escaped a code point outside plain ASCII or truncated a
   * long value in at least one of the three fields. The consent step then adds
   * a caveat so "check these against your signed agreement" does not overclaim
   * a visual match the escaping makes impossible.
   */
  alteredForDisplay: boolean;
}

/**
 * The legal-agreement values the consent step displays beside the attestation,
 * or undefined when the invitation attaches none. Display only -- no gate and no
 * comparison; the acceptor is invited to check the values against the signed
 * document, not to transcribe them. The three strings derive through
 * {@link summarizeInvitation}, the one sanitizing boundary, so they are
 * display-safe -- never the raw token values. `alteredForDisplay` compares each
 * against its raw counterpart, the one place the raw values are consulted, and
 * only for inequality -- no raw string is returned.
 */
export function acceptorLegalAgreementDisplay(
  token: InvitationToken,
): AcceptorLegalAgreementDisplay | undefined {
  const sanitized = summarizeInvitation(token).legalAgreement;
  const raw = token.linkageTerms.legalAgreement;
  if (sanitized === undefined || raw === undefined) return undefined;
  return {
    reference: sanitized.reference,
    purpose: sanitized.purpose,
    expirationDate: sanitized.expirationDate,
    alteredForDisplay:
      sanitized.reference !== raw.reference ||
      sanitized.purpose !== raw.purpose ||
      sanitized.expirationDate !== raw.expirationDate,
  };
}

/** The connection endpoint an accepted invitation carries, narrowed from the token
 * by {@link prepareAcceptedInvitation}: a WebRTC signaling endpoint, or a file-drop
 * or SFTP endpoint on a console build. */
type AcceptEndpoint = AcceptableInvitation["endpoint"];

/** The honest title for a console accept whose endpoint the appliance cannot run,
 * pointing the operator at where it CAN run. */
export const ACCEPT_UNSUPPORTED_TITLE =
  "This appliance cannot run this exchange";

/** The honest unsupported-accept copy for a console build, deciding runnability by
 * the endpoint's SHAPE rather than a channel kill-switch: a WebRTC accept has no
 * in-tab exchange on the appliance (WebRTC is the public web app's domain); a
 * split-directory file-drop uses inbound/outbound mailboxes the console does not
 * offer (collapsing the mirror-swapped pair would break the read-where-the-peer-
 * writes invariant); and a single-directory file-drop needs `JOB_RENDEZVOUS_DIR`
 * mounted. */
export interface AcceptUnsupported {
  title: string;
  message: string;
}

/** Whether a file-drop endpoint carries the single shared-directory form the console
 * runs, rather than the inbound/outbound split it does not offer. */
function isSingleDirectoryFiledrop(endpoint: AcceptEndpoint): boolean {
  return endpoint.channel === "filedrop" && endpoint.path !== undefined;
}

/** Whether an SFTP endpoint carries the inbound/outbound split the console does not
 * run: the authored connection form composes a single remote directory, so a
 * split-directory SFTP accept belongs on the command-line tool. A single-directory
 * SFTP endpoint (host plus an optional shared `path`) is runnable here. */
function isSplitDirectorySftp(endpoint: AcceptEndpoint): boolean {
  return endpoint.channel === "sftp" && endpoint.inboundPath !== undefined;
}

/**
 * The unsupported-accept state for a console build, or undefined when the appliance
 * can run the accepted endpoint. Determined by the endpoint SHAPE and whether the
 * rendezvous mount is configured, not a static kill-switch: a runnable console accept
 * is a single-directory file-drop with `JOB_RENDEZVOUS_DIR` set, or a
 * single-directory SFTP endpoint (the operator authors the connection to the
 * partner-named server before launch). The caller consults this only on a console
 * build; off the console every admitted endpoint runs in the browser.
 */
export function acceptUnsupported(
  endpoint: AcceptEndpoint,
  rendezvousConfigured: boolean,
): AcceptUnsupported | undefined {
  if (endpoint.channel === "webrtc")
    return {
      title: ACCEPT_UNSUPPORTED_TITLE,
      message:
        "This invitation runs an in-browser (WebRTC) exchange, which is out of " +
        "scope on this appliance. Accept it from a standard psilink web app in " +
        "your browser instead.",
    };
  // An SFTP accept connects to the partner-named server (no rendezvous mount), so
  // it needs no `JOB_RENDEZVOUS_DIR`; only the split-directory shape and a
  // non-bare host are refused, the file-sync siblings of the file-drop split gate
  // below.
  if (endpoint.channel === "sftp") {
    if (isSplitDirectorySftp(endpoint))
      return {
        title: ACCEPT_UNSUPPORTED_TITLE,
        message:
          "This invitation uses separate inbound and outbound directories, which " +
          "this appliance does not run. Accept it with the psilink command-line " +
          "tool instead.",
      };
    // The partner authored the host; the accept form shows it read-only, so a host
    // that is not a bare address (a URL, a path, or whitespace) could never be
    // corrected here and would silently fail the Save-time host check. Refuse it at
    // review, where the operator meets a clear block, rather than at a dead Save.
    if (!isBareSftpHost(endpoint.host))
      return {
        title: ACCEPT_UNSUPPORTED_TITLE,
        message:
          "This invitation names an SFTP host that is not a plain address (it " +
          "contains a URL, path, or whitespace). Accept it with the psilink " +
          "command-line tool instead.",
      };
    return undefined;
  }
  if (!isSingleDirectoryFiledrop(endpoint))
    return {
      title: ACCEPT_UNSUPPORTED_TITLE,
      message:
        "This invitation uses separate inbound and outbound directories, which " +
        "this appliance does not run. Accept it with the psilink command-line " +
        "tool instead.",
    };
  if (!rendezvousConfigured)
    return {
      title: ACCEPT_UNSUPPORTED_TITLE,
      message:
        "This invitation runs over a shared directory, but this appliance has no " +
        "rendezvous directory configured. Set JOB_RENDEZVOUS_DIR to a directory " +
        "both parties can reach and reload.",
    };
  return undefined;
}

/** Whether a console accept runs as a server job on the appliance: a console build
 * accepting a file-drop endpoint (against the mounted shared directory) or an SFTP
 * endpoint (against the operator-authored server) runs the exchange through the
 * command-line tool, not in the browser. Every other admitted accept runs the live
 * exchange in this browser. This one signal drives both the "How it runs" ledger row
 * and the settled footer's "never left this browser" claim, so the two cannot
 * disagree. */
export function acceptorRunsAsServerJob(
  endpoint: AcceptEndpoint,
  consoleBuild: boolean,
): boolean {
  return (
    consoleBuild &&
    (endpoint.channel === "filedrop" || endpoint.channel === "sftp")
  );
}

/** The ledger's "How it runs" phrasing for an accepted endpoint. A console
 * single-directory file-drop accept runs on the appliance against the shared
 * directory, and a console SFTP accept against the partner-named server (both the
 * command-line tool), not in the browser; every other admitted accept runs the live
 * exchange in this browser. */
export function acceptorHowItRunsLabel(
  endpoint: AcceptEndpoint,
  consoleBuild: boolean,
): string {
  if (!acceptorRunsAsServerJob(endpoint, consoleBuild))
    return TRANSPORT_LEDGER_LABELS.browser;
  return endpoint.channel === "sftp"
    ? TRANSPORT_LEDGER_LABELS.sftp
    : TRANSPORT_LEDGER_LABELS.filedrop;
}

/**
 * The launched run's top-bar transport note for an accepted endpoint: the short
 * label naming where the exchange runs, reusing the inviter's share/save top-bar
 * terminology so the two seats read alike. A console server-job accept names its
 * transport through {@link saveRailNote} ("SFTP" or "Shared directory"); every
 * browser-run accept reads "Browser".
 */
export function acceptorTransportNote(
  endpoint: AcceptEndpoint,
  consoleBuild: boolean,
): string {
  if (!acceptorRunsAsServerJob(endpoint, consoleBuild)) return "Browser";
  return endpoint.channel === "sftp"
    ? saveRailNote("sftp")
    : saveRailNote("filedrop");
}
