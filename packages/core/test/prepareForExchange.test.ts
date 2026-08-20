import { expect, test, describe } from "vitest";

import {
  prepareForExchange,
  runExchange,
  assertAlgorithmImplemented,
  assertSigningModeImplemented,
} from "../src/exchange";
import {
  OperatorConfigError,
  StandardizationTermsError,
  UsageError,
} from "../src/errors";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type { MessageConnection } from "../src/connection/messageConnection";
import type { LinkageTerms } from "../src/config/linkageTerms";
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
    // The failure carries the underlying inconsistency through, so an operator
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

describe("assertAlgorithmImplemented", () => {
  test("passes psi-c", () => {
    expect(() => assertAlgorithmImplemented("psi-c")).not.toThrow();
  });

  test("passes psi", () => {
    expect(() => assertAlgorithmImplemented("psi")).not.toThrow();
  });
});

// --- Deduplication fails closed before connecting -----------------------------

describe("prepareForExchange: a deduplicating term is refused", () => {
  // Matching runs strictly one-to-one, so deduplicate: true would be silently
  // matched one-to-one rather than honored -- refuse it before any connection,
  // with the actionable UsageError (CLI exit 64), never the generic mid-run
  // cardinality throw. The output block already satisfies the schema's
  // deduplicate-requires-output constraint.
  const deduplicatingTerms: LinkageTerms = { ...terms, deduplicate: true };

  test("deduplicate: true is refused before connecting", () => {
    expect(() =>
      prepareForExchange(
        { linkageTerms: deduplicatingTerms, metadata },
        "Tester",
        rawRows,
        columns,
      ),
    ).toThrow(UsageError);
    expect(() =>
      prepareForExchange(
        { linkageTerms: deduplicatingTerms, metadata },
        "Tester",
        rawRows,
        columns,
      ),
    ).toThrow(/deduplicate/);
  });
});

// --- A fan-out transform fails closed before connecting -----------------------

describe("prepareForExchange: a fan-out transform is refused", () => {
  // Matching runs on a single value per record, so a record whose value splits
  // realizes a candidate set no linkage strategy can consume. Refuse before any
  // connection rather than abort the run once a splitting row reaches a round.
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
    // A standardization is per-party and local -- no invitation carries one, and
    // the accept path derives its own from the adopted terms -- so this fault is
    // provably the operator's own authoring, and both front ends surface it as
    // the actionable config category rather than a generic exchange failure.
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
  // call would surface as its own error, failing these assertions.
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

// --- An unimplemented signing mode fails closed before connecting -------------

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
    // ever this party's own config, so both front ends surface the message as an
    // actionable config fault (and the CLI still exits 64 through the base).
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
      identityFile: "~/.psilink/signing-identity.json",
    });
    expect(prepared.rowCount).toBe(1);
  });

  test("mode: none prepares normally", () => {
    expect(prepareWithSigning({ mode: "none" }).rowCount).toBe(1);
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
