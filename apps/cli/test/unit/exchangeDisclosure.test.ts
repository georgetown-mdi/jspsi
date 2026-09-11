import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import logLibrary from "loglevel";
import { afterEach, beforeEach, expect, test } from "vitest";

import {
  CONSENT_FACTS,
  COUNT_ONLY_DISCLOSURE_STATEMENT,
  DEDUPLICATE_PARTNER_DECLARED_DISCLOSURE_STATEMENT,
  DEDUPLICATE_PARTNER_DECLARED_SIDE_NOTE,
  DEFAULT_LINKAGE_RULE_SET,
  LINKAGE_RULE_SET_VERDICT_COPY,
  linkageRuleSetVerdictNote,
  SELF_AUTHORED_EXCHANGE_FACTS,
  setDiagnosticSink,
  UsageError,
} from "@psilink/core";
import type {
  ConsentFact,
  ExchangeDataSpec,
  LinkageTerms,
  Metadata,
} from "@psilink/core";

import { consentRepresentationProbes } from "@psilink/core/testing";

import { prepareDataset } from "../../src/commands/exchange";
import { renderExchangeDisclosure } from "../../src/exchangeDisclosure";
import { configureLogFile } from "../../src/util/logging";
import {
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../loggingTestSupport";
import { streamOf, ttyStream, withStdin } from "../stdinStream";

snapshotDiagnosticSinkAndLevel();

const DISCLOSURE_HEADING =
  "What this exchange sends and matches on. Nothing has been sent yet:";
const CONFIRMATION_HEADING =
  "Nothing is sent until you confirm what this exchange will send:";

/** Terms of the shape two parties author from their own files: no invitation
 * between them, so nothing here was adopted from a partner's proposal. */
const localTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health",
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

function metadataDisclosing(columns: string[]): Metadata {
  return [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
    ...columns.map((name) => ({
      name,
      type: "other" as const,
      role: "payload" as const,
      isPayload: true,
    })),
  ];
}

/** Every line {@link renderExchangeDisclosure} emits for `terms`. */
function rendered(terms: LinkageTerms, columns: string[] = []): string[] {
  const lines: string[] = [];
  renderExchangeDisclosure(
    (line) => lines.push(line),
    terms,
    metadataDisclosing(columns),
  );
  return lines;
}

let dir: string;
let configFile: string;
let input: string;
let logged: string[];
let promptWrites: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-exchange-disclosure-"));
  configFile = path.join(dir, "psilink.yaml");
  input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "first_name,last_name,diagnosis\nAda,Lovelace,A\n");
  logged = [];
  promptWrites = "";
  setDiagnosticSink((_method, _prefix, args) => {
    logged.push(args.map((arg) => String(arg)).join(" "));
  });
  logLibrary.getLogger("exchange").setLevel("info");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Prepare a dataset from `spec` over the CSV above, collecting both channels a
 * consent surface can land on. `interactive` decides only whether a terminal is
 * attached, which is what the display must not read. Standard error is captured
 * rather than left to reach the runner's own output: the display writes there,
 * where the confirmation beside it asks.
 *
 * `logFile` is the resolved `--log-file` a surface reads to decide whether the
 * run's record is somewhere else and owed a copy; installing the sink that
 * writes the file is the caller's.
 */
async function prepare(
  spec: ExchangeDataSpec,
  interactive: boolean,
  logFile?: string,
): Promise<unknown> {
  const stdio = captureStdio();
  try {
    return await withStdin(interactive ? ttyStream() : streamOf(""), () =>
      prepareDataset(spec, "County Health", input, {
        configPath: configFile,
        logFile,
      }).then(
        () => undefined,
        (e: unknown) => e,
      ),
    );
  } finally {
    promptWrites = stdio.stderrWrites.join("");
    stdio.restore();
  }
}

/** Everything the last {@link prepare} put in front of the operator, on either
 * channel: the prompt stream a consent surface prints on, and the diagnostic
 * log a run with no `--log-file` routes the rest of its output to. */
function shownToOperator(): string {
  return [...logged, promptWrites].join("\n");
}

// --- A locally authored configuration ----------------------------------------

