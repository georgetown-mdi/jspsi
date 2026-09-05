import { describe, expect, test } from "vitest";

import { getDefaultLinkageTerms } from "../src/defaults/linkageTerms.js";
import {
  summarizeInvitation,
  TRANSFORM_FUNCTION_GLOSSARY,
} from "../src/consent/invitationSummary.js";
import { disclosedColumnNames, inferMetadata } from "../src/config/metadata.js";
import {
  assertDeduplicateImplemented,
  DEDUPLICATE_IMPLEMENTED_BY_STRATEGY,
} from "../src/linkageTermsPolicy.js";

import type { ConnectionEndpoint } from "../src/config/invitation.js";
import type {
  LinkageStrategy,
  TransformStep,
} from "../src/config/linkageTerms.js";

// A linkable column set (ssn + names + dob give satisfiable keys) that ALSO
// includes columns the inferred metadata discloses: `notes` infers as an
// `other` column (role payload) and `member_id` as a single row-identifier
// left isPayload, so both are transmitted.
const DISCLOSING_COLUMNS = [
  "ssn",
  "first_name",
  "last_name",
  "dob",
  "notes",
  "member_id",
];

const LINKAGE_ONLY_COLUMNS = ["ssn", "first_name", "last_name", "dob"];

describe("the consent summary's payload block", () => {
  test("derives the received set from the held subset with no payload.send authored", () => {
    // A CLI-style invitation: the terms author no payload block, but the token
    // holds the disclosed-columns subset. The acceptor's consent display must
    // derive the columns-it-will-receive from that subset -- the same predicate
    // the wire transmits on -- not from the (absent) payload.send. This is the
    // under-declaration gap the dedicated field closes, and the no-drift
    // invariant: the displayed set equals the transmitted set over one metadata.
    const metadata = inferMetadata(DISCLOSING_COLUMNS);
    const disclosed = disclosedColumnNames(metadata);
    const terms = getDefaultLinkageTerms("Inviter", metadata);
    expect(terms.payload).toBeUndefined();
    const summary = summarizeInvitation({
      linkageTerms: terms,
      disclosedPayloadColumns: disclosed,
    });
    expect(summary.payload?.send).toEqual(disclosed);
  });

  test("records which source the displayed send set came from", () => {
    // Both sources are declarations, and only one of them is a commitment: an
    // acceptance writes the held subset as what it will receive and reconciles
    // against it, while an authored send with no held subset leaves nothing to
    // reconcile against. A surface classifying the received-columns line reads
    // this narrower flag, so it is pinned apart from sendDeclared.
    const metadata = inferMetadata(DISCLOSING_COLUMNS);
    const terms = getDefaultLinkageTerms("Inviter", metadata);
    const authoredSend = { payload: { send: [{ name: "notes" }] } };
    const authored = summarizeInvitation({
      linkageTerms: { ...terms, ...authoredSend },
    });
    expect(authored.payload).toMatchObject({
      send: ["notes"],
      sendDeclared: true,
      sendFromCarriedSubset: false,
    });
    const carried = summarizeInvitation({
      linkageTerms: { ...terms, ...authoredSend },
      disclosedPayloadColumns: disclosedColumnNames(metadata),
    });
    expect(carried.payload).toMatchObject({
      send: disclosedColumnNames(metadata),
      sendDeclared: true,
      sendFromCarriedSubset: true,
    });
  });

  test("shows no received columns when nothing is held or authored", () => {
    const terms = getDefaultLinkageTerms(
      "Inviter",
      inferMetadata(LINKAGE_ONLY_COLUMNS),
    );
    const summary = summarizeInvitation({ linkageTerms: terms });
    expect(summary.payload).toBeUndefined();
  });

  test("shows an empty held subset as a declared 'receive nothing'", () => {
    // The web inviter always includes the disclosed subset, possibly empty. An
    // empty held set is the strict "receive nothing" commitment (a later
    // non-empty payload aborts), NOT the lazy case -- so the section is
    // rendered with an empty, DECLARED send (the renderer shows "(none)"),
    // distinct from a lazy/absent set which suppresses the section. This
    // keeps the consent surfaces and the runtime enforcement aligned.
    const terms = getDefaultLinkageTerms(
      "Inviter",
      inferMetadata(LINKAGE_ONLY_COLUMNS),
    );
    const summary = summarizeInvitation({
      linkageTerms: terms,
      disclosedPayloadColumns: [],
    });
    expect(summary.payload).toEqual({
      send: [],
      sendDeclared: true,
      sendFromCarriedSubset: true,
      receive: [],
      receiveDeclared: false,
    });
  });

  test("shows an authored empty payload.receive as a declared request", () => {
    // The receive-side mirror of the declared-empty send case above: an
    // authored `payload.receive: []` is the strict "the acceptor sends
    // nothing" assertion, distinct from an absent receive (lazy). It must
    // show as a DECLARED receive (receiveDeclared true, receive empty -> the
    // renderer shows "(none)") so a consent surface does not collapse it
    // with the lazy case.
    const terms = getDefaultLinkageTerms(
      "Inviter",
      inferMetadata(LINKAGE_ONLY_COLUMNS),
    );
    const summary = summarizeInvitation({
      linkageTerms: { ...terms, payload: { receive: [] } },
    });
    expect(summary.payload).toEqual({
      send: [],
      sendDeclared: false,
      sendFromCarriedSubset: false,
      receive: [],
      receiveDeclared: true,
    });
  });
});

