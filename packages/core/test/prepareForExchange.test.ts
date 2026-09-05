import { expect, test, describe } from "vitest";

import {
  prepareForExchange,
  runExchange,
  assertAlgorithmImplemented,
  assertCertificateModeNamesLocalParty,
  assertCertificateModePinsPartner,
  assertSignedReceiptNamesBothParties,
  assertSigningModeImplemented,
} from "../src/exchange";
import {
  assertPartnerCertificateTrusted,
  generateSigningIdentity,
} from "../src/records/signingIdentity";
import { ReceiptVerificationError } from "../src/records/signedReceipt";
import {
  LinkageTermsUnsatisfiableError,
  OperatorConfigError,
  OutboundDisclosureRefusalError,
  StandardizationTermsError,
  UsageError,
} from "../src/errors";
import {
  MAX_SINGLE_PASS_CELLS,
  SINGLE_PASS_LOCAL_REMEDY,
  singlePassDatasetExceedsCap,
} from "../src/connection/frameSize";
import {
  declaredEffectiveKeyCount,
  FAN_OUT_CANDIDATES_PER_ELEMENT,
} from "../src/fanOutFunctions";
import { DEDUPLICATE_IMPLEMENTED_BY_STRATEGY } from "../src/linkageTermsPolicy";
import { MAX_NAME_LENGTH } from "../src/config/linkageTerms";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type { ExchangeDataSpec } from "../src/exchange";
import type { MessageConnection } from "../src/connection/messageConnection";
import type { Algorithm } from "../src/types";
import type { LinkageStrategy, LinkageTerms } from "../src/config/linkageTerms";
import type { Metadata } from "../src/config/metadata";
import type { SigningConfig, SigningMode } from "../src/config/signing";
import type { Standardization } from "../src/config/standardization";
import type { CSVRow } from "../src/file";

// --- Fixtures ----------------------------------------------------------------

// A minimal two-field linkage terms; every fixture below shares it so the only
// variable across the cases is whether (and how) a standardization is authored.
const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "Tester",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "first_name", type: "first_name" },
    { name: "last_name", type: "last_name" },
  ],
  linkageKeys: [
    {
      name: "FN_LN",
      elements: [{ field: "first_name" }, { field: "last_name" }],
    },
  ],
};

const metadata: Metadata = [
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
];

const columns = ["first_name", "last_name"];
const rawRows: Array<CSVRow> = [{ first_name: "Alice", last_name: "Smith" }];

// A standardization every transform of which names a declared linkage field and
// uses a known function -- consistent with `terms`.
const consistentStandardization: Standardization = [
  {
    output: "first_name",
    input: "first_name",
    steps: [{ function: "to_upper_case" }],
  },
  {
    output: "last_name",
    input: "last_name",
    steps: [{ function: "to_upper_case" }],
  },
];

// --- Authoritative config fails closed on an inconsistency -------------------

