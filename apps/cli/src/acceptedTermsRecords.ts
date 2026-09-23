/**
 * The terms an acceptance adopts from an invitation, the comparison of those
 * terms against a configuration that already exists, and the fail-closed
 * records an acceptance writes into that configuration:
 * `expected_payload_columns`, `expected_partner_deduplicate`, and
 * `outbound_payload_consent`, with the inviter's `disclosed_payload_columns`
 * beside them.
 *
 * Every entry point takes what it needs as arguments, so any command that
 * records consent to an invitation's terms drives the same derivation and the
 * same writes. A record these writes lose disables a check a later
 * `psilink exchange` makes, with no signal at run time, so a caller either
 * lets the write throw or takes {@link writeAcceptanceRecordReportingLoss},
 * which sets the persistence-loss exit code.
 */

import {
  deriveAcceptedLinkageTerms,
  deriveOutboundPayloadConsent,
  redactAndRenderOperatorSuppliedText,
  redactAndSanitizeForDisplay,
  operatorSuppliedText,
  sanitizeErrorForDisplay,
} from "@psilink/core";
import type {
  ExchangeSpec,
  InvitationToken,
  LinkageTerms,
  Metadata,
  OutboundPayloadConsent,
  RelayLocator,
} from "@psilink/core";

import {
  diffLinkageTerms,
  linkageTermsStandingOf,
  persistDisclosedPayloadColumns,
  persistExpectedPartnerDeduplicate,
  persistExpectedPayloadColumns,
  persistOutboundPayloadConsent,
  warnOnLinkageRuleSetCitationDrift,
  type CitationDriftAlternative,
  type ReconcileDiff,
} from "./config";
import { reportPersistenceLoss, type EventStreamEmitter } from "./eventStream";

/** What an acceptance takes from the invitation it consents to. */
export interface AcceptedInvitationTerms {
  /**
   * This party's linkage terms: the invitation's agreed fields, keys and
   * algorithm, under this party's own identity, with the output direction
   * mirrored (see `deriveAcceptedLinkageTerms` in core).
   */
  linkageTerms: LinkageTerms;
  /**
   * The columns the invitation declared the inviting party sends, recorded as
   * `expected_payload_columns`. Undefined where the invitation declared no
   * disclosed subset, which records no commitment.
   */
  expectedPayloadColumns: string[] | undefined;
  /**
   * The `deduplicate` the invitation declared for the inviting party's own
   * side, recorded as `expected_partner_deduplicate`.
   */
  expectedPartnerDeduplicate: boolean;
  /** The relay the invitation's webrtc endpoint names, if any. */
  invitationRelay: RelayLocator | undefined;
}

/**
 * Derive {@link AcceptedInvitationTerms} from a validated invitation and the
 * identity this party runs under. Throws where core refuses the invitation's
 * terms for an acceptor (see `deriveAcceptedLinkageTerms`).
 */
export function deriveAcceptedInvitationTerms(
  token: InvitationToken,
  identity: string,
): AcceptedInvitationTerms {
  return {
    linkageTerms: deriveAcceptedLinkageTerms(token.linkageTerms, identity),
    expectedPayloadColumns: token.disclosedPayloadColumns,
    expectedPartnerDeduplicate: token.linkageTerms.deduplicate,
    invitationRelay:
      token.connectionEndpoint?.channel === "webrtc"
        ? token.connectionEndpoint.relay
        : undefined,
  };
}

/**
 * Compare the linkage terms of a configuration already at `configPath`
 * against the terms an acceptance adopts, returning the disagreements that
 * must refuse keeping it. The soft mismatches are logged as warnings.
 *
 * A stale rule-set citation in the kept configuration is reported first,
 * whether or not the terms agree, judged on the file as it stands before this
 * acceptance records itself on it.
 */
export function diffKeptLinkageTerms(params: {
  configPath: string;
  existing: ExchangeSpec;
  accepted: LinkageTerms;
  citationDriftAlternative: CitationDriftAlternative;
  log: { warn: (message: string) => void };
}): ReconcileDiff[] {
  const { configPath, existing, accepted, citationDriftAlternative, log } =
    params;
  warnOnLinkageRuleSetCitationDrift(
    existing.linkageTerms,
    configPath,
    log,
    linkageTermsStandingOf(existing),
    citationDriftAlternative,
  );
  const { conflicts, warnings } = diffLinkageTerms(
    existing.linkageTerms,
    accepted,
  );
  for (const w of warnings) log.warn(w);
  return conflicts;
}

/**
 * The warning an acceptance owes before it removes a recorded
 * `expected_payload_columns` because its invitation declares no disclosed
 * subset, or `undefined` where nothing is removed. Each column name is the
 * partner's, so it is redacted, escaped, and listed one per line.
 */
export function receivedCommitmentRemovalWarning(params: {
  configPath: string;
  recorded: string[] | undefined;
  consented: string[] | undefined;
}): string | undefined {
  const { configPath, recorded, consented } = params;
  if (recorded === undefined || consented !== undefined) return undefined;
  return (
    `this invitation declares no disclosed columns, so accepting it clears ` +
    `the list of columns you previously agreed to receive, recorded in ` +
    `${redactAndRenderOperatorSuppliedText(
      operatorSuppliedText(configPath),
    )}. That list holds the partner's payload to ` +
    (recorded.length === 0
      ? "no columns at all (a strict receive-nothing consent)."
      : "exactly these columns:\n" +
        recorded
          .map((column) => `  - ${redactAndSanitizeForDisplay(column)}`)
          .join("\n")) +
    `\nWithout it the next 'psilink exchange' from this configuration ` +
    `accepts whatever columns the partner transmits. To keep the check, ask ` +
    `the inviting party for an invitation that declares the columns it sends.`
  );
}