describe("the consent summary's retain disclosure", () => {
  const terms = getDefaultLinkageTerms(
    "Inviter",
    inferMetadata(LINKAGE_ONLY_COLUMNS),
  );
  const SPLIT_ENDPOINT: ConnectionEndpoint = {
    channel: "filedrop",
    inboundPath: "/mnt/share/in",
    outboundPath: "/mnt/share/out",
  };
  const SHARED_ENDPOINT: ConnectionEndpoint = {
    channel: "filedrop",
    path: "/mnt/share",
  };

  test("states retention where the token declares it", () => {
    expect(
      summarizeInvitation({ linkageTerms: terms, inviterRetainsFiles: true })
        .disclosesRetainedFiles,
    ).toBe(true);
  });

  // The second ground, and the gap it closes: a split-directory endpoint seeds
  // the accepting side into retain mode whatever the token declares (a split
  // connection cannot be configured without it), so a display reading only the
  // declaration would leave that party consenting to a permanent transcript with
  // nothing said. psilink's own mints do not produce this pair, but a foreign or
  // older token can, and the shape is decidable right here at display time.
  test("states retention for a split-directory endpoint that declares nothing", () => {
    expect(
      summarizeInvitation({
        linkageTerms: terms,
        connectionEndpoint: SPLIT_ENDPOINT,
      }).disclosesRetainedFiles,
    ).toBe(true);
  });

  // The shape test is the seeding's own predicate, so it must not widen to "has
  // an endpoint": a single shared directory seeds no options at all, and its
  // acceptor sets its own mode.
  test("states nothing for a shared-directory endpoint that declares nothing", () => {
    expect(
      summarizeInvitation({
        linkageTerms: terms,
        connectionEndpoint: SHARED_ENDPOINT,
      }).disclosesRetainedFiles,
    ).toBe(false);
  });

  // The narrowing that keeps a renderer off the claim no surface may make. The
  // token's field is three-valued -- declared retain, declared delete, nothing
  // declared -- and the last two are alike here on purpose: neither is a promise
  // that the exchange cleans up after itself (a run killed outright, or one that
  // fails after the handshake, leaves files behind in either mode), so a surface
  // reading this flag cannot word one.
  test.each([
    { case: "an explicit false", source: { inviterRetainsFiles: false } },
    { case: "an absent declaration", source: {} },
    {
      case: "a webrtc endpoint, which has no retain mode",
      source: {
        connectionEndpoint: {
          channel: "webrtc",
          host: "peer.example",
        } as ConnectionEndpoint,
      },
    },
  ])("discloses no retention for $case", ({ source }) => {
    expect(
      summarizeInvitation({ linkageTerms: terms, ...source })
        .disclosesRetainedFiles,
    ).toBe(false);
  });

  // A declared delete mode does not cancel the shape: the acceptor is still
  // seeded into retain mode by the split pair, so the line it is shown states
  // the mode its own run would be in. Through decode this pair can no longer
  // arrive -- the token schema's refusal is pinned by invitation.test.ts's
  // retain-declaration cases -- but summarizeInvitation also renders non-token
  // sources, such as the inviter's own pre-mint preview, so the branch stays
  // live rather than dead.
  test("a split endpoint states retention even against a declared false", () => {
    expect(
      summarizeInvitation({
        linkageTerms: terms,
        connectionEndpoint: SPLIT_ENDPOINT,
        inviterRetainsFiles: false,
      }).disclosesRetainedFiles,
    ).toBe(true);
  });
});