describe("prepareForExchange: authoritative standardization fails closed", () => {
  test("a standardization output naming no linkage field is rejected", () => {
    const standardization: Standardization = [
      { output: "not_a_field", input: "first_name" },
    ];
    expect(() =>
      prepareForExchange(
        { linkageTerms: terms, metadata, standardization },
        "Tester",
        rawRows,
        columns,
      ),
    ).toThrow(StandardizationTermsError);
    let thrown: unknown;
    try {
      prepareForExchange(
        { linkageTerms: terms, metadata, standardization },
        "Tester",
        rawRows,
        columns,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OperatorConfigError);
    expect(thrown).toBeInstanceOf(UsageError);
    // The failure states the underlying inconsistency, so an operator
    // can see which output is wrong.
    expect(() =>
      prepareForExchange(
        { linkageTerms: terms, metadata, standardization },
        "Tester",
        rawRows,
        columns,
      ),
    ).toThrow(/not_a_field/);
  });

  test("an unknown standardization function is rejected", () => {
    const standardization: Standardization = [
      {
        output: "first_name",
        input: "first_name",
        steps: [{ function: "does_not_exist" }],
      },
    ];
    expect(() =>
      prepareForExchange(
        { linkageTerms: terms, metadata, standardization },
        "Tester",
        rawRows,
        columns,
      ),
    ).toThrow(StandardizationTermsError);
    expect(() =>
      prepareForExchange(
        { linkageTerms: terms, metadata, standardization },
        "Tester",
        rawRows,
        columns,
      ),
    ).toThrow(/does_not_exist/);
  });
});

// --- Consistent / terms-only configs are unaffected -------------------------

describe("prepareForExchange: consistent and terms-only configs proceed", () => {
  test("a fully consistent authoritative config prepares without error", () => {
    const prepared = prepareForExchange(
      {
        linkageTerms: terms,
        metadata,
        standardization: consistentStandardization,
      },
      "Tester",
      rawRows,
      columns,
    );
    expect(prepared.rowCount).toBe(1);
    expect(prepared.linkageTerms).toBe(terms);
  });

  test("a terms-only spec (no authored standardization) is unaffected", () => {
    const prepared = prepareForExchange(
      { linkageTerms: terms, metadata },
      "Tester",
      rawRows,
      columns,
    );
    expect(prepared.rowCount).toBe(1);
    expect(prepared.linkageTerms).toBe(terms);
  });
});

// --- Count-only (psi-c) at the local prepare step -----------------------------

describe("prepareForExchange: count-only (psi-c) is admitted in shape", () => {
  const psiCTerms: LinkageTerms = { ...terms, algorithm: "psi-c" };

  test("a conforming psi-c spec prepares", () => {
    const prepared = prepareForExchange(
      { linkageTerms: psiCTerms, metadata },
      "Tester",
      rawRows,
      columns,
    );
    expect(prepared.linkageTerms.algorithm).toBe("psi-c");
  });

  test("an out-of-shape psi-c spec is refused before connecting", () => {
    // A count-only run is one round over one key, so a second key is a shape the
    // specification does not admit. Refuse it before any connection -- never narrow
    // it to the first key -- with the UsageError (CLI exit 64) that names what to
    // change.
    const twoKeys: LinkageTerms = {
      ...psiCTerms,
      linkageKeys: [
        ...psiCTerms.linkageKeys,
        { name: "FN", elements: [{ field: "first_name" }] },
      ],
    };
    expect(() =>
      prepareForExchange(
        { linkageTerms: twoKeys, metadata },
        "Tester",
        rawRows,
        columns,
      ),
    ).toThrow(UsageError);
    expect(() =>
      prepareForExchange(
        { linkageTerms: twoKeys, metadata },
        "Tester",
        rawRows,
        columns,
      ),
    ).toThrow(/psi-c/);
  });
});

// --- assertAlgorithmImplemented (the shared guard) ---------------------------

// An algorithm value outside the implemented pair: the shape a member later added
// to AlgorithmSchema takes at these boundaries before a run path exists for it,
// and the shape a hand-crafted document reaching core past every schema takes
// today. Cast through the type, as the signing-mode sibling below does, because
// the enum admits no such member.
const unimplementedAlgorithm = "psi-x" as Algorithm;

describe("assertAlgorithmImplemented", () => {
  test("passes psi-c", () => {
    expect(() => assertAlgorithmImplemented("psi-c")).not.toThrow();
  });

  test("passes psi", () => {
    expect(() => assertAlgorithmImplemented("psi")).not.toThrow();
  });

  test("refuses an algorithm outside the allowlist", () => {
    // The guard is an allowlist of what this build runs, not a denylist of the
    // unimplemented, so an algorithm with no run path is refused by default -- what
    // keeps the self-attested record from attesting a disclosure the run could not
    // have made.
    expect(() => assertAlgorithmImplemented(unimplementedAlgorithm)).toThrow(
      UsageError,
    );
    // The refusal names the fixed enum literals it does admit, never the value it
    // was handed (which can be partner-controlled free text).
    expect(() => assertAlgorithmImplemented(unimplementedAlgorithm)).toThrow(
      /not yet implemented/,
    );
    expect(() =>
      assertAlgorithmImplemented(unimplementedAlgorithm),
    ).not.toThrow(/psi-x/);
  });
});

describe("prepareForExchange: an unimplemented algorithm is refused", () => {
  const prepareWithAlgorithm = (algorithm: Algorithm) =>
    prepareForExchange(
      { linkageTerms: { ...terms, algorithm }, metadata },
      "Tester",
      rawRows,
      columns,
    );

  test("an algorithm with no run path is refused before connecting", () => {
    // The prepare boundary drives the guard, so a terms document that reached core
    // past every schema -- a hand-crafted token, a hand-authored config -- is
    // refused before any credential, terms, or data are sent, rather than run under
    // whichever path the dispatch happens to fall through to.
    expect(() => prepareWithAlgorithm(unimplementedAlgorithm)).toThrow(
      UsageError,
    );
    expect(() => prepareWithAlgorithm(unimplementedAlgorithm)).toThrow(
      /not yet implemented/,
    );
  });
});

// --- Deduplication prepares under every strategy that matches it --------------

describe("prepareForExchange: a deduplicating term is read against the strategy", () => {
  // The prepare step refuses a deduplicate: true term the agreed strategy
  // cannot match, before any connection, with the actionable UsageError (CLI
  // exit 64) rather than the generic mid-run cardinality throw. Both shipped
  // strategies match one, so every case here is the admitted half; the
  // opposite verdict is driven in linkageCardinality.test.ts.
  const prepareDeduplicating = (linkageStrategy: LinkageStrategy) =>
    prepareForExchange(
      {
        linkageTerms: { ...terms, deduplicate: true, linkageStrategy },
        metadata,
      },
      "Tester",
      rawRows,
      columns,
    );

  for (const linkageStrategy of ["cascade", "single-pass"] as const) {
    test(`deduplicate: true under ${linkageStrategy} prepares`, () => {
      expect(() => prepareDeduplicating(linkageStrategy)).not.toThrow();
    });
  }
});

// --- A fan-out transform fails closed before connecting -----------------------

describe("prepareForExchange: a fan-out transform is refused off single-pass", () => {
  // Fan-out matching runs under single-pass alone, so a record whose value
  // splits realizes a candidate set the cascade cannot consume. Refuse before any
  // connection rather than abort the run once a splitting row reaches a round.
  // The base `terms` are cascade, so every case below is the refusing half; the
  // admitted half is the single-pass describe that follows.
  const splittingStandardization: Standardization = [
    {
      output: "first_name",
      input: "first_name",
      steps: [{ function: "to_upper_case" }],
    },
    {
      output: "last_name",
      input: "last_name",
      steps: [{ function: "split_on", params: { delimiter: "-" } }],
    },
  ];

  const splittingElementTerms: LinkageTerms = {
    ...terms,
    linkageKeys: [
      {
        name: "FN_LN",
        elements: [
          { field: "first_name" },
          {
            field: "last_name",
            transform: [{ function: "split_on", params: { delimiter: "-" } }],
          },
        ],
      },
    ],
  };

  test("a standardization declaring split_on is refused before connecting", () => {
    const prepare = () =>
      prepareForExchange(
        {
          linkageTerms: terms,
          metadata,
          standardization: splittingStandardization,
        },
        "Tester",
        rawRows,
        columns,
      );
    expect(prepare).toThrow(UsageError);
    expect(prepare).toThrow(/split_on/);
  });

  test("a linkage-key element transform declaring split_on is refused", () => {
    // The second authoring surface: an element transform fans out into the key's
    // cross-product like the field path, so it is refused on the same terms.
    const prepare = () =>
      prepareForExchange(
        { linkageTerms: splittingElementTerms, metadata },
        "Tester",
        rawRows,
        columns,
      );
    expect(prepare).toThrow(UsageError);
    expect(prepare).toThrow(/split_on/);
  });

  test("the standardization-declared refusal is an OperatorConfigError", () => {
    // A standardization is per-party and local -- no invitation contains one,
    // and the accept path derives its own from the adopted terms -- so this
    // fault is provably the operator's own authoring, and both front ends
    // report it as the actionable config category rather than a generic
    // exchange failure.
    let thrown: unknown;
    try {
      prepareForExchange(
        {
          linkageTerms: terms,
          metadata,
          standardization: splittingStandardization,
        },
        "Tester",
        rawRows,
        columns,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OperatorConfigError);
  });

  test("the element-transform refusal is not an OperatorConfigError", () => {
    // An acceptor adopts the element transforms verbatim from the partner's
    // invitation, so the fault is not provably this operator's own content: the
    // message stays swallowed by the web's generic alert, like the psi-c and
    // deduplicate siblings.
    let thrown: unknown;
    try {
      prepareForExchange(
        { linkageTerms: splittingElementTerms, metadata },
        "Tester",
        rawRows,
        columns,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect(thrown).not.toBeInstanceOf(OperatorConfigError);
  });

  // The run boundary re-checks the terms half, so a PreparedExchange assembled
  // without going through prepareForExchange is refused before its terms reach
  // the partner. Every collaborator the run would touch throws when used, so the
  // refusal is what the rejection can come from -- a connection frame or a PSI
  // call would appear as its own error, failing these assertions.
  const failIfUsed = (what: string) => (): never => {
    throw new Error(`${what} was used past the fan-out refusal`);
  };
  const unusableConnection = (): MessageConnection => ({
    send: failIfUsed("the connection"),
    receive: failIfUsed("the connection"),
    close: failIfUsed("the connection"),
  });
  const unusablePsiLibrary = new Proxy({} as PSILibrary, {
    get: failIfUsed("the PSI library"),
  });

  test("runExchange refuses a fan-out element transform before it connects", async () => {
    // Built legitimately -- terms and standardization both free of fan-out -- then
    // given fan-out TERMS, the way a caller that skipped prepareForExchange could.
    const prepared = prepareForExchange(
      { linkageTerms: terms, metadata },
      "Tester",
      rawRows,
      columns,
    );
    prepared.linkageTerms = splittingElementTerms;

    const run = runExchange(unusableConnection(), "initiator", prepared, {
      psiLibrary: unusablePsiLibrary,
    });
    await expect(run).rejects.toThrow(UsageError);
    await expect(run).rejects.toThrow(/split_on/);
  });

  test("runExchange runs past the guard for terms declaring no fan-out", async () => {
    // The sibling of the refusal: with the same unusable collaborators, terms free
    // of fan-out reach the terms exchange, so the failure is the connection's --
    // proof the refusal above fired on the fan-out rather than on the fixtures.
    const prepared = prepareForExchange(
      { linkageTerms: terms, metadata },
      "Tester",
      rawRows,
      columns,
    );
    const run = runExchange(unusableConnection(), "initiator", prepared, {
      psiLibrary: unusablePsiLibrary,
    });
    await expect(run).rejects.toThrow(/the connection was used/);
  });
});

// --- The same two surfaces run under single-pass ------------------------------

describe("prepareForExchange: a fan-out transform runs under single-pass", () => {
  // The admitted half of the strategy rule: single-pass matches a record's whole
  // candidate set (docs/spec/PROTOCOL.md, Fan-out matching), so both authoring
  // surfaces prepare and reach the terms exchange rather than being refused.
  const singlePassTerms: LinkageTerms = {
    ...terms,
    linkageStrategy: "single-pass",
  };

  const splittingStandardization: Standardization = [
    {
      output: "last_name",
      input: "last_name",
      steps: [{ function: "split_on", params: { delimiter: "-" } }],
    },
  ];

  const splittingElementTerms: LinkageTerms = {
    ...singlePassTerms,
    linkageKeys: [
      {
        name: "FN_LN",
        elements: [
          { field: "first_name" },
          {
            field: "last_name",
            transform: [{ function: "split_on", params: { delimiter: "-" } }],
          },
        ],
      },
    ],
  };

  test("a standardization declaring split_on prepares, declaring no width", () => {
    const prepared = prepareForExchange(
      {
        linkageTerms: singlePassTerms,
        metadata,
        standardization: splittingStandardization,
      },
      "Tester",
      rawRows,
      columns,
    );
    // A local fan-out rides no agreed term, so the terms' width is unchanged
    // and the dataset holds the fan-out the record count is multiplied by.
    expect(declaredEffectiveKeyCount(singlePassTerms)).toBe(
      singlePassTerms.linkageKeys.length,
    );
    expect(prepared.dataset.declaresFanOut).toBe(true);
  });

  test("a linkage-key element transform declaring split_on prepares", () => {
    const prepared = prepareForExchange(
      { linkageTerms: splittingElementTerms, metadata },
      "Tester",
      rawRows,
      columns,
    );
    // The width rides the agreed terms here, so the party's own cleaning declares
    // nothing.
    expect(declaredEffectiveKeyCount(splittingElementTerms)).toBe(
      FAN_OUT_CANDIDATES_PER_ELEMENT,
    );
    expect(prepared.dataset.declaresFanOut).toBe(false);
  });

  test("runExchange passes fan-out terms to the terms exchange", async () => {
    // The run boundary's half: the terms reach the connection rather than the
    // refusal, so the failure is the unusable connection's.
    const failIfUsed = (): never => {
      throw new Error("the connection was used");
    };
    const prepared = prepareForExchange(
      { linkageTerms: splittingElementTerms, metadata },
      "Tester",
      rawRows,
      columns,
    );
    const run = runExchange(
      { send: failIfUsed, receive: failIfUsed, close: failIfUsed },
      "initiator",
      prepared,
      {
        psiLibrary: new Proxy({} as PSILibrary, {
          get: () => {
            throw new Error("the PSI library was used");
          },
        }),
      },
    );
    await expect(run).rejects.toThrow(/the connection was used/);
  });
});

// --- The single-pass ceiling pre-flight, and the refusals ahead of it ---------

describe("prepareForExchange: the single-pass ceiling pre-flight", () => {
  const singlePassTerms: LinkageTerms = {
    ...terms,
    linkageStrategy: "single-pass",
  };
  const fanOutTerms: LinkageTerms = {
    ...singlePassTerms,
    linkageKeys: [
      {
        name: "FN_LN",
        elements: [
          { field: "first_name" },
          {
            field: "last_name",
            transform: [{ function: "split_on", params: { delimiter: "-" } }],
          },
        ],
      },
    ],
  };
  // Just past the ceiling at a given declared width. The budget is on value slots,
  // so a fanning-out config crosses it at its whole declared width times fewer
  // rows. One row object shared across the array: both refusals here fire on the
  // counts, before anything reads a row.
  const rowsOverCeiling = (effectiveKeyCount: number): Array<CSVRow> =>
    new Array<CSVRow>(
      Math.floor(MAX_SINGLE_PASS_CELLS / effectiveKeyCount) + 1,
    ).fill(rawRows[0]);

  test("an over-ceiling dataset declaring no fan-out is refused with the remedies that fit it", () => {
    const prepare = () =>
      prepareForExchange(
        { linkageTerms: singlePassTerms, metadata },
        "Tester",
        rowsOverCeiling(1),
        columns,
      );
    // Every remedy the message names is a configuration change, so the class is
    // the one the CLI maps to EX_USAGE rather than to a transport failure -- and,
    // within it, the member both front ends render to the operator.
    expect(prepare).toThrow(OperatorConfigError);
    expect(prepare).toThrow(/exceed the single-pass ceiling/);
    expect(prepare).not.toThrow(/removing a fan-out/);
    // The pre-flight and the authoritative two-party gate state one remedy, so an
    // acceptor is not told here to narrow keys it did not choose and told the
    // opposite mid-run.
    expect(prepare).toThrow(SINGLE_PASS_LOCAL_REMEDY);
    expect(prepare).not.toThrow(/Reduce the number of linkage keys/);
  });

  test("an over-ceiling fan-out config is offered the fan-out remedy the ceiling has for it", () => {
    // A fan-out key costs its whole declared width in value slots per record, so a
    // fanning config crosses the ceiling at that many times fewer rows -- and
    // dropping the fan-out is a remedy that really does bring it back under. The
    // remedy is offered on the same discriminant the frame layout reads
    // (partyFansOut), so the guidance cannot disagree with the wire about whether
    // this party fans out.
    const overCeilingRows = rowsOverCeiling(FAN_OUT_CANDIDATES_PER_ELEMENT);
    // The dataset really is over the ceiling at the width this config declares,
    // rather than at its plain key count: the fan-out is what puts it over.
    expect(
      singlePassDatasetExceedsCap(
        declaredEffectiveKeyCount(fanOutTerms),
        overCeilingRows.length,
      ),
    ).toBe(true);
    expect(
      singlePassDatasetExceedsCap(
        fanOutTerms.linkageKeys.length,
        overCeilingRows.length,
      ),
    ).toBe(false);
    const prepare = () =>
      prepareForExchange(
        { linkageTerms: fanOutTerms, metadata },
        "Tester",
        overCeilingRows,
        columns,
      );
    expect(prepare).toThrow(OperatorConfigError);
    expect(prepare).toThrow(/exceed the single-pass ceiling/);
    expect(prepare).toThrow(/removing a fan-out/);
  });

  test("a fan-out config inside the ceiling prepares", () => {
    // The pre-flight's other side: the same terms over a dataset the declared
    // width admits reach the built exchange rather than a refusal, so the case
    // above fires on the size and not on the fan-out.
    const prepared = prepareForExchange(
      { linkageTerms: fanOutTerms, metadata },
      "Tester",
      rawRows,
      columns,
    );
    expect(declaredEffectiveKeyCount(fanOutTerms)).toBe(
      FAN_OUT_CANDIDATES_PER_ELEMENT,
    );
    expect(prepared.rowCount).toBe(rawRows.length);
  });

  test("a standardization contradicting its terms is refused ahead of the ceiling", () => {
    // A config with both faults meets the standardization refusal, not the
    // ceiling. Both are fail-closed prepare-time refusals reported the same
    // way (each an OperatorConfigError the front ends render), so an
    // operator meets exactly one, and precedence decides which: the
    // standardization fault names a contradiction to fix at any dataset
    // size, while the ceiling's remedy would wrongly suggest shrinking data.
    const inconsistentStandardization: Standardization = [
      { output: "not_a_field", input: "first_name" },
    ];
    const effectiveKeyCount = declaredEffectiveKeyCount(singlePassTerms);
    const overCeilingRows = rowsOverCeiling(effectiveKeyCount);
    // The dataset really is over the ceiling at the width this config declares, so
    // what arrives below is the ordering's doing rather than a fixture that never
    // reached the gate.
    expect(
      singlePassDatasetExceedsCap(effectiveKeyCount, overCeilingRows.length),
    ).toBe(true);
    const prepare = () =>
      prepareForExchange(
        {
          linkageTerms: singlePassTerms,
          metadata,
          standardization: inconsistentStandardization,
        },
        "Tester",
        overCeilingRows,
        columns,
      );
    expect(prepare).toThrow(StandardizationTermsError);
    expect(prepare).toThrow(/not_a_field/);
    expect(prepare).not.toThrow(/single-pass ceiling/);
  });
});

// --- An unimplemented signing mode fails closed before connecting -------------

// A canonical partner pin: 43 unpadded base64url characters whose last is in the
// canonical final-character set, so it is a value SigningConfigSchema admits.
const partnerFingerprint = "iWD-ZB69Oz6gOpaX_OoC7sD8ohIZj2lETC9qbl-IbPg";

describe("prepareForExchange: an unimplemented signing mode is refused", () => {
  const prepareWithSigning = (signing?: SigningConfig) =>
    prepareForExchange(
      { linkageTerms: terms, metadata, signing },
      "Tester",
      rawRows,
      columns,
    );

  test("mode: session-derived is refused before connecting", () => {
    // Only certificate mode signs a receipt, so a session-derived config would
    // otherwise run to completion and leave the operator the unsigned record.
    // An OperatorConfigError, not a plain UsageError: the signing block is only
    // ever this party's own config, so both front ends report the message as
    // an actionable config fault (and the CLI still exits 64 through the base).
    expect(() => prepareWithSigning({ mode: "session-derived" })).toThrow(
      OperatorConfigError,
    );
    expect(() => prepareWithSigning({ mode: "session-derived" })).toThrow(
      /session-derived/,
    );
  });

  test("mode: certificate prepares normally", () => {
    const prepared = prepareWithSigning({
      mode: "certificate",
      identityFile: "/run/secrets/psilink-signing-identity.json",
      partnerFingerprint,
    });
    expect(prepared.rowCount).toBe(1);
  });

  test("mode: none prepares normally", () => {
    expect(prepareWithSigning({ mode: "none" }).rowCount).toBe(1);
  });
});

// --- Certificate mode with no partner pin fails closed before connecting -----

describe("prepareForExchange: certificate mode with no partner pin is refused", () => {
  const prepareWithSigning = (signing?: SigningConfig) =>
    prepareForExchange(
      { linkageTerms: terms, metadata, signing },
      "Tester",
      rawRows,
      columns,
    );

  test("an unpinned certificate-mode block is refused before connecting", () => {
    // The signature swap runs after the payloads have crossed and rejects
    // any certificate presented against an absent pin, so the run would
    // disclose this party's data, then end with no result and no receipt --
    // leaving only the record of that disclosure. It throws
    // OperatorConfigError, like the unimplemented-mode sibling, because the
    // signing block is always this party's own config (CLI exit 64).
    expect(() => prepareWithSigning({ mode: "certificate" })).toThrow(
      OperatorConfigError,
    );
    expect(() => prepareWithSigning({ mode: "certificate" })).toThrow(
      /signing\.partner_fingerprint/,
    );
  });

  test("an empty pin is refused as no pin at all", () => {
    expect(() =>
      prepareWithSigning({ mode: "certificate", partnerFingerprint: "" }),
    ).toThrow(OperatorConfigError);
  });

  test("mode: none and an absent block need no pin", () => {
    expect(prepareWithSigning({ mode: "none" }).rowCount).toBe(1);
    expect(prepareWithSigning(undefined).rowCount).toBe(1);
  });
});

// --- assertCertificateModePinsPartner (the shared guard) ---------------------

describe("assertCertificateModePinsPartner", () => {
  test("refuses certificate mode with no pin", () => {
    expect(() =>
      assertCertificateModePinsPartner({ mode: "certificate" }),
    ).toThrow(OperatorConfigError);
  });

  test("offers the exchange record as the most a refused run keeps", () => {
    const refuse = () =>
      assertCertificateModePinsPartner({ mode: "certificate" });
    expect(refuse).toThrow(/at most the exchange record of that disclosure/);
    expect(refuse).toThrow(/where record writing is off, nothing at all/);
    expect(refuse).not.toThrow(/keeping only the exchange record/);
  });

  test("passes certificate mode with a pin", () => {
    expect(() =>
      assertCertificateModePinsPartner({
        mode: "certificate",
        partnerFingerprint,
      }),
    ).not.toThrow();
  });

  test("passes every mode that verifies no partner certificate", () => {
    expect(() =>
      assertCertificateModePinsPartner({ mode: "none" }),
    ).not.toThrow();
    expect(() =>
      assertCertificateModePinsPartner({ mode: "session-derived" }),
    ).not.toThrow();
    expect(() => assertCertificateModePinsPartner(undefined)).not.toThrow();
  });

  test("refuses exactly what the verification-time refusal refuses", async () => {
    // The gate exists to refuse, before any payload crosses, the runs the
    // signature swap would refuse after one has. Both read partnerPinIsPresent,
    // and this holds the two to the same answer over the pin values a config
    // can hold -- a gate reading a narrower condition would admit a run that
    // cannot finish.
    const { certificate } = await generateSigningIdentity("Partner");
    for (const pin of [undefined, ""]) {
      expect(() =>
        assertCertificateModePinsPartner({
          mode: "certificate",
          ...(pin !== undefined ? { partnerFingerprint: pin } : {}),
        }),
      ).toThrow(OperatorConfigError);
      await expect(
        assertPartnerCertificateTrusted(certificate, pin),
      ).rejects.toThrow(/no pinned partner fingerprint/);
    }
  });
});

// --- Certificate mode with an unnamed party fails closed before connecting ---

describe("prepareForExchange: certificate mode with no local identity is refused", () => {
  const { identity: _named, ...unnamedTerms } = terms;
  const prepareUnnamed = (signing?: SigningConfig) =>
    prepareForExchange(
      { linkageTerms: unnamedTerms, metadata, signing },
      undefined,
      rawRows,
      columns,
    );

  test("an unnamed certificate-mode party is refused before connecting", () => {
    // A certificate is trusted by the identity its holder used in the agreed
    // terms, so an unnamed party leaves its partner nothing to check the
    // certificate against and the signature swap refuses the step -- after the
    // payloads have crossed. Refused here instead, as the same
    // OperatorConfigError its pin and signing-mode siblings raise.
    expect(() =>
      prepareUnnamed({ mode: "certificate", partnerFingerprint }),
    ).toThrow(OperatorConfigError);
    expect(() =>
      prepareUnnamed({ mode: "certificate", partnerFingerprint }),
    ).toThrow(/linkage_terms\.identity/);
  });

  test("a named party under certificate mode prepares normally", () => {
    const prepared = prepareForExchange(
      {
        linkageTerms: terms,
        metadata,
        signing: { mode: "certificate", partnerFingerprint },
      },
      "Tester",
      rawRows,
      columns,
    );
    expect(prepared.linkageTerms.identity).toBe("Tester");
  });

  test("an unnamed party runs unsigned: mode none, an absent block, and no block at all", () => {
    // The gate binds the certificate-signing configuration alone. An unnamed
    // quick exchange -- the whole point of an optional identity -- is asked
    // nothing, whether it states mode none or no signing block.
    expect(prepareUnnamed({ mode: "none" }).rowCount).toBe(1);
    expect(prepareUnnamed(undefined).rowCount).toBe(1);
    // Terms derived from metadata rather than supplied. The default rule set
    // narrows to the keys the columns support, and every one of them needs an
    // ssn or date of birth beside the names, so the derivation is given an ssn
    // column -- without one it narrows to no key, which the terms-fitness gate
    // refuses.
    const derivableMetadata: Metadata = [
      ...metadata,
      { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    ];
    expect(
      prepareForExchange(
        { metadata: derivableMetadata },
        undefined,
        [{ ...rawRows[0], ssn: "123456789" }],
        [...columns, "ssn"],
      ).linkageTerms.identity,
    ).toBeUndefined();
  });
});

// --- assertCertificateModeNamesLocalParty (the shared guard) -----------------

describe("assertCertificateModeNamesLocalParty", () => {
  const { identity: _named, ...unnamedTerms } = terms;

  test("refuses certificate mode over terms holding no identity", () => {
    expect(() =>
      assertCertificateModeNamesLocalParty(
        { mode: "certificate" },
        unnamedTerms,
      ),
    ).toThrow(OperatorConfigError);
  });

  test("passes certificate mode over terms that name the party", () => {
    expect(() =>
      assertCertificateModeNamesLocalParty({ mode: "certificate" }, terms),
    ).not.toThrow();
  });

  test("passes every mode that signs nothing, named or not", () => {
    expect(() =>
      assertCertificateModeNamesLocalParty({ mode: "none" }, unnamedTerms),
    ).not.toThrow();
    expect(() =>
      assertCertificateModeNamesLocalParty(
        { mode: "session-derived" },
        unnamedTerms,
      ),
    ).not.toThrow();
    expect(() =>
      assertCertificateModeNamesLocalParty(undefined, unnamedTerms),
    ).not.toThrow();
  });

  test("reads the value the receipt step reads, not the identity argument", () => {
    // runExchange destructures `linkageTerms` off the PreparedExchange and
    // refuses the signature swap when its identity is absent, so the gate is held
    // to that same resolved value: a spec holding its own terms keeps their
    // identity whatever the identity argument says. A gate reading the argument
    // instead would pass a run the swap then refuses after the payloads crossed.
    const prepared = prepareForExchange(
      { linkageTerms: unnamedTerms, metadata },
      "Tester",
      rawRows,
      columns,
    );
    expect(prepared.linkageTerms.identity).toBeUndefined();
    expect(() =>
      assertCertificateModeNamesLocalParty(
        { mode: "certificate", partnerFingerprint },
        prepared.linkageTerms,
      ),
    ).toThrow(OperatorConfigError);
  });
});

// --- assertSignedReceiptNamesBothParties (held at two points in a run) -------

describe("assertSignedReceiptNamesBothParties", () => {
  const { identity: _named, ...unnamedTerms } = terms;
  const partnerTerms: LinkageTerms = { ...terms, identity: "Partner Co" };

  test("returns both names when both parties are named", () => {
    expect(assertSignedReceiptNamesBothParties(terms, partnerTerms)).toEqual({
      local: "Tester",
      partner: "Partner Co",
    });
  });

  test("names the unnamed side, on each of the three ways a pair can be", () => {
    // The message is what tells the operator which configuration to change, and
    // the two sides are not interchangeable: only one of them is theirs to fix.
    const raised = (local: LinkageTerms, partner: LinkageTerms) => {
      try {
        assertSignedReceiptNamesBothParties(local, partner);
      } catch (err) {
        return err;
      }
      throw new Error("expected a refusal, got a named pair");
    };
    expect(raised(terms, unnamedTerms)).toBeInstanceOf(
      ReceiptVerificationError,
    );
    expect((raised(terms, unnamedTerms) as Error).message).toContain(
      "the partner's agreed terms name none",
    );
    expect((raised(unnamedTerms, partnerTerms) as Error).message).toContain(
      "this party's agreed terms name none",
    );
    expect((raised(unnamedTerms, unnamedTerms) as Error).message).toContain(
      "neither party's agreed terms name an identity",
    );
  });

  test("every refusal names the remedy on both sides", () => {
    for (const pair of [
      [terms, unnamedTerms],
      [unnamedTerms, partnerTerms],
      [unnamedTerms, unnamedTerms],
    ] as const)
      expect(() =>
        assertSignedReceiptNamesBothParties(pair[0], pair[1]),
      ).toThrow(/linkage_terms\.identity on both sides/);
  });
});

// --- assertSigningModeImplemented (the shared guard) -------------------------

describe("assertSigningModeImplemented", () => {
  test("refuses session-derived", () => {
    expect(() => assertSigningModeImplemented("session-derived")).toThrow(
      OperatorConfigError,
    );
  });

  test("passes the implemented modes and an absent one", () => {
    expect(() => assertSigningModeImplemented("certificate")).not.toThrow();
    expect(() => assertSigningModeImplemented("none")).not.toThrow();
    expect(() => assertSigningModeImplemented(undefined)).not.toThrow();
  });

  test("refuses a mode outside the allowlist", () => {
    // The guard allowlists the implemented modes, so a member later added to
    // SigningModeSchema is refused until it is implemented and allowed here.
    expect(() =>
      assertSigningModeImplemented("authority-backed" as SigningMode),
    ).toThrow(OperatorConfigError);
  });
});

// --- The class every prepare-time refusal holds -----------------------------

// The base terms with their identity dropped, which is what the receipt-naming
// gate's local half refuses.
const { identity: _dropped, ...termsWithoutIdentity } = terms;

// The ledger of what each refusal is TYPED as: the type decides whether the
// message reaches the operator (OperatorConfigError -> the web's actionable
// config alert, the CLI's `config` event category) or is swallowed by the
// generic alert. Pinning the class per check turns a re-typed refusal into a
// test failure instead of a silent visibility change. A row's `spec` also
// reaches its own refusal and no earlier one, pinning refusal order.
const refusalCases: Array<{
  what: string;
  spec: ExchangeDataSpec;
  rows?: Array<CSVRow>;
  columnNames?: Array<string>;
  errorClass: new (message: string) => Error;
  // Whether the operator reads this refusal's own message.
  messageRendered: boolean;
  // A fragment only this refusal's message holds, so a row that reaches an
  // earlier check of the same class fails rather than passing on the type alone.
  says: RegExp;
}> = [
  {
    what: "an algorithm with no run path",
    says: /linkage-terms algorithm is not yet implemented/,
    spec: {
      linkageTerms: { ...terms, algorithm: unimplementedAlgorithm },
      metadata,
    },
    errorClass: UsageError,
    messageRendered: false,
  },
  {
    what: "a count-only document outside the shape psi-c admits",
    says: /must declare exactly one linkage key/,
    spec: {
      linkageTerms: {
        ...terms,
        algorithm: "psi-c",
        linkageKeys: [
          ...terms.linkageKeys,
          { name: "FN", elements: [{ field: "first_name" }] },
        ],
      },
      metadata,
    },
    errorClass: UsageError,
    messageRendered: false,
  },
  {
    what: "a count-only exchange whose metadata transmits a column",
    says: /transmits no data columns/,
    spec: {
      linkageTerms: { ...terms, algorithm: "psi-c" },
      metadata: [
        ...metadata,
        { name: "note", type: "other", role: "payload", isPayload: true },
      ],
    },
    errorClass: UsageError,
    messageRendered: false,
  },
  {
    what: "a signing mode with no run path",
    says: /receipt signing mode is not yet implemented/,
    spec: {
      linkageTerms: terms,
      metadata,
      signing: { mode: "session-derived" },
    },
    errorClass: OperatorConfigError,
    messageRendered: true,
  },
  {
    what: "certificate mode pinning no partner fingerprint",
    says: /pins no partner fingerprint/,
    spec: { linkageTerms: terms, metadata, signing: { mode: "certificate" } },
    errorClass: OperatorConfigError,
    messageRendered: true,
  },
  {
    what: "certificate mode naming no local party",
    says: /names no party/,
    spec: {
      linkageTerms: termsWithoutIdentity,
      metadata,
      signing: { mode: "certificate", partnerFingerprint },
    },
    errorClass: OperatorConfigError,
    messageRendered: true,
  },
  {
    what: "a payload.send that is not what metadata discloses",
    says: /payload\.send must name exactly the columns/,
    spec: {
      linkageTerms: { ...terms, payload: { send: [{ name: "note" }] } },
      metadata,
    },
    errorClass: UsageError,
    messageRendered: false,
  },
  {
    what: "a disclosed column whose name is too long to carry",
    says: /limit on a column name/,
    spec: {
      linkageTerms: terms,
      metadata: [
        ...metadata,
        {
          name: "n".repeat(MAX_NAME_LENGTH + 1),
          type: "other",
          role: "payload",
          isPayload: true,
        },
      ],
    },
    errorClass: UsageError,
    messageRendered: false,
  },
  {
    what: "a disclosure that has drifted from this party's own commitment",
    says: /no longer honor the payload disclosure it committed to/,
    spec: {
      linkageTerms: terms,
      metadata,
      disclosedPayloadColumns: ["note"],
    },
    errorClass: OutboundDisclosureRefusalError,
    messageRendered: false,
  },
  {
    what: "an outbound payload set this party has not confirmed",
    says: /has not confirmed which of its own columns it sends/,
    spec: {
      linkageTerms: terms,
      metadata,
      outboundPayloadConsent: { status: "pending" },
    },
    errorClass: OutboundDisclosureRefusalError,
    messageRendered: false,
  },
  {
    what: "an authored standardization contradicting its own terms",
    says: /not_a_field/,
    spec: {
      linkageTerms: terms,
      metadata,
      standardization: [{ output: "not_a_field", input: "first_name" }],
    },
    errorClass: StandardizationTermsError,
    messageRendered: true,
  },
  {
    what: "an input that cannot satisfy every agreed linkage key",
    says: /cannot satisfy every linkage key/,
    spec: { linkageTerms: terms, metadata },
    columnNames: ["first_name"],
    errorClass: LinkageTermsUnsatisfiableError,
    messageRendered: false,
  },
  {
    what: "a fan-out declared in this party's own standardization",
    says: /split_on/,
    spec: {
      linkageTerms: terms,
      metadata,
      standardization: [
        {
          output: "last_name",
          input: "last_name",
          steps: [{ function: "split_on", params: { delimiter: "-" } }],
        },
      ],
    },
    errorClass: OperatorConfigError,
    messageRendered: true,
  },
  {
    what: "a fan-out declared in a linkage key's element transform",
    says: /split_on/,
    spec: {
      linkageTerms: {
        ...terms,
        linkageKeys: [
          {
            name: "FN_LN",
            elements: [
              { field: "first_name" },
              {
                field: "last_name",
                transform: [
                  { function: "split_on", params: { delimiter: "-" } },
                ],
              },
            ],
          },
        ],
      },
      metadata,
    },
    errorClass: UsageError,
    messageRendered: false,
  },
  {
    what: "a dataset over the single-pass ceiling",
    says: /exceed the single-pass ceiling/,
    spec: {
      linkageTerms: { ...terms, linkageStrategy: "single-pass" },
      metadata,
    },
    rows: new Array<CSVRow>(MAX_SINGLE_PASS_CELLS + 1).fill(rawRows[0]),
    errorClass: OperatorConfigError,
    messageRendered: true,
  },
];

describe("prepareForExchange: the class every refusal holds", () => {
  for (const refusal of refusalCases) {
    test(`${refusal.what} is refused as ${refusal.errorClass.name}`, () => {
      let thrown: unknown;
      try {
        prepareForExchange(
          refusal.spec,
          "Tester",
          refusal.rows ?? rawRows,
          refusal.columnNames ?? columns,
        );
      } catch (err) {
        thrown = err;
      }
      // Every one of them is a configuration error at the CLI's exit boundary
      // (64, EX_USAGE), whatever a front end reports it as.
      expect(thrown).toBeInstanceOf(UsageError);
      expect((thrown as Error).message).toMatch(refusal.says);
      // The exact class, not merely a member of its family: `name` is what each
      // constructor sets, so a re-typing to a subclass fails here rather than
      // passing on the base.
      expect(thrown).toBeInstanceOf(refusal.errorClass);
      expect((thrown as Error).name).toBe(refusal.errorClass.name);
      expect(thrown instanceof OperatorConfigError).toBe(
        refusal.messageRendered,
      );
    });
  }

  test("a linkage key whose declared window opens at no length is refused", () => {
    // Not a row in the table above, because the refusal has to be measured
    // against the same terms holding a window that DOES open: the terms are
    // identical but for the bounds, so what stops the run is the window rather
    // than the fixture around it.
    const keyedOnWindow = (params: Record<string, unknown>): LinkageTerms => ({
      ...terms,
      linkageKeys: [
        {
          name: "FN_LN",
          elements: [
            {
              field: "first_name",
              transform: [{ function: "substring", params }],
            },
            { field: "last_name" },
          ],
        },
      ],
    });
    const prepareWith = (params: Record<string, unknown>) =>
      prepareForExchange(
        { linkageTerms: keyedOnWindow(params), metadata },
        "Tester",
        rawRows,
        columns,
      );

    expect(() => prepareWith({ start: 1, length: 3 })).not.toThrow();
    // A bound left unfilled: admitted by the terms schema, and treated as no window
    // at any value length, so the key produces nothing for either party.
    expect(() => prepareWith({ length: 3 })).toThrow(
      LinkageTermsUnsatisfiableError,
    );
  });

  test("the deduplicating-strategy refusal is unreachable, so it has no row", () => {
    // The one prepare-time refusal the table cannot drive: every shipped strategy
    // matches a deduplicating term, so no spec reaches assertDeduplicateImplemented.
    // Checked rather than stated, so a strategy that answers otherwise fails here
    // and is given a row of its own instead of appearing untyped.
    expect(
      Object.values(DEDUPLICATE_IMPLEMENTED_BY_STRATEGY).every(Boolean),
    ).toBe(true);
  });
});