/**
 * This party's consent to its own outbound set, for a configuration an
 * acceptance writes fresh and for one it keeps.
 *
 * `fresh` is derived from the accepted output terms and this party's own
 * metadata. `kept` follows the kept configuration's own output terms, which no
 * reconciliation compares: where `fresh` records nothing but the kept
 * configuration shares with its partner, it is `pending`, so the next run asks
 * or refuses unattended rather than transmitting on partner-controlled terms.
 */
export function deriveOutboundConsentRecords(params: {
  acceptedOutput: LinkageTerms["output"];
  ownMetadata: Metadata | undefined;
  keptConfigurationShares: boolean | undefined;
}): {
  fresh: OutboundPayloadConsent | undefined;
  kept: OutboundPayloadConsent | undefined;
} {
  const fresh = deriveOutboundPayloadConsent(
    params.acceptedOutput,
    params.ownMetadata,
  );
  const kept: OutboundPayloadConsent | undefined =
    fresh !== undefined
      ? fresh
      : params.keptConfigurationShares === true
        ? { status: "pending" }
        : undefined;
  return { fresh, kept };
}

/**
 * One fail-closed record written in place into an existing configuration.
 * An undefined value removes the field, except `expected_partner_deduplicate`,
 * which always has a value.
 */
export type TermsRecordWrite =
  | { record: "expected_payload_columns"; columns: string[] | undefined }
  | { record: "expected_partner_deduplicate"; declared: boolean }
  | {
      record: "outbound_payload_consent";
      consent: OutboundPayloadConsent | undefined;
    }
  | { record: "disclosed_payload_columns"; columns: string[] | undefined };

/** The records an acceptance writes; the inviter's disclosure is excluded. */
export type AcceptanceRecordWrite = Exclude<
  TermsRecordWrite,
  { record: "disclosed_payload_columns" }
>;

/**
 * Write one record into the configuration at `configPath`, keeping the rest
 * of the file as it is. Throws where the file cannot be read, parsed, or
 * written.
 */
export function writeTermsRecord(
  configPath: string,
  write: TermsRecordWrite,
): void {
  switch (write.record) {
    case "expected_payload_columns":
      persistExpectedPayloadColumns(configPath, write.columns);
      return;
    case "expected_partner_deduplicate":
      persistExpectedPartnerDeduplicate(configPath, write.declared);
      return;
    case "outbound_payload_consent":
      persistOutboundPayloadConsent(configPath, write.consent);
      return;
    case "disclosed_payload_columns":
      persistDisclosedPayloadColumns(configPath, write.columns);
      return;
  }
}

/**
 * Refresh an acceptance's three records in a configuration it keeps, in
 * order, stopping at the first write that throws.
 */
export function refreshAcceptanceRecords(
  configPath: string,
  records: {
    expectedPayloadColumns: string[] | undefined;
    expectedPartnerDeduplicate: boolean;
    outboundPayloadConsent: OutboundPayloadConsent | undefined;
  },
): void {
  writeTermsRecord(configPath, {
    record: "expected_payload_columns",
    columns: records.expectedPayloadColumns,
  });
  writeTermsRecord(configPath, {
    record: "expected_partner_deduplicate",
    declared: records.expectedPartnerDeduplicate,
  });
  writeTermsRecord(configPath, {
    record: "outbound_payload_consent",
    consent: records.outboundPayloadConsent,
  });
}

/**
 * What a lost write of each acceptance record leaves in force, for a run that
 * continues past the loss with the configuration it kept.
 */
function acceptanceRecordLossNotice(
  configPath: string,
  record: AcceptanceRecordWrite["record"],
): string {
  switch (record) {
    case "expected_payload_columns":
      return (
        `the exchange continues and the existing configuration at ` +
        `${configPath} stands, but recording the columns you ` +
        `consented to receive in it failed; the next 'psilink ` +
        `exchange' holds the received payload to the set that ` +
        `configuration already records, and checks it against no ` +
        `consented set if it records none`
      );
    case "outbound_payload_consent":
      return (
        `the exchange continues and the existing configuration at ` +
        `${configPath} stands, but recording your ` +
        `outbound-column confirmation in it failed; the next ` +
        `'psilink exchange' compares against the previously ` +
        `recorded set and will show the columns and ask again if ` +
        `they differ`
      );
    case "expected_partner_deduplicate":
      return (
        `the exchange continues and the existing configuration at ` +
        `${configPath} stands, but recording the duplicate ` +
        `matching your partner declared in it failed; the next ` +
        `'psilink exchange' holds your partner to the value that ` +
        `configuration already records, and to no value if it records ` +
        `none`
      );
  }
}

/**
 * Write one acceptance record without letting a failure stop the caller: a
 * lost write is logged with its cause, reported on the event
 * stream, and sets the persistence-loss exit code. Returns whether the record
 * was written.
 */
export function writeAcceptanceRecordReportingLoss(
  configPath: string,
  write: AcceptanceRecordWrite,
  report: {
    log: { warn: (message: string) => void };
    eventStream: EventStreamEmitter | undefined;
  },
): boolean {
  try {
    writeTermsRecord(configPath, write);
    return true;
  } catch (err) {
    const notice = acceptanceRecordLossNotice(configPath, write.record);
    report.log.warn(`${notice}: ${sanitizeErrorForDisplay(err)}`);
    reportPersistenceLoss(notice, report.eventStream);
    return false;
  }
}