describe("the consent summary's fan-out register", () => {
  const metadata = inferMetadata(LINKAGE_ONLY_COLUMNS);
  const baseTerms = getDefaultLinkageTerms("Inviter", metadata);
  const fanOutTerms = {
    ...baseTerms,
    linkageKeys: [
      {
        name: "last name",
        elements: [
          {
            field: "last_name",
            transform: [{ function: "split_on", params: { delimiter: " " } }],
          },
        ],
      },
    ],
  };

  test("a fan-out element under single-pass is marked as matching on several values", () => {
    // The element matches on every candidate it realizes, so the header marker
    // names that breadth. The two flags beside it are what selects the consent
    // fact each surface renders.
    const summary = summarizeInvitation({
      linkageTerms: { ...fanOutTerms, linkageStrategy: "single-pass" },
    });
    expect(summary.linkageKeys[0].headerFields).toEqual([
      "last name (multiple)",
    ]);
    expect(summary.fansOut).toBe(true);
    expect(summary.fanOutApplied).toBe(true);
  });

  test("the same element under cascade is marked as not supported", () => {
    // Refused before the exchange runs, so no matching of any breadth happens
    // and naming one would describe a run that does not occur.
    const summary = summarizeInvitation({
      linkageTerms: { ...fanOutTerms, linkageStrategy: "cascade" },
    });
    expect(summary.linkageKeys[0].headerFields).toEqual([
      "last name (not supported)",
    ]);
    expect(summary.fansOut).toBe(true);
    expect(summary.fanOutApplied).toBe(false);
  });

  test("terms declaring no fan-out are in neither register", () => {
    const summary = summarizeInvitation({
      linkageTerms: { ...baseTerms, linkageStrategy: "single-pass" },
    });
    expect(summary.fansOut).toBe(false);
  });

  test("the deduplicate register holds the strategy's own verdict on the term", () => {
    // The applied flag is the strategy's verdict on the term -- the signal a
    // surface reads to withhold what a deduplicating run discloses for an
    // invitation acceptance would refuse outright. Both shipped strategies
    // match one, so both show the disclosure; the withheld direction is
    // driven over the whole verdict table by the test below.
    const applied = (linkageStrategy: "cascade" | "single-pass"): boolean =>
      summarizeInvitation({
        linkageTerms: { ...baseTerms, deduplicate: true, linkageStrategy },
      }).deduplicateApplied;
    expect(applied("cascade")).toBe(true);
    expect(applied("single-pass")).toBe(true);
  });

  test("the applied flag and the acceptance refusal agree on every strategy", () => {
    // The two read one verdict, and the whole table is driven so neither can be
    // left behind: were the flag restated as its own expression, retiring the
    // refusal for a strategy would leave the copy wrongly withheld for it, and
    // each side's own tests would keep passing.
    for (const strategy of Object.keys(
      DEDUPLICATE_IMPLEMENTED_BY_STRATEGY,
    ) as LinkageStrategy[]) {
      const terms = {
        ...baseTerms,
        deduplicate: true,
        linkageStrategy: strategy,
      };
      const refuses = ((): boolean => {
        try {
          assertDeduplicateImplemented(terms);
          return false;
        } catch {
          return true;
        }
      })();
      expect(
        summarizeInvitation({ linkageTerms: terms }).deduplicateApplied,
      ).toBe(!refuses);
    }
  });

  test("the glossary line for the splitting step describes what it does to matching", () => {
    // The line an acceptor reads beside the step, which must state the widening
    // rather than a refusal that no longer covers every strategy.
    expect(TRANSFORM_FUNCTION_GLOSSARY.split_on).toMatch(
      /each able to match independently/,
    );
    expect(TRANSFORM_FUNCTION_GLOSSARY.split_on).not.toMatch(/refuses/);
  });
});