test("a two-config run shows what it sends and what it matches on", async () => {
  // No invitation was accepted here, so nothing has ever shown this operator
  // the terms their own file commits them to, nor the columns their input file
  // makes transmittable by default.
  expect(await prepare({ linkageTerms: localTerms }, true)).toBe(undefined);
  const output = shownToOperator();
  expect(output).toContain(DISCLOSURE_HEADING);
  expect(output).toContain("columns you will send (enforced):");
  expect(output).toContain("\n    - diagnosis");
  expect(output).toContain("you will receive the result (enforced): yes");
  expect(output).toContain(
    "your partner will receive the result (enforced): yes",
  );
  expect(output).toContain("PSI algorithm (enforced): psi");
  expect(output).toContain("linkage strategy (enforced): cascade");
  expect(output).toContain(
    "duplicate matches (enforced): no more than one of your records matches a single one of your partner's",
  );
  expect(output).toContain("matched on (enforced): first name, last name");
  expect(output).toContain("linkage keys (enforced):");
  expect(output).toContain("    - FN_LN: first name - last name");
});

test("a run with no terminal to ask on shows the same lines, and asks nothing", async () => {
  // The scheduled run is the one the display exists for: it discloses exactly
  // as much as an attended one, and there is nothing to answer either way.
  expect(await prepare({ linkageTerms: localTerms }, true)).toBe(undefined);
  const attended = promptWrites;
  expect(await prepare({ linkageTerms: localTerms }, false)).toBe(undefined);
  expect(promptWrites).toBe(attended);
  expect(promptWrites).toContain(DISCLOSURE_HEADING);
});

test("a log level that drops diagnostics still shows the display", async () => {
  // The only account this party gets of what its run discloses. An operator who
  // quieted the run's diagnostics quieted its progress reporting, not the one
  // surface stating what leaves their machine.
  logLibrary.getLogger("exchange").setLevel("warn");
  expect(await prepare({ linkageTerms: localTerms }, false)).toBe(undefined);
  expect(logged).toEqual([]);
  expect(promptWrites).toContain(DISCLOSURE_HEADING);
  expect(promptWrites).toContain("columns you will send (enforced):");
  expect(promptWrites).toContain("\n    - diagnosis");
});

test("a log file keeps the display at a level that drops diagnostics", async () => {
  // The same quieted run, with the record kept somewhere the operator is not
  // watching: the copy docs/CLI.md promises is the whole value of --log-file on
  // an unattended run, so a level that leaves the print intact may not leave the
  // file empty.
  logLibrary.getLogger("exchange").setLevel("warn");
  const logFile = path.join(dir, "run.log");
  const sink = configureLogFile(logFile);
  try {
    expect(await prepare({ linkageTerms: localTerms }, false, logFile)).toBe(
      undefined,
    );
  } finally {
    sink.close();
  }
  const kept = fs.readFileSync(logFile, "utf8");
  expect(kept).toContain(DISCLOSURE_HEADING);
  expect(kept).toContain("columns you will send (enforced):");
  expect(kept).toContain("    - diagnosis");
});

// --- A configuration written by accepting an invitation ----------------------

test("an accept-derived configuration is not shown the facts a second time", async () => {
  // Its consent record is the confirmation surface's, and accepting showed the
  // terms; the run adds no second account of them.
  const spec: ExchangeDataSpec = {
    linkageTerms: localTerms,
    outboundPayloadConsent: { status: "confirmed", columns: ["diagnosis"] },
  };
  expect(await prepare(spec, true)).toBe(undefined);
  expect(shownToOperator()).not.toContain(DISCLOSURE_HEADING);
});

test("a set the confirmation surface asks about is shown once, by that surface", async () => {
  const spec: ExchangeDataSpec = {
    linkageTerms: localTerms,
    outboundPayloadConsent: { status: "pending" },
  };
  expect(await prepare(spec, false)).toBeInstanceOf(UsageError);
  const output = shownToOperator();
  expect(output).toContain(CONFIRMATION_HEADING);
  expect(output).not.toContain(DISCLOSURE_HEADING);
  expect(output.match(/columns you will send \(enforced\)/g)).toHaveLength(1);
});

// --- The shapes the columns line takes ---------------------------------------

test("a partner entitled to no result is told no payload is sent", () => {
  const lines = rendered(
    {
      ...localTerms,
      output: { expectsOutput: true, shareWithPartner: false },
    },
    ["diagnosis"],
  );
  expect(lines).toContain(
    "  columns you will send (enforced): (none) -- your partner receives no result, so no payload is sent",
  );
  expect(lines.join("\n")).not.toContain("- diagnosis");
  // Withholding a result rests on the agreed terms being honored, so the line
  // takes the partner's-word marker rather than the enforced one a receipt gets.
  expect(lines.join("\n")).toContain(
    "your partner will receive the result (your partner's word): no",
  );
});

