import { EXCHANGE_RECORD_VERSION, buildExchangeRecord } from "@psilink/core";

import type {
  CommittedPayload,
  ExchangeRecord,
  LinkageTerms,
} from "@psilink/core";

/**
 * Real exchange records for the accounting-of-disclosures suites, built through
 * core's own {@link buildExchangeRecord} rather than hand-written object literals.
 * The accounting's contract is that every fact it shows is a field of the record
 * the run produced, so a fixture that invented the record could not test it: a
 * field core stops deriving would keep passing against a literal.
 *
 * Shared by the Node unit suites and the browser suite, which need the same
 * records.
 */

/**
 * The exchange-record version `offset` ordinals from this build's -- a later
 * format at `1`, an earlier one at `-1` -- derived from core's own constant so a
 * fixture stays relative to wherever the literal stands rather than pinning a
 * version that stops being the neighbour when core's moves.
 *
 * Throws when the constant holds no ordinal to count from. The split that tells
 * a stranded accounting from a stale page reads that same shape, so a fixture
 * quietly falling back to some other literal would leave the suites driving
 * neither direction.
 */
export function neighbouringRecordVersion(offset: number): string {
  const match = /^(.+)\/v(\d+)$/.exec(EXCHANGE_RECORD_VERSION);
  if (match === null)
    throw new Error(
      `EXCHANGE_RECORD_VERSION "${EXCHANGE_RECORD_VERSION}" carries no ordinal, so it has no neighbouring version`,
    );
  return `${match[1]}/v${Number(match[2]) + offset}`;
}

/** The linkage terms both sides of the fixture exchange agree, holding the
 * governance fields an accounting reads: the agreement and its purpose, the
 * linkage fields the keys reference, and the payload data dictionary that
 * describes a disclosed column. */
const LOCAL_TERMS: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Dept",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  legalAgreement: {
    reference: "MOU-2025-0042",
    purpose: "Evaluate shared program enrollment",
    expirationDate: "2027-01-01",
  },
  linkageFields: [
    { name: "last_name", type: "last_name" },
    { name: "date_of_birth", type: "date_of_birth" },
  ],
  linkageKeys: [
    {
      name: "NAME_DOB",
      elements: [{ field: "last_name" }, { field: "date_of_birth" }],
    },
  ],
  payload: {
    send: [{ name: "dose", description: "Administered dose" }],
    receive: [{ name: "clinic" }],
  },
};

/** The payload this party committed as sent, and the one it committed as received:
 * the columns the accounting reports as the categories disclosed each way. */
const LOCAL_PAYLOAD_SENT: CommittedPayload = {
  columns: ["dose"],
  rows: [["10mg"]],
};
const PARTNER_PAYLOAD_RECEIVED: CommittedPayload = {
  columns: ["clinic"],
  rows: [["north"]],
};

/** How a fixture record differs from the standing one. */
export interface DisclosureRecordOverrides {
  /** The partner's self-asserted identity, as it reaches the record byte-exactly
   * -- the hook a suite uses to plant partner-controlled text -- or `null` for a
   * partner that supplied no name, whose record field is absent. */
  partnerIdentity?: string | null;
  /** The agreement reference and purpose, or `null` for terms that name no
   * agreement at all. */
  legalAgreement?: LinkageTerms["legalAgreement"] | null;
  /** This party's contributed row count. */
  recordsExposed?: number;
  /** The intersection size, or `null` for the single-output case the record omits
   * it in. */
  resultSize?: number | null;
  /** The run instant, which is the entry's identity. */
  createdAt?: string;
  /** The self-facing retention/disposition pointer. */
  retentionDisposition?: string;
  /** The matching algorithm, so a suite can build a count-only disclosure. */
  algorithm?: LinkageTerms["algorithm"];
  /** The one column name the partner committed as received, as it reaches the
   * record byte-exactly -- the hook a suite uses to plant partner-controlled text
   * in a payload column name rather than in an identity. */
  partnerPayloadColumn?: string;
  /** The named rule set both parties' terms cite. Omitted by default, the case a
   * record that cites none is built from; the standing citation is what a suite
   * asks for by passing `true`, and an object plants the names it needs. */
  linkageRuleSet?: LinkageTerms["linkageRuleSet"] | true;
  /** How far the run got. Defaults to the completed run every other fixture
   * field describes; a suite asks for the record a terminated swap leaves. */
  outcome?: ExchangeRecord["outcome"];
}

/** The rule set the citing fixture terms name: a field set and a key set, each
 * separately named and separately versioned as the terms document holds them. */
const LOCAL_RULE_SET: NonNullable<LinkageTerms["linkageRuleSet"]> = {
  fieldSet: { name: "baseline-pii", version: "1.0.0" },
  keySet: { name: "hmis-keys", version: "2.1.0" },
};

/** The partner's terms: the local ones relabelled, or -- for an explicit `null`
 * -- holding no identity key at all, the shape a partner that supplied no name
 * sends. Built by omission rather than by an explicit undefined, which the
 * canonical encoding the record hashes its terms through rejects. */
function partnerTermsFor(
  localTerms: LinkageTerms,
  partnerIdentity: string | null | undefined,
): LinkageTerms {
  if (partnerIdentity === null) {
    const { identity: _unnamed, ...withoutIdentity } = localTerms;
    return withoutIdentity;
  }
  return { ...localTerms, identity: partnerIdentity ?? "Riverbend Schools" };
}

/** Build one run's self-attested exchange record. */
export async function disclosureRecord(
  overrides: DisclosureRecordOverrides = {},
): Promise<ExchangeRecord> {
  const agreement =
    overrides.legalAgreement === null
      ? undefined
      : (overrides.legalAgreement ?? LOCAL_TERMS.legalAgreement);
  // The agreement key is omitted rather than set to undefined: the canonical
  // encoding the record hashes its terms through rejects an explicit undefined.
  const { legalAgreement: _declared, ...termsWithoutAgreement } = LOCAL_TERMS;
  const ruleSet =
    overrides.linkageRuleSet === true
      ? LOCAL_RULE_SET
      : overrides.linkageRuleSet;
  const localTerms: LinkageTerms = {
    ...termsWithoutAgreement,
    algorithm: overrides.algorithm ?? LOCAL_TERMS.algorithm,
    ...(agreement !== undefined ? { legalAgreement: agreement } : {}),
    ...(ruleSet !== undefined ? { linkageRuleSet: ruleSet } : {}),
  };
  const built = await buildExchangeRecord({
    localTerms,
    outcome: overrides.outcome ?? "completed",
    partnerTerms: partnerTermsFor(localTerms, overrides.partnerIdentity),
    recordsExposed: overrides.recordsExposed ?? 2,
    ...(overrides.resultSize === null
      ? {}
      : { resultSize: overrides.resultSize ?? 1 }),
    ...(overrides.retentionDisposition !== undefined
      ? { retentionDisposition: overrides.retentionDisposition }
      : {}),
    localPayloadSent: LOCAL_PAYLOAD_SENT,
    partnerPayloadReceived:
      overrides.partnerPayloadColumn === undefined
        ? PARTNER_PAYLOAD_RECEIVED
        : { columns: [overrides.partnerPayloadColumn], rows: [["north"]] },
    // One matched pair: this party's row 0 to the partner's row 0.
    associationTable: [[0], [0]],
    createdAt: overrides.createdAt ?? "2026-07-01T09:00:00.000Z",
  });
  return built.record;
}