describe("the consent summary's date-collapse marker", () => {
  const metadata = inferMetadata(LINKAGE_ONLY_COLUMNS);
  const baseTerms = getDefaultLinkageTerms("Inviter", metadata);
  const LITERAL_REGION_FORMAT = "ACME-YYYYMMDD";
  // One key over the date field, with whatever transform a case declares.
  const termsWith = (transform: TransformStep[]) => ({
    ...baseTerms,
    linkageKeys: [
      { name: "date", elements: [{ field: "date_of_birth", transform }] },
    ],
  });
  const headerFor = (transform: TransformStep[]) =>
    summarizeInvitation({ linkageTerms: termsWith(transform) }).linkageKeys[0]
      .headerFields;
  const paramsFor = (transform: TransformStep[]) =>
    summarizeInvitation({ linkageTerms: termsWith(transform) }).linkageKeys[0]
      .elements[0].transforms[0].params;
  const parseDate = (outputFormat: string): TransformStep => ({
    function: "parse_date",
    params: { inputFormat: "MM/DD/YYYY", outputFormat },
  });
  const slice = (start: number, length: number): TransformStep => ({
    function: "substring",
    params: { start, length },
  });

  test("a value-preserving step between the parse_date and the slice keeps the collapse", () => {
    // The header reads the whole element, so a step that leaves the window's
    // characters where the layout put them no longer returns the marker to the
    // milder truncation word while every record still lands on "ACME".
    expect(
      headerFor([
        parseDate(LITERAL_REGION_FORMAT),
        { function: "to_upper_case" },
        slice(1, 4),
      ]),
    ).toEqual(["date of birth (any date)"]);
    expect(headerFor([parseDate(LITERAL_REGION_FORMAT), slice(1, 4)])).toEqual([
      "date of birth (any date)",
    ]);
  });

  test("a run whose composed window leaves the layout shows no marker at all", () => {
    // The first link reads the literal region and the second slices out of
    // that window, so the element matches no record. "Any date" would claim
    // a match that never happens; "partial" would claim a truncation of a
    // value no record holds. Every step here reads the layout, not the
    // value, so the drop is universal -- the dead-pipeline surface the
    // dead-key advisory speaks for.
    expect(
      headerFor([parseDate(LITERAL_REGION_FORMAT), slice(1, 4), slice(5, 2)]),
    ).toEqual(["date of birth"]);
  });

  test("a value-dependent drop of every probe keeps the wider word", () => {
    // The same all-probes drop with a step whose reach is the data's to
    // decide. The measurement decides nothing there, so the header must
    // not fall to the milder truncation word, and must not claim the
    // element is dead either.
    expect(
      headerFor([
        parseDate(LITERAL_REGION_FORMAT),
        {
          function: "filter_regex",
          params: { pattern: "NOTHING-MATCHES-THIS" },
        },
        slice(1, 4),
      ]),
    ).toEqual(["date of birth (any date)"]);
  });

  test("a step the measurement cannot run shows the collapse, not the milder word", () => {
    // A function name core does not recognize sits between the parse_date and the
    // slice, so the measurement cannot compile the run. The header resolves that
    // unknown breadth UP to "any date" rather than falling to the "pattern
    // replacement"-style milder word the trailing step would otherwise name -- an
    // inviter must not drop the marker by naming one step this build cannot run.
    expect(
      headerFor([
        parseDate(LITERAL_REGION_FORMAT),
        { function: "no_such_function" },
        slice(1, 4),
      ]),
    ).toEqual(["date of birth (any date)"]);
  });

  test("a probe inflated past the value ceiling shows any date", () => {
    // The round-2 ceiling evasion: a replace_regex expands the rendered probe past
    // the per-value ceiling, so the measured run returns before it can read the
    // window. Were the header to fall to "pattern replacement" there, an inviter
    // could inflate one probe while every real date still collapsed onto one
    // constant. The marker resolves up to "any date" instead.
    expect(
      headerFor([
        parseDate(LITERAL_REGION_FORMAT),
        {
          function: "replace_regex",
          params: { pattern: "ACME", replacement: "X".repeat(5000) },
        },
        slice(1, 4),
      ]),
    ).toEqual(["date of birth (any date)"]);
  });

  test("naming a probe's rendered value does not withdraw the collapse", () => {
    // The probe dates ship in public source, so an inviter can author one step
    // naming exactly what one of them renders to. The header still names the
    // collapse the pipeline delivers for every other date.
    expect(
      headerFor([
        parseDate(LITERAL_REGION_FORMAT),
        { function: "null_if", params: { values: ["ACME-19710102"] } },
        slice(1, 4),
      ]),
    ).toEqual(["date of birth (any date)"]);
  });

  test("a rescued dead run names the fallback rather than falling silent", () => {
    // The run drops every date, but the coalesce puts every record back on
    // one constant, so the element is not dead and the accurate marker is
    // the substitution's.
    expect(
      headerFor([
        parseDate(LITERAL_REGION_FORMAT),
        slice(1, 4),
        slice(5, 2),
        { function: "coalesce", params: { default: "UNKNOWN" } },
      ]),
    ).toEqual(["date of birth (fallback)"]);
  });

  test("a plain reformatting keeps no marker", () => {
    // Routine canonicalization between equivalent full layouts, unflagged by
    // design; the slice that reads the date itself is the milder word.
    expect(headerFor([parseDate("YYYY-MM-DD")])).toEqual(["date of birth"]);
    expect(headerFor([parseDate("YYYY-MM-DD"), slice(1, 4)])).toEqual([
      "date of birth (partial)",
    ]);
  });

  test("the outputFormat row survives a params record padded past the display cap", () => {
    // The same party authors the transform a stated limit understates and the
    // params record beside it. Twenty filler entries ahead of the format would
    // push it into the overflow marker were the rows shown in declaration order.
    const filler = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`filler${i}`, `value${i}`]),
    );
    const params = paramsFor([
      {
        function: "parse_date",
        params: {
          ...filler,
          inputFormat: "MM/DD/YYYY",
          outputFormat: LITERAL_REGION_FORMAT,
        },
      },
      slice(1, 4),
    ]);
    expect(params.slice(0, 2)).toEqual([
      "inputFormat: MM/DD/YYYY",
      `outputFormat: ${LITERAL_REGION_FORMAT}`,
    ]);
    expect(params[params.length - 1]).toBe("... 6 more");
  });

  test("an over-long value ahead of the outputFormat does not spend its row", () => {
    // The second suppression route: a value long enough to be truncated where it
    // is rendered. Each row is bounded on its own, and the verdict-bearing rows
    // lead, so nothing a partner declares is rendered ahead of the format.
    const params = paramsFor([
      {
        function: "parse_date",
        params: {
          flood: "F".repeat(4000),
          outputFormat: LITERAL_REGION_FORMAT,
        },
      },
      slice(1, 4),
    ]);
    expect(params[0]).toBe(`outputFormat: ${LITERAL_REGION_FORMAT}`);
    expect(params[1]).toMatch(/^flood: F+\.\.\.\[truncated\]$/);
  });
});

describe("the consent summary's per-step params", () => {
  const baseTerms = getDefaultLinkageTerms(
    "Inviter",
    inferMetadata(LINKAGE_ONLY_COLUMNS),
  );

  test("a step named after an Object prototype member still renders", () => {
    // A step's `function` is partner free text, so a name that resolves only on
    // Object.prototype reaches the lookup that leads a step's rows with the
    // params a consent verdict reads. Unguarded, that lookup hands `new Set(...)`
    // a prototype member rather than a param list and throws where the summary is
    // rendered, taking the whole consent screen down with it.
    for (const name of ["constructor", "toString", "__proto__", "valueOf"]) {
      const summary = summarizeInvitation({
        linkageTerms: {
          ...baseTerms,
          linkageKeys: [
            {
              name: "date",
              elements: [
                {
                  field: "date_of_birth",
                  transform: [{ function: name, params: { a: "1" } }],
                },
              ],
            },
          ],
        },
      });
      expect(
        summary.linkageKeys[0].elements[0].transforms[0].params,
        name,
      ).toEqual(["a: 1"]);
    }
  });
});