test("an input file with nothing transmittable says only matched records", () => {
  expect(rendered(localTerms)).toContain(
    "  columns you will send (enforced): (none) -- only matched records",
  );
});

test("a count-only exchange states what it reveals and that it sends no columns", () => {
  const lines = rendered({
    ...localTerms,
    algorithm: "psi-c",
    output: { expectsOutput: true, shareWithPartner: true },
  }).join("\n");
  expect(lines).toContain("PSI algorithm (enforced): psi-c");
  expect(lines).toContain(COUNT_ONLY_DISCLOSURE_STATEMENT);
  expect(lines).toContain(
    "A count-only exchange sends no data columns in either direction",
  );
});

test("a count-only exchange whose input marks a column lists none, and says the run stops", () => {
  // The count-only refusal comes moments later, from the same metadata: listing
  // the column as sent would state a disclosure this run cannot make.
  const lines = rendered(
    {
      ...localTerms,
      algorithm: "psi-c",
      output: { expectsOutput: true, shareWithPartner: true },
    },
    ["diagnosis"],
  );
  expect(lines).toContain("  columns you will send (enforced): (none)");
  expect(lines.join("\n")).not.toContain("- diagnosis");
  expect(lines.join("\n")).toContain(
    "Your input marks one or more columns to send to your partner, which a count-only exchange cannot do, so this run stops before it starts.",
  );
  expect(lines.join("\n")).toContain(
    "A count-only exchange sends no data columns in either direction",
  );
});

test("a count-only run keeps that account whichever party the count goes to", () => {
  // The algorithm holds both directions, so the reason the columns are not sent
  // is the same one a partner entitled to the result would read.
  const lines = rendered(
    {
      ...localTerms,
      algorithm: "psi-c",
      output: { expectsOutput: true, shareWithPartner: false },
    },
    ["diagnosis"],
  ).join("\n");
  expect(lines).toContain("  columns you will send (enforced): (none)");
  expect(lines).not.toContain("- diagnosis");
  expect(lines).toContain(
    "A count-only exchange sends no data columns in either direction",
  );
  expect(lines).toContain("so this run stops before it starts");
});

// --- What a partner entitled to no result still learns -------------------------

test("a partner receiving no result is told what it still learns about its own records", () => {
  // A cascade returns the partner its matched positions as the rounds go, so the
  // match itself tells it which of its records this party holds.
  const lines = rendered({
    ...localTerms,
    output: { expectsOutput: true, shareWithPartner: false },
  }).join("\n");
  expect(lines).toContain(
    "what your partner learns about its own records (enforced):",
  );
  expect(lines).toContain(
    "Even when honored, your partner learns which of its own records are in your data",
  );
});

test("a run that withholds the partner's half of the table says so instead", () => {
  // Single-pass, this party the sole receiver, and no column requested of the
  // partner: the run suppresses the partner's half, so it is never sent which of
  // its own records matched.
  const lines = rendered({
    ...localTerms,
    linkageStrategy: "single-pass",
    output: { expectsOutput: true, shareWithPartner: false },
    payload: { receive: [] },
  }).join("\n");
  expect(lines).toContain(
    "what your partner learns about its own records (enforced):",
  );
  expect(lines).toContain(
    "its process is never sent which of its own records are in your data",
  );
  // And the sentence says where a partner whose input discloses one anyway
  // lands, which is a refusal on both parties before any of the match runs.
  expect(lines).toContain(
    "the exchange is refused for both parties before the match starts",
  );
  expect(lines).not.toContain(
    "your partner learns which of its own records are in your data",
  );
});

test("a count-only run states no own-membership fact, since its helper learns none", () => {
  // The non-receiving party of a count-only run is the sender: it computes
  // nothing from the round, and what the run does disclose is the algorithm's.
  const lines = rendered({
    ...localTerms,
    algorithm: "psi-c",
    output: { expectsOutput: true, shareWithPartner: false },
  }).join("\n");
  expect(lines).not.toContain("what your partner learns about its own records");
  expect(lines).toContain(COUNT_ONLY_DISCLOSURE_STATEMENT);
});

test("terms leaving neither party a result say the run stops instead", () => {
  // `validateCompatibility` refuses that pair outright ("neither party expects
  // output"), so the run stops at the terms exchange: an own-membership
  // sentence here would state a disclosure of an exchange that does not happen.
  const lines = rendered({
    ...localTerms,
    output: { expectsOutput: false, shareWithPartner: false },
  }).join("\n");
  expect(lines).toContain(
    "Neither you nor your partner expects a result from these terms, so this " +
      "run stops at the terms exchange, before any linkage data is sent.",
  );
  expect(lines).not.toContain("what your partner learns about its own records");
  expect(lines).not.toContain(CONSENT_FACTS.partnerLearnsOwnMembership.note);
});

test("a partner entitled to the result gets no own-membership line", () => {
  expect(rendered(localTerms).join("\n")).not.toContain(
    "what your partner learns about its own records",
  );
});

// --- The matching terms -------------------------------------------------------

test("a grouping this party declares states what it discloses, in its own terms", () => {
  const lines = rendered({ ...localTerms, deduplicate: true }).join("\n");
  expect(lines).toContain(
    "duplicate matches (enforced): several of your records may match a single one of your partner's",
  );
  expect(lines).toContain(DEDUPLICATE_PARTNER_DECLARED_DISCLOSURE_STATEMENT);
  expect(lines).toContain(DEDUPLICATE_PARTNER_DECLARED_SIDE_NOTE);
});

/** {@link localTerms} with a key that splits one value into several match
 * candidates, the shape that raises the fan-out fact on this display. */
const splittingKeyTerms: LinkageTerms = {
  ...localTerms,
  linkageKeys: [
    {
      name: "LN",
      elements: [
        {
          field: "last_name",
          transform: [{ function: "split_on", params: { delimiter: " " } }],
        },
      ],
    },
  ],
};

/** {@link localTerms} with a key matched in either order -- a candidate set
 * that declares no split, which is the shape the shipped default keys take. */
const swappedKeyTerms: LinkageTerms = {
  ...localTerms,
  linkageKeys: [
    {
      name: "FN_LN",
      elements: [{ field: "first_name" }, { field: "last_name" }],
      swap: ["first_name", "last_name"],
    },
  ],
};

test("a key splitting one value states what the run matches on", () => {
  // The other surface reading this fact is the acceptance display, and both
  // read core's shared classification, so an operator meets the widening in
  // the same words whether it accepted an invitation or wrote its own terms.
  const lines = rendered(splittingKeyTerms).join("\n");
  expect(lines).toContain("several values per record (enforced):");
  expect(lines).toContain(CONSENT_FACTS.fanOutCandidates.note);

  // Silent where the run refuses the split rather than matching on it, and
  // where the terms declare none: the line is not a fixture of the display.
  expect(
    rendered({ ...splittingKeyTerms, algorithm: "psi-c" }).join("\n"),
  ).not.toContain("several values per record");
  expect(rendered(localTerms).join("\n")).not.toContain(
    "several values per record",
  );
});

test("a candidate set beside this party's own grouping states what it groups", () => {
  // The grouping the pair the partner's own setting completes makes of records
  // no linkage key links. It follows the candidate set rather than the split
  // alone, so a key matched in either order states it where the fan-out line
  // above says nothing.
  for (const terms of [splittingKeyTerms, swappedKeyTerms]) {
    const lines = rendered({ ...terms, deduplicate: true }).join("\n");
    expect(lines).toContain(
      "records grouped with no value in common (enforced):",
    );
    expect(lines).toContain(CONSENT_FACTS.candidateSetChainsGrouping.note);
  }
  expect(rendered(swappedKeyTerms).join("\n")).not.toContain(
    "several values per record",
  );

  // Silent where the pair is refused rather than run, and where these terms
  // declare no side of it.
  for (const terms of [
    { ...swappedKeyTerms, deduplicate: true, linkageStrategy: "single-pass" },
    swappedKeyTerms,
    { ...localTerms, deduplicate: true },
  ] as const)
    expect(rendered(terms).join("\n")).not.toContain(
      "records grouped with no value in common",
    );
});

test("single-pass linkage states the disclosure it trades for its round trip", () => {
  const lines = rendered({
    ...localTerms,
    linkageStrategy: "single-pass",
  }).join("\n");
  expect(lines).toContain("linkage strategy (enforced): single-pass");
  expect(lines).toContain("single-pass linkage means one of you sends");
});

// --- The rule set the terms cite ----------------------------------------------

/** The citation every case below names: the one rule set this build ships, and
 * so the only one it can reach a verdict on either way. */
const shippedCitation = DEFAULT_LINKAGE_RULE_SET.reference;

/** Terms citing the shipped set over the rules that set declares -- the state a
 * path that seeds the rules and writes the citation together leaves behind. */
const citedAndDrawn: LinkageTerms = {
  ...localTerms,
  linkageFields: [...DEFAULT_LINKAGE_RULE_SET.linkageFields],
  linkageKeys: [...DEFAULT_LINKAGE_RULE_SET.linkageKeys],
  linkageRuleSet: shippedCitation,
};

/** The caveat written for a reader who may have WRITTEN the citation, which is
 * every reader of this display. Read through core's own selection rather than
 * pinned as a literal, so a surface reading the recipient's sentence -- which
 * names the other party as the author of these terms -- fails here. */
const citingPartyCaveat = linkageRuleSetVerdictNote(
  "contradicted",
  "citing-party",
);

test("a citation this build disproves is stated before the run", () => {
  // Both halves diverge: the terms declare neither the fields nor the keys the
  // cited set does, which is what a hand edit to either list leaves behind.
  const lines = rendered({
    ...localTerms,
    linkageRuleSet: shippedCitation,
  }).join("\n");

  expect(lines).toContain(
    "the rule set your terms cite does not match what they declare:",
  );
  // What the citation claims, named beside what this build found for it. The
  // declared keys are the block directly above, which the caveat closes on.
  expect(lines).toContain(
    `keys (${LINKAGE_RULE_SET_VERDICT_COPY.contradicted.marker}): ` +
      `"${shippedCitation.keySet.name}" ${shippedCitation.keySet.version}`,
  );
  expect(lines).toContain(
    `fields (${LINKAGE_RULE_SET_VERDICT_COPY.contradicted.marker}): ` +
      `"${shippedCitation.fieldSet.name}" ${shippedCitation.fieldSet.version}`,
  );
  expect(lines).toContain(citingPartyCaveat);
  // The remedy is this reader's own. The sentence written for a party being
  // shown someone else's citation would attribute these terms to a partner.
  expect(lines).not.toContain(LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note);
});

test("a half this build disproves is stated beside the half it confirms", () => {
  // The two halves are judged separately, so a citation is not all or nothing:
  // these terms declare the set's own fields under a key it does not declare.
  const lines = rendered({
    ...citedAndDrawn,
    linkageKeys: localTerms.linkageKeys,
  }).join("\n");

  expect(lines).toContain(
    `keys (${LINKAGE_RULE_SET_VERDICT_COPY.contradicted.marker}): ` +
      `"${shippedCitation.keySet.name}"`,
  );
  expect(lines).toContain(
    `fields (${LINKAGE_RULE_SET_VERDICT_COPY.consistent.marker}): ` +
      `"${shippedCitation.fieldSet.name}"`,
  );
  expect(lines).toContain(citingPartyCaveat);
});

test("a citation the rules support, and no citation, state nothing", () => {
  // Neither reading is a finding this seat can act on: rules that support their
  // citation leave nothing to correct, and terms claiming no provenance make no
  // claim to disprove. A display stating either would put two lines of
  // provenance in front of an operator on every run.
  for (const terms of [citedAndDrawn, localTerms]) {
    const lines = rendered(terms).join("\n");
    expect(lines).not.toContain("the rule set your terms cite");
    expect(lines).not.toContain(citingPartyCaveat);
    for (const verdict of ["consistent", "contradicted", "unchecked"] as const)
      expect(lines).not.toContain(
        LINKAGE_RULE_SET_VERDICT_COPY[verdict].marker,
      );
  }
  // Held non-vacuous: the same terms with the rules edited out from under the
  // citation do state it, so the silence above is the verdict and not the
  // display having no such line at all.
  expect(
    rendered({ ...citedAndDrawn, linkageKeys: localTerms.linkageKeys }).join(
      "\n",
    ),
  ).toContain(citingPartyCaveat);
});

test("a set name this build does not ship is left unjudged", () => {
  // Nothing here resolves a foreign name to content, so there is no comparison
  // to report and no remedy to offer -- the citation stands as the operator's
  // own statement about its own rules.
  const lines = rendered({
    ...localTerms,
    linkageRuleSet: {
      fieldSet: { name: "county-pii", version: "3.1.0" },
      keySet: { name: "county-keys", version: "3.1.0" },
    },
  }).join("\n");
  expect(lines).not.toContain("the rule set your terms cite");
  expect(lines).not.toContain("county-keys");
  expect(lines).toContain(DISCLOSURE_HEADING);
});

// --- The facts this seat alone can state --------------------------------------

/**
 * Every shape of the display, joined: between them the output directions, the
 * two algorithms, the two strategies, and a grouping reach every line it can
 * print. The sweep below reads this rather than one rendering, so a sentence
 * only a single shape reaches still counts as rendered.
 */
function everyRendering(): string {
  return [
    rendered(localTerms, ["diagnosis"]),
    rendered({ ...localTerms, deduplicate: true }),
    rendered(
      {
        ...localTerms,
        output: { expectsOutput: true, shareWithPartner: false },
      },
      ["diagnosis"],
    ),
    rendered({
      ...localTerms,
      linkageStrategy: "single-pass",
      output: { expectsOutput: true, shareWithPartner: false },
      payload: { receive: [] },
    }),
    rendered({ ...localTerms, algorithm: "psi-c" }, ["diagnosis"]),
    rendered({
      ...localTerms,
      output: { expectsOutput: false, shareWithPartner: true },
    }),
    rendered({
      ...localTerms,
      output: { expectsOutput: false, shareWithPartner: false },
    }),
  ]
    .map((lines) => lines.join("\n"))
    .join("\n");
}

test("every note core marks as this seat's own is a line this display prints", () => {
  // The set is core's judgment, read from it rather than restated here, and it
  // is the same list the acceptance sweep excludes by -- so a fact added to it
  // and rendered by nobody fails here instead of passing both suites.
  const facts: ReadonlyArray<ConsentFact> = SELF_AUTHORED_EXCHANGE_FACTS.map(
    (id) => CONSENT_FACTS[id],
  );
  const notes = facts
    .map((fact) => fact.note)
    .filter((note) => note !== undefined);
  expect(notes.length).toBeGreaterThan(0);
  const rendering = everyRendering();
  for (const note of notes) expect(rendering).toContain(`\n    ${note}`);
});

test("no line names an inviting or accepting party", () => {
  // The operator here read no invitation and sent none: a line addressing them
  // as one of those two parties would tell them nothing about which side they
  // are on.
  const lines = rendered(
    {
      ...localTerms,
      deduplicate: true,
      linkageStrategy: "single-pass",
      output: { expectsOutput: true, shareWithPartner: false },
    },
    ["diagnosis"],
  ).join("\n");
  expect(lines).not.toMatch(/inviting party|accepting party|invitation/i);
});

// --- The terms this display is bound to state ---------------------------------

test("the display represents every consent-relevant linkage term, bar the recorded gaps", () => {
  // Which terms a reader's decision turns on is judged once, in core's shared
  // classification, so this display and the two acceptance surfaces cannot
  // drift on the answer. A term is represented here when two sets of terms
  // differing at that term alone print differently; one this display omits
  // prints identically and has to be recorded as a gap in that same
  // classification, which is what keeps a term added to core from landing
  // here silently.
  //
  // One metadata document, reused across every rendering, so only the terms
  // move: it is what the run resolved from the operator's own input file
  // rather than a linkage term, and moving it would answer a question about
  // that file instead.
  const render = (terms: LinkageTerms): string =>
    rendered(terms, ["diagnosis"]).join("\n");

  // The shapes that name the accepting party's own `deduplicate` are not
  // measured here: this seat accepted no invitation, so the pair such a shape
  // states is one it never runs. Held non-vacuous both ways.
  const allProbes = consentRepresentationProbes();
  const probes = allProbes.filter(
    (probe) => probe.acceptorDeduplicate === undefined,
  );
  expect(probes.length).toBeGreaterThan(0);
  expect(allProbes.length).toBeGreaterThan(probes.length);
  expect(
    probes
      .filter((probe) => render(probe.base) === render(probe.variant))
      .map((probe) => probe.path)
      .sort(),
  ).toEqual(
    probes
      .filter((probe) => probe.unrepresented.exchangeDisclosure !== undefined)
      .map((probe) => probe.path)
      .sort(),
  );
});
