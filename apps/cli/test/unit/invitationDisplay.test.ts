import { describe, expect, test } from "vitest";
import {
  ACCEPTOR_DEDUPLICATE_CONTROL_FACTS,
  CONSENT_FACTS,
  DEDUPLICATE_ACCEPTOR_SIDE_NOTE,
  DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
  DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  getLogger,
  LINKAGE_RULE_SET_VERDICT_COPY,
  MAX_DECLARED_NAMES_SHOWN,
  MAX_NAME_LENGTH,
  MAX_PAYLOAD_ENTRIES,
  PROPOSED_NOT_APPLIED_NOTES,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
  SELF_AUTHORED_EXCHANGE_FACTS,
  summarizeInvitation,
  UNRECOGNIZED_TRANSFORM_NOTE,
  unshownDeclaredNamesLine,
  UsageError,
} from "@alcove/core";
import {
  BEL,
  CONSENT_PROBE_TERMS,
  COUNT_ONLY_PROBE_TERMS,
  ESC,
  PRINTABLE_ASCII,
  RLO,
  consentRepresentationProbes,
  hostileVariants,
} from "@alcove/core/testing";
import type {
  Algorithm,
  ConnectionEndpoint,
  ConsentFact,
  InvitationToken,
  LinkageRuleSetReference,
  LinkageStrategy,
  LinkageTerms,
  TransformStep,
} from "@alcove/core";

import { decodeAndValidateInvitation } from "../../src/invitationDecode";
import { logDecisionFacts } from "../../src/invitationDisplay";
import {
  encodeRaw,
  FUTURE,
  OUTBOUND_SEND_LABEL,
  REPEAT_HEADING,
  REPEAT_HEADING_UNATTENDED,
  renderDisplayInvitation,
  sampleTerms,
  sampleToken,
} from "../invitationDisplayTestSupport";

// A token whose one linkage key splits its element's value into several match
// candidates: the shape that raises a fan-out consent fact, in whichever of the
// two registers the strategy puts it.
function splittingKeyToken(
  expires: string,
  linkageStrategy: LinkageStrategy,
  algorithm: Algorithm = "psi",
): InvitationToken {
  const token = sampleToken(expires);
  return {
    ...token,
    linkageTerms: {
      ...token.linkageTerms,
      algorithm,
      linkageStrategy,
      linkageKeys: [
        {
          name: "last name",
          elements: [
            {
              field: token.linkageTerms.linkageFields[0].name,
              transform: [{ function: "split_on", params: { delimiter: " " } }],
            },
          ],
        },
      ],
    },
  };
}

/**
 * The bullet entries listed directly under `heading`, sliced out of the rendered
 * lines so an assertion about one list cannot be satisfied -- or broken -- by a
 * bullet belonging to another block at the same depth. An entry is a bullet line
 * one indent level deeper than the heading; an entry's own nested detail (a
 * linkage key's `matches on:` and `elements:` sub-list) sits deeper still and is
 * skipped rather than ending the run, so every sibling entry is collected and a
 * single displayed entry is distinguishable from two. The block ends at the first
 * line back at the heading's own level or shallower, or at an entry-level line
 * that is not a bullet.
 */
function entriesUnder(
  lines: ReadonlyArray<string>,
  heading: string,
): Array<string> {
  const index = lines.indexOf(heading);
  if (index < 0) return [];
  const indentOf = (line: string): number =>
    line.length - line.trimStart().length;
  const headingIndent = indentOf(heading);
  const entryIndent = headingIndent + 2;
  const bullet = `${" ".repeat(entryIndent)}- `;
  const entries: Array<string> = [];
  for (const line of lines.slice(index + 1)) {
    if (line.startsWith(bullet)) {
      entries.push(line.slice(bullet.length));
      continue;
    }
    if (indentOf(line) <= entryIndent) break;
  }
  return entries;
}

// The display's marked label for the inviting party's declared word, spelled
// out rather than derived from CONSENT_FACTS -- OUTBOUND_SEND_LABEL (imported
// from invitationDisplayTestSupport) is its counterpart -- so a marker that
// silently changed vocabulary reddens the assertions using it instead of
// following the table.
const INVITING_PARTY_LABEL = "inviting party (your partner's word)";

/** The acceptor's own outbound-send columns, as displayed. */
function outboundSendEntries(lines: ReadonlyArray<string>): Array<string> {
  return entriesUnder(lines, `  ${OUTBOUND_SEND_LABEL}:`);
}

// The headings the two declared payload directions render under when the inviter
// authored them, spelled out rather than derived, for the reason the labels above
// are: a marker that silently changed vocabulary must redden the assertion. Only
// the direction's declared total is a parameter, so looking a heading up by exact
// text asserts the rendered total as well as the wording.
const declaredSendHeading = (declaredTotal: number): string =>
  `  columns you will receive (your partner's word, ${declaredTotal} declared):`;
const declaredReceiveHeading = (declaredTotal: number): string =>
  "  columns the inviting party requests from you " +
  `(your partner's word, ${declaredTotal} declared):`;

/**
 * A declaration at core's own ceiling, every name long enough to spend the whole
 * escaped display allowance: the shape that decides whether the operator can still
 * reach the question this prompt is asking.
 *
 * The count overdrives what the intake path can deliver, to pin the
 * cap's arithmetic at the schema ceiling rather than at whatever an encoded token
 * happens to fit: `decodeInvitation` refuses an encoded invitation above
 * `MAX_ENCODED_INVITATION_LENGTH` (64 KiB) before it parses, which holds a declared
 * list to roughly 346 names of this shape.
 *
 * The filler is ordinary content rather than an attack, and outside printable
 * ASCII: U+00E9 LATIN SMALL LETTER E WITH ACUTE is what a real declaration holds
 * and it escapes at this sink, so a name of them spends the allowance in full.
 * Written as an escape rather than a raw byte, so a test about an invisible
 * expansion is itself readable.
 */
function floodedDeclaration(prefix: string): Array<{ name: string }> {
  const filler = "\u00E9".repeat(MAX_NAME_LENGTH);
  return Array.from({ length: MAX_PAYLOAD_ENTRIES }, (_, index) => ({
    name: `${prefix}${index}-${filler}`,
  }));
}

describe("displayInvitation: the declared terms it discloses (columns, citations, dedup, retention)", () => {
  test("decode error escapes a hostile unrecognized endpoint key name end to end", async () => {
    // A malicious inviter adds an endpoint key whose NAME has control/ANSI
    // bytes; strictObject rejects it, echoing the name into the rejection
    // decodeAndValidateInvitation raises. The bytes reach the operator through
    // the renderer every CLI error sink takes, which escapes them ONCE -- the
    // error's own message holds them raw, as its input.
    const hostileKey = "\x1b[2J\x1b[31mFAKE";
    const encoded = await encodeRaw({
      ...sampleToken(FUTURE()),
      connectionEndpoint: {
        channel: "sftp",
        host: "h",
        [hostileKey]: 1,
      },
    });
    const err = await decodeAndValidateInvitation(encoded).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UsageError);
    const rendered = sanitizeErrorForDisplay(err as UsageError);
    expect(rendered).toContain(
      `Remove unexpected field(s): ${sanitizeForDisplay(hostileKey)}`,
    );
    expect(rendered).not.toContain("\x1b");
  });

  test("displayInvitation escapes a hostile inviter identity and key names", () => {
    const token: InvitationToken = {
      ...sampleToken(FUTURE()),
      linkageTerms: {
        ...sampleTerms("Inviter Org"),
        identity: "\x1b[31mEVIL\u202e",
        linkageKeys: [{ name: "k\x1b[0m", elements: [{ field: "ssn" }] }],
        // A hostile requested-from-you column name reaches the new "requests from
        // you" line; it must be escaped there too.
        payload: { receive: [{ name: "req\x1b[0m\u202e" }] },
      },
    };
    const log = getLogger("accept-display-test");
    log.setLevel("silent");
    // A hostile acceptor-file column name reaches the new "columns you will send"
    // line; it must be escaped there too. The acceptor's own outbound-send names
    // are operator-file strings rather than partner-controlled, but they still pass
    // through the same escaping, so the assertion covers that line as well.
    const joined = renderDisplayInvitation(log, token, ["send\x1b[0m\u202e"]);
    expect(joined).not.toContain("\x1b");
    expect(joined).not.toContain("\u202e");
    expect(joined).toContain("\\x1b");
    expect(joined).toContain("\\u202e");
  });

  test("displayInvitation: the held disclosed subset shows names, '(none)' when empty, and nothing when absent", () => {
    // The acceptor's "columns you will receive" line. A present subset is shown
    // (an empty one as "(none)", since the empty set is a real "receive nothing"
    // commitment); an absent subset (an older or metadata-unknown mint, reconciled
    // lazily) shows no line at all.
    const log = getLogger("accept-display-receive-test");
    log.setLevel("silent");
    const lines = (token: InvitationToken): string =>
      renderDisplayInvitation(log, token);
    const base = sampleToken(FUTURE());
    const named = lines({
      ...base,
      disclosedPayloadColumns: ["diagnosis", "notes"],
    });
    expect(named).toContain("columns you will receive (enforced, 2 declared):");
    expect(named).toContain("\n    - diagnosis");
    expect(named).toContain("\n    - notes");
    // The empty set is a bare "(none)", with nothing after it: the line renders only
    // for a declared direction (the absent case below prints no line at all), so the
    // reader of a "(none)" is already looking at an explicit declaration, and the
    // enforcement register is what the label's marker holds. What the declaration
    // commits its party to is stated at length in docs/CLI.md, not on the prompt.
    expect(
      lines({ ...base, disclosedPayloadColumns: [] }).split("\n"),
    ).toContain("  columns you will receive (enforced, 0 declared): (none)");
    expect(
      lines({ ...base, disclosedPayloadColumns: undefined }),
    ).not.toContain("columns you will receive");
  });

  test("displayInvitation: an invitation giving this party no result counts no received columns", () => {
    // The mint-reachable pair: the result is not shared, the terms declare an
    // empty send, and the token still holds the subset a mint stamps whatever
    // the output direction. No column crosses to a party entitled to no result,
    // so the prompt states the non-receipt once and puts no count of arriving
    // columns two lines under it.
    const log = getLogger("accept-display-no-result-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const joined = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        output: { expectsOutput: true, shareWithPartner: false },
        payload: { send: [] },
      },
      disclosedPayloadColumns: ["diagnosis"],
    });
    expect(joined).toContain("you will receive the result (enforced): no");
    expect(joined).not.toContain("columns you will receive");
    expect(joined).not.toContain("diagnosis");
  });

  test("displayInvitation: the rule-set citation displays as the partner's word, and is absent when none is cited", () => {
    // The citation is the inviting party's own claim about its rules, so the block
    // holds the trust-contingent marker rather than displaying as a provenance
    // Alcove vouched for. An invitation citing nothing prints no line:
    // hand-authored rules have no citation, and inventing one would attribute them.
    const log = getLogger("accept-display-rule-set-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const cited = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        linkageRuleSet: {
          fieldSet: { name: "baseline-pii", version: "1.0.0" },
          keySet: { name: "hmis-keys", version: "2.3.0" },
        },
      },
    });
    expect(cited).toContain("linkage rule set (your partner's word):");
    expect(cited).toContain('"hmis-keys" 2.3.0');
    expect(cited).toContain('"baseline-pii" 1.0.0');

    // The name is partner-controlled free text and the version beside it is not, so
    // the quoting is what keeps the boundary between them readable: a name ending in
    // a version-shaped token must not be treated as the version this line reports.
    const spacedName = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        linkageRuleSet: {
          fieldSet: { name: "baseline-pii", version: "1.0.0" },
          keySet: { name: "hmis-keys 9.9.9", version: "2.3.0" },
        },
      },
    });
    expect(spacedName).toContain('"hmis-keys 9.9.9" 2.3.0');

    const uncited = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: { ...base.linkageTerms, linkageRuleSet: undefined },
    });
    expect(uncited).not.toContain("linkage rule set");
    for (const verdict of ["consistent", "contradicted", "unchecked"] as const)
      expect(uncited).not.toContain(
        LINKAGE_RULE_SET_VERDICT_COPY[verdict].note,
      );
  });

  test("displayInvitation: a cited set name cannot render another citation's line", () => {
    // The name is delimited through core's terms-value boundary, which doubles a
    // delimiter inside a run, so a name holding one cannot end its own value: what
    // the operator reads is the whole name, never the line a citation of a shorter
    // name at another version produces.
    const log = getLogger("accept-display-rule-set-delimiter-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const cite = (linkageRuleSet: LinkageRuleSetReference): string =>
      renderDisplayInvitation(log, {
        ...base,
        linkageTerms: { ...base.linkageTerms, linkageRuleSet },
      });
    // Neither citation names a set this build ships -- the first by version, the
    // second by name -- so both render under one marker and the pair of lines
    // differs in nothing but how the name is rendered.
    const marker = LINKAGE_RULE_SET_VERDICT_COPY.unchecked.marker;
    const imitated = {
      keys: `    keys (${marker}): "hmis-keys" 9.9.9`,
      fields: `    fields (${marker}): "baseline-pii" 9.9.9`,
    };
    const imitatedLines = cite({
      fieldSet: { name: "baseline-pii", version: "9.9.9" },
      keySet: { name: "hmis-keys", version: "9.9.9" },
    }).split("\n");
    expect(imitatedLines).toContain(imitated.keys);
    expect(imitatedLines).toContain(imitated.fields);

    const rendered = cite({
      fieldSet: { name: 'baseline-pii" 9.9.9', version: "1.0.0" },
      keySet: { name: 'hmis-keys" 9.9.9', version: "1.0.0" },
    });
    expect(rendered.split("\n")).toContain(
      `    keys (${marker}): "hmis-keys"" 9.9.9" 1.0.0`,
    );
    expect(rendered.split("\n")).toContain(
      `    fields (${marker}): "baseline-pii"" 9.9.9" 1.0.0`,
    );
    expect(rendered).not.toContain(imitated.keys);
    expect(rendered).not.toContain(imitated.fields);

    // The version renders undelimited on the strength of the shape the terms schema
    // holds it to, and that shape is re-checked on the value in hand: one outside it
    // renders delimited instead, rather than standing in the line unattributed.
    expect(
      cite({
        fieldSet: { name: "baseline-pii", version: "1.0.0" },
        keySet: { name: "hmis-keys", version: '1.0.0" 9.9.9' },
      }).split("\n"),
    ).toContain(`    keys (${marker}): "hmis-keys" "1.0.0"" 9.9.9"`);
  });

  test("displayInvitation: each citation half holds this build's own verdict on it", () => {
    const log = getLogger("accept-display-rule-set-verdict-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());

    // The default terms ARE the built-in sets, narrowed by nothing, and they cite
    // them: both halves resolve and match.
    const truthful = renderDisplayInvitation(log, base);
    expect(truthful).toContain(
      `keys (${LINKAGE_RULE_SET_VERDICT_COPY.consistent.marker}): "hmis-keys"`,
    );
    expect(truthful).toContain(
      `fields (${LINKAGE_RULE_SET_VERDICT_COPY.consistent.marker}): "baseline-pii"`,
    );
    // One caveat for two agreeing halves, rather than the same sentence twice.
    expect(
      truthful.split(LINKAGE_RULE_SET_VERDICT_COPY.consistent.note).length - 1,
    ).toBe(1);
    expect(truthful).not.toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note,
    );

    // The same citation over a REORDERED cascade: key order is cascade order, so
    // the reordered keys are provably not the set the citation names, while the
    // untouched fields still are. The halves are decided independently.
    const reordered = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        linkageKeys: [...base.linkageTerms.linkageKeys].reverse(),
      },
    });
    expect(reordered).toContain(
      `keys (${LINKAGE_RULE_SET_VERDICT_COPY.contradicted.marker}): "hmis-keys"`,
    );
    expect(reordered).toContain(
      `fields (${LINKAGE_RULE_SET_VERDICT_COPY.consistent.marker}): "baseline-pii"`,
    );
    expect(reordered).toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note,
    );
    expect(reordered).toContain(LINKAGE_RULE_SET_VERDICT_COPY.consistent.note);
    // Most severe first, so a reader who stops after one line has read the warning.
    expect(
      reordered.indexOf(LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note),
    ).toBeLessThan(
      reordered.indexOf(LINKAGE_RULE_SET_VERDICT_COPY.consistent.note),
    );

    // A name this build does not ship resolves to nothing, so nothing is compared:
    // unchecked, never contradicted, whatever the declared rules are.
    const foreign = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        linkageKeys: [...base.linkageTerms.linkageKeys].reverse(),
        linkageRuleSet: {
          fieldSet: { name: "county-pii", version: "3.1.0" },
          keySet: { name: "county-keys", version: "3.1.0" },
        },
      },
    });
    expect(foreign).toContain(
      `keys (${LINKAGE_RULE_SET_VERDICT_COPY.unchecked.marker}): "county-keys"`,
    );
    expect(foreign).toContain(
      `fields (${LINKAGE_RULE_SET_VERDICT_COPY.unchecked.marker}): "county-pii"`,
    );
    expect(foreign).toContain(LINKAGE_RULE_SET_VERDICT_COPY.unchecked.note);
    expect(foreign).not.toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note,
    );
  });

  test("displayInvitation: a disproved citation is repeated in the block above the prompt", () => {
    // The terms run well past a screen, so the decision block is where an operator
    // answering the prompt is looking. A citation this build resolved and disproved
    // is repeated there; the other two verdicts stay with the citation itself.
    const log = getLogger("accept-display-rule-set-decision-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const contradicted = {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        linkageKeys: [...base.linkageTerms.linkageKeys].reverse(),
      },
    };
    const rendered = renderDisplayInvitation(log, contradicted);
    // Three times on a prompting render: once beside the citation, and once in each
    // of the decision block's two printings (heading the terms, and again at the
    // prompt the terms have scrolled away from).
    expect(
      rendered.split(LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note).length -
        1,
    ).toBe(3);
    // The repeated block holds the citation whole -- both halves under their own
    // markers, each name behind a fixed first-party label -- so an operator reads
    // WHICH name is disproved. Only the disproved caveat is repeated with it.
    const decisionLines: string[] = [];
    logDecisionFacts(
      (line) => decisionLines.push(line),
      summarizeInvitation(contradicted),
      undefined,
    );
    const decision = decisionLines.join("\n");
    expect(decision).toContain(
      `keys (${LINKAGE_RULE_SET_VERDICT_COPY.contradicted.marker}): "hmis-keys"`,
    );
    expect(decision).toContain(
      `fields (${LINKAGE_RULE_SET_VERDICT_COPY.consistent.marker}): "baseline-pii"`,
    );
    expect(decision).toContain(LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note);
    expect(decision).not.toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.consistent.note,
    );

    const truthfulLines: string[] = [];
    logDecisionFacts(
      (line) => truthfulLines.push(line),
      summarizeInvitation(base),
      undefined,
    );
    expect(truthfulLines.join("\n")).not.toContain("linkage rule set");
  });

  test("displayInvitation: the received-columns marker follows what the invitation held, not what it declared", () => {
    // The same line has two sources and they do not rest on the same thing. The
    // held subset is the set an acceptance locks in and reconciles the received
    // payload against; an authored payload.send with no held subset locks in
    // nothing, so an inviter that declares one set and transmits another is not
    // stopped on the online run. Marking that case "enforced" would announce a check
    // that does not run, so the marker is keyed on what was held.
    const log = getLogger("accept-display-receive-basis-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    // One terms document for both renderings, authoring the columns the held
    // subset also names, so the only difference between the two is whether the token
    // holds the subset.
    const linkageTerms: LinkageTerms = {
      ...base.linkageTerms,
      payload: { send: [{ name: "diagnosis" }, { name: "notes" }] },
    };
    const authored = renderDisplayInvitation(log, { ...base, linkageTerms });
    const carried = renderDisplayInvitation(log, {
      ...base,
      linkageTerms,
      disclosedPayloadColumns: ["diagnosis", "notes"],
    });
    expect(authored).toContain(
      "columns you will receive (your partner's word, 2 declared):",
    );
    expect(authored).toContain("\n    - diagnosis");
    expect(authored).toContain("\n    - notes");
    expect(authored).not.toContain("columns you will receive (enforced,");
    expect(carried).toContain(
      "columns you will receive (enforced, 2 declared):",
    );
    expect(carried).not.toContain(
      "columns you will receive (your partner's word,",
    );
    // The marker is the whole of the difference: the same columns are listed either
    // way, so nothing else about the surface moves with the basis.
    expect(
      authored.replace(
        "columns you will receive (your partner's word, 2 declared)",
        "columns you will receive (enforced, 2 declared)",
      ),
    ).toBe(carried);
    // An authored EMPTY send is not a declaration at all -- it holds no subset and
    // prints no line -- so a rendered "(none)" is always the held, enforced case.
    expect(
      renderDisplayInvitation(log, {
        ...base,
        linkageTerms: { ...base.linkageTerms, payload: { send: [] } },
      }),
    ).not.toContain("columns you will receive");
  });

  test("displayInvitation: the inviter's request-from-acceptor receive shows names, '(none)' when empty, and nothing when absent", () => {
    // The opposite direction from "columns you will receive": the inviter's
    // payload.receive is what it requests FROM this party. A declared receive
    // (present, even if empty) is shown -- an empty one as "(none)", since it
    // strictly asserts this party sends nothing -- while an absent receive (lazy)
    // shows no line at all. CLI counterpart of the web "requests from you" line.
    const log = getLogger("accept-display-request-test");
    log.setLevel("silent");
    const lines = (token: InvitationToken): string =>
      renderDisplayInvitation(log, token);
    const base = sampleToken(FUTURE());
    const withReceive = (
      receive: { name: string }[] | undefined,
    ): InvitationToken => ({
      ...base,
      linkageTerms: { ...base.linkageTerms, payload: { receive } },
    });
    const named = lines(withReceive([{ name: "dose" }, { name: "outcome" }]));
    expect(named).toContain(
      "columns the inviting party requests from you " +
        "(your partner's word, 2 declared):",
    );
    expect(named).toContain("\n    - dose");
    expect(named).toContain("\n    - outcome");
    // The mirror of the line above, and bare for the same reason: only a declared
    // direction prints, so "(none)" is the inviter asking for no column rather than
    // the lazy case, which prints nothing.
    expect(lines(withReceive([])).split("\n")).toContain(
      "  columns the inviting party requests from you " +
        "(your partner's word, 0 declared): (none)",
    );
    expect(lines(withReceive(undefined))).not.toContain(
      "the inviting party requests from you",
    );
  });

  test("displayInvitation: bounds each declared payload list by count and states the remainder", () => {
    // Both declared directions hold partner free text at core's MAX_PAYLOAD_ENTRIES
    // ceiling, above what intake can deliver so the arithmetic is pinned at the schema
    // bound; what an invitation actually reaches through the 64 KiB decode cap is
    // roughly 346 names of this shape, some 93 KB of painted text and a thousand-odd
    // terminal rows between the operator and the consent decision below -- usability
    // denial rather than injection, the names being escaped.
    const log = getLogger("accept-display-declared-bound-test");
    log.setLevel("silent");

    // What THIS fixture may paint: a sample token's blocks with both declared payload
    // directions flooded, which is what the count bound governs. It is not a bound on
    // everything the prompt can render -- the linkage-key block, up to
    // MAX_LINKAGE_ENTRIES (256) keys of MAX_KEY_ELEMENTS (256) elements each through
    // the uncapped logList path, stays the larger partner-controlled render on this
    // surface and this fixture does not exercise it. An ABSOLUTE number, not derived
    // from MAX_DECLARED_NAMES_SHOWN: a ceiling that scaled with the cap
    // would hold at any cap, including none, which is the change this check exists to
    // catch. It leaves several thousand characters of headroom over what this fixture
    // measures today, so a copy edit elsewhere on the prompt does not trip it, and
    // stays far under what the same declaration paints uncapped -- the difference
    // between scrolling past the terms and never reaching the question.
    const PROMPT_CEILING = 20_000;

    const base = sampleToken(FUTURE());
    const send = floodedDeclaration("send");
    const receive = floodedDeclaration("receive");
    const rendered = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: { ...base.linkageTerms, payload: { send, receive } },
    });
    const lines = rendered.split("\n");
    const countLine = `    ${unshownDeclaredNamesLine(
      MAX_PAYLOAD_ENTRIES - MAX_DECLARED_NAMES_SHOWN,
    )}`;

    for (const heading of [
      declaredSendHeading(MAX_PAYLOAD_ENTRIES),
      declaredReceiveHeading(MAX_PAYLOAD_ENTRIES),
    ]) {
      // Per direction, not in total: each list holds its own cap, so one flooded
      // declaration cannot spend the other's allowance.
      const entries = entriesUnder(lines, heading);
      expect(entries).toHaveLength(MAX_DECLARED_NAMES_SHOWN);
      // The assumption, asserted rather than assumed: each painted name spends the whole
      // per-value allowance and is cut at it, so what is measured here is the worst
      // case and not a mild one.
      for (const entry of entries) {
        expect(entry.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
        expect(entry.length).toBeGreaterThan(DEFAULT_MAX_DISPLAY_LENGTH);
      }
      // Directly under the last painted name of this direction, stating this
      // direction's whole remainder, so a cut list cannot drop its tail silently.
      expect(lines[lines.indexOf(heading) + MAX_DECLARED_NAMES_SHOWN + 1]).toBe(
        countLine,
      );
    }
    // Once per bounded direction across the whole surface: neither block repeats the
    // sentence nor borrows the other's remainder.
    expect(lines.filter((line) => line === countLine)).toHaveLength(2);

    // What the same declaration would paint uncapped, measured rather than argued
    // from the constants: the bound is only worth pinning against the size it
    // replaces. That magnitude belongs to the schema ceiling this fixture drives, not
    // to anything an invitation delivers -- one holding it never decodes -- and the
    // reachable worst case the bound forecloses is the ~93 KB, a thousand-odd rows,
    // that the 64 KiB decode cap does leave room for.
    const uncappedSize = [...send, ...receive].reduce(
      (total, column) => total + sanitizeForDisplay(column.name).length,
      0,
    );
    expect(uncappedSize).toBeGreaterThan(1_000_000);
    expect(rendered.length).toBeLessThanOrEqual(PROMPT_CEILING);

    // A realistic declaration is a handful of columns, and paints entire with no
    // count line at all. Exactly at the cap as well as under it: the boundary is
    // where an off-by-one would cut a list it should have painted whole, or count a
    // remainder of nothing.
    for (const width of [
      MAX_DECLARED_NAMES_SHOWN - 1,
      MAX_DECLARED_NAMES_SHOWN,
    ]) {
      const columns = Array.from({ length: width }, (_, index) => ({
        name: `col${index}`,
      }));
      const whole = renderDisplayInvitation(log, {
        ...base,
        linkageTerms: {
          ...base.linkageTerms,
          payload: { send: columns, receive: columns },
        },
      });
      for (const heading of [
        declaredSendHeading(width),
        declaredReceiveHeading(width),
      ])
        expect(entriesUnder(whole.split("\n"), heading)).toEqual(
          columns.map((column) => column.name),
        );
      expect(whole).not.toContain("not shown here");
    }
  });

  test("displayInvitation: each declared direction's heading states its own declared total", () => {
    // Under the count bound the closing "and N more" line is the only magnitude a cut
    // list holds below it, and a padded declared name reproduces that row at a
    // matching terminal width (the stated limit on logDeclaredPayloadList). The
    // heading states the same magnitude from above the first painted name, where no
    // partner text precedes it, so the total is read before any of the declaration's
    // own bytes and corroborates what the count line says.
    const log = getLogger("accept-display-declared-total-test");
    log.setLevel("silent");
    // A different length per direction, both past the cap: a heading reading the
    // painted subset, or the other direction's set, disagrees with what is declared
    // here rather than matching by coincidence.
    const columns = (prefix: string, count: number): Array<{ name: string }> =>
      Array.from({ length: count }, (_, index) => ({
        name: `${prefix}${index}`,
      }));
    const send = columns("send", MAX_DECLARED_NAMES_SHOWN + 3);
    const receive = columns("receive", MAX_DECLARED_NAMES_SHOWN + 7);
    const base = sampleToken(FUTURE());
    const lines = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: { ...base.linkageTerms, payload: { send, receive } },
    }).split("\n");

    for (const [heading, declared] of [
      [declaredSendHeading(send.length), send],
      [declaredReceiveHeading(receive.length), receive],
    ] as const) {
      // Found by exact text, so the rendered heading states this direction's declared
      // length -- not the cap it painted, not the other direction's -- and holds
      // nothing the declaration supplied: an interpolated name would fail the match.
      const headingIndex = lines.indexOf(heading);
      expect(headingIndex).toBeGreaterThanOrEqual(0);
      expect(declared.length).toBeGreaterThan(MAX_DECLARED_NAMES_SHOWN);
      expect(lines[headingIndex + 1]).toBe(`    - ${declared[0].name}`);
      expect(entriesUnder(lines, heading)).toHaveLength(
        MAX_DECLARED_NAMES_SHOWN,
      );
      // Painted plus counted is what the heading states, so the two first-party
      // numbers can only disagree through a real defect.
      expect(lines[headingIndex + MAX_DECLARED_NAMES_SHOWN + 1]).toBe(
        `    ${unshownDeclaredNamesLine(
          declared.length - MAX_DECLARED_NAMES_SHOWN,
        )}`,
      );
    }
  });

  test("displayInvitation: a declared name displaying as the count line stays a list entry", () => {
    // sanitizeForDisplay passes printable ASCII verbatim, so a partner can declare a
    // column named exactly as the sentence closing its own bounded list. The bullet is
    // what tells them apart among the emitted lines, a line-oriented sink having no
    // container to place one inside and the other outside: a painted name always
    // has the bullet, and cannot break its own line to shed it, while the
    // first-party count line never does. What a terminal ROW shows is outside what
    // this asserts -- soft wrap can reproduce the bare count row from a padded name,
    // the stated limit on logDeclaredPayloadList.
    const log = getLogger("accept-display-count-line-impostor-test");
    log.setLevel("silent");
    const impostor = unshownDeclaredNamesLine(
      MAX_PAYLOAD_ENTRIES - MAX_DECLARED_NAMES_SHOWN,
    );
    const send = floodedDeclaration("send");
    send[0] = { name: impostor };
    const base = sampleToken(FUTURE());
    const lines = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: { ...base.linkageTerms, payload: { send } },
    }).split("\n");

    expect(
      entriesUnder(lines, declaredSendHeading(MAX_PAYLOAD_ENTRIES))[0],
    ).toBe(impostor);
    expect(lines.filter((line) => line === `    - ${impostor}`)).toHaveLength(
      1,
    );
    expect(lines.filter((line) => line === `    ${impostor}`)).toHaveLength(1);
  });

  test("displayInvitation: shows the acceptor's own outbound send, one column per line", () => {
    // The columns THIS party will disclose to the partner for matched records -- its
    // own outbound disclosure. A non-empty set is shown one column per line (so a name
    // containing the list separator is not misread as two entries), leading the
    // details before the inviter's proposed terms.
    const log = getLogger("accept-display-outbound-test");
    log.setLevel("silent");
    const joined = renderDisplayInvitation(log, sampleToken(FUTURE()), [
      "diagnosis",
      "medication",
    ]);
    const lines = joined.split("\n");
    // The heading is present and the columns appear one per line, before the
    // inviter's "columns you will receive"/"linkage keys" terms.
    const headingIndex = lines.findIndex((l) =>
      l.includes(`${OUTBOUND_SEND_LABEL}:`),
    );
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(lines).toContain("    - diagnosis");
    expect(lines).toContain("    - medication");
    // No presupposing empty/unknown phrasing when the set is a real non-empty
    // disclosure.
    expect(joined).not.toContain("(none)");
    expect(joined).not.toContain("not yet known");
  });

  test("displayInvitation: a column name containing the list separator is not split into two entries", () => {
    // sanitizeForDisplay does not escape a printable ASCII comma, so a joined list
    // would misread a single column named "last, first" as two columns. Rendering one
    // per line keeps it a single entry.
    const log = getLogger("accept-display-outbound-comma-test");
    log.setLevel("silent");
    const lines = renderDisplayInvitation(log, sampleToken(FUTURE()), [
      "last, first",
      "notes",
    ]).split("\n");
    // The comma-bearing name is one entry on its own line, not split at the comma,
    // and the separator did not create a third entry.
    expect(outboundSendEntries(lines)).toEqual(["last, first", "notes"]);
  });

  test("displayInvitation: the empty and not-yet-known outbound-send cases avoid a presupposing phrase", () => {
    // Empty (the acceptor discloses nothing) and not-yet-known (no metadata resolved
    // at prompt time) must both stay truthful: neither asserts a definite non-empty
    // outbound send.
    const log = getLogger("accept-display-outbound-empty-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    // Empty: a real "you disclose nothing", shown as a truthful (none) line, not a
    // list and not a forward-reference.
    const empty = renderDisplayInvitation(log, base, []);
    expect(empty).toContain(
      `${OUTBOUND_SEND_LABEL}: (none) -- only matched records`,
    );
    expect(outboundSendEntries(empty.split("\n"))).toEqual([]);
    // Not-yet-known: no metadata at prompt time, so the line says the set is not
    // known rather than claiming any count -- and names what actually determines it,
    // including the confirmation the run stops for and the refusal an unattended run
    // gets instead. The forward reference is only accurate while that checkpoint
    // exists, so it is pinned here beside the acceptance that records it as pending.
    const unknown = renderDisplayInvitation(log, base, undefined);
    expect(unknown).toContain(`${OUTBOUND_SEND_LABEL}: not yet known`);
    expect(unknown).toContain(
      "    Determined from your input file when the exchange runs, which shows " +
        "the columns and asks you to confirm them before anything is sent; a run " +
        "with no terminal to ask on refuses instead of sending them.",
    );
    expect(unknown).not.toContain("(none)");
    expect(outboundSendEntries(unknown.split("\n"))).toEqual([]);
  });

  test("displayInvitation: an inviting party that receives no result is sent nothing, whatever the acceptor's own set is", () => {
    // The payload step transmits nothing at all to a partner not entitled to the
    // result, so a listed column set would name a disclosure that does not happen --
    // under the marker that says the run holds it. The direction answers the line for
    // every value of the acceptor's own set: a resolved set is not listed, the
    // not-yet-known forward reference does not run (the input file it names cannot
    // change this answer), and the empty case's "only matched records" tail gives way
    // to the reason that holds however the operator's file changes.
    const log = getLogger("accept-display-outbound-one-sided-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const oneSided: InvitationToken = {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        output: { expectsOutput: false, shareWithPartner: true },
      },
    };
    for (const own of [["diagnosis", "medication"], [], undefined]) {
      const rendered = renderDisplayInvitation(log, oneSided, own);
      expect(rendered.split("\n")).toContain(
        `  ${OUTBOUND_SEND_LABEL}: (none) -- the inviting party receives no ` +
          "result, so no payload is sent",
      );
      expect(outboundSendEntries(rendered.split("\n"))).toEqual([]);
      expect(rendered).not.toContain("diagnosis");
      expect(rendered).not.toContain("only matched records");
      expect(rendered).not.toContain("not yet known");
    }
    // The direction is the whole of the gate: the same acceptor set is listed in full
    // when the inviting party does receive the result.
    const twoSided = renderDisplayInvitation(log, base, [
      "diagnosis",
      "medication",
    ]);
    expect(outboundSendEntries(twoSided.split("\n"))).toEqual([
      "diagnosis",
      "medication",
    ]);
  });

  test("displayInvitation: shows the linkage strategy and, for single-pass, the disclosure note", () => {
    const log = getLogger("accept-display-strategy-test");
    log.setLevel("silent");
    const lines = (token: InvitationToken): string =>
      renderDisplayInvitation(log, token);
    const base = sampleToken(FUTURE());
    // The default (cascade) is shown plainly, with no disclosure note.
    const cascade = lines(base);
    expect(cascade).toContain("linkage strategy (enforced): cascade");
    expect(cascade).not.toContain("consented disclosure tradeoff");
    // single-pass is the disclosure-affecting choice the acceptor consents to, so
    // it holds the shared tradeoff note (with the operator-facing doc pointer).
    const singlePass = lines({
      ...base,
      linkageTerms: { ...base.linkageTerms, linkageStrategy: "single-pass" },
    });
    expect(singlePass).toContain("linkage strategy (enforced): single-pass");
    expect(singlePass).toContain("consented disclosure tradeoff");
    expect(singlePass).toContain("docs/EXCHANGE_REFERENCE.md");
  });

  test("displayInvitation: states what a splitting key does, in the register its strategy puts it in", () => {
    // A key element that splits its value is matched on each candidate, which is
    // both a widening and a disclosure -- and under a combination that matches
    // one value per record it is a refusal instead. The sentence for each case
    // comes from core's shared classification, so this prompt and the web consent
    // screen state the consequence in the same words rather than two accounts of
    // it.
    const log = getLogger("accept-display-fan-out-test");
    log.setLevel("silent");

    for (const linkageStrategy of ["cascade", "single-pass"] as const) {
      const matched = renderDisplayInvitation(
        log,
        splittingKeyToken(FUTURE(), linkageStrategy),
      );
      expect(matched).toContain("several values per record (enforced):");
      expect(matched).toContain(CONSENT_FACTS.fanOutCandidates.note);
      expect(matched).toContain("(multiple)");
    }

    const refused = renderDisplayInvitation(
      log,
      splittingKeyToken(FUTURE(), "cascade", "psi-c"),
    );
    expect(refused).toContain("several values per record (enforced):");
    expect(refused).toContain(CONSENT_FACTS.fanOutRefused.note);
    expect(refused).toContain("(not supported)");

    // Silent for terms that declare no split, so the line is not a fixture of the
    // prompt itself.
    expect(renderDisplayInvitation(log, sampleToken(FUTURE()))).not.toContain(
      "several values per record",
    );
  });

  test("displayInvitation: states what a splitting key pairs where the invitation declares duplicate matching", () => {
    // A splitting key beside an inviting party's own `deduplicate`: the pair an
    // accepting party's own value completes runs under either strategy, and a
    // record matched on a candidate is paired with every partner record its
    // candidates reached rather than once. The prompt states that before the
    // acceptor sets its own side in its configuration file.
    const log = getLogger("accept-display-fan-out-deduplicate-test");
    log.setLevel("silent");
    const token = splittingKeyToken(FUTURE(), "cascade");
    const rendered = renderDisplayInvitation(log, {
      ...token,
      linkageTerms: { ...token.linkageTerms, deduplicate: true },
    });
    expect(rendered).toContain("several values per record (enforced):");
    expect(rendered).toContain(
      "with both set it is paired with every one of the other party's " +
        "records any of its candidates reached",
    );
    expect(rendered).not.toContain("paired at most once and is then left out");
  });

  test("displayInvitation: states the grouping a candidate set makes, whichever declares it", () => {
    // The grouping the pair this party's own `deduplicate` completes makes of
    // records no linkage key links. It follows the candidate set rather than
    // the splitting element alone: the shipped default keys declare a swapped
    // order and no split, so a prompt reading the fan-out register alone would
    // say nothing on the terms an operator reaches with no key authoring.
    const log = getLogger("accept-display-chained-grouping-test");
    log.setLevel("silent");
    const deduplicating = (token: InvitationToken): string =>
      renderDisplayInvitation(log, {
        ...token,
        linkageTerms: { ...token.linkageTerms, deduplicate: true },
      });

    const defaults = deduplicating(sampleToken(FUTURE()));
    expect(defaults).not.toContain("several values per record");
    expect(defaults).toContain(
      "records grouped with no value in common (enforced):",
    );
    expect(defaults).toContain(CONSENT_FACTS.candidateSetChainsGrouping.note);

    expect(deduplicating(splittingKeyToken(FUTURE(), "cascade"))).toContain(
      CONSENT_FACTS.candidateSetChainsGrouping.note,
    );

    // Stated under either linkage strategy, both of which pair the grouping.
    expect(deduplicating(splittingKeyToken(FUTURE(), "single-pass"))).toContain(
      CONSENT_FACTS.candidateSetChainsGrouping.note,
    );

    // Silent where these terms declare no side of the pair at all.
    expect(renderDisplayInvitation(log, sampleToken(FUTURE()))).not.toContain(
      "records grouped with no value in common",
    );
  });

  test("displayInvitation: withholds the chained grouping where this party receives no result", () => {
    // The invitation keeps the result, so the accepting party mirrors to no
    // entitlement and the accept takes no `deduplicate` from it -- on the
    // shipped default keys, which declare a candidate set, and with the
    // inviting party's own side declared. The grouping this states rests on a
    // pair the reader can never complete, so the prompt states the terms'
    // own side and stops there.
    const log = getLogger("accept-display-chained-grouping-sole-receiver-test");
    log.setLevel("silent");
    const token = sampleToken(FUTURE());
    const rendered = renderDisplayInvitation(log, {
      ...token,
      linkageTerms: {
        ...token.linkageTerms,
        deduplicate: true,
        output: { expectsOutput: true, shareWithPartner: false },
      },
    });
    expect(rendered).toContain("duplicate matches");
    expect(rendered).not.toContain("records grouped with no value in common");
    expect(rendered).not.toContain(
      CONSENT_FACTS.candidateSetChainsGrouping.note,
    );
  });

  test("displayInvitation: represents every consent-relevant linkage term, bar the recorded gaps", () => {
    // Which terms an acceptor's consent turns on is judged once, in core's shared
    // classification, so this prompt and the web consent summary cannot drift on
    // the answer. A term is represented here when two sets of terms differing at
    // that term alone print differently; one the prompt omits prints identically
    // and has to be recorded as a gap in that same classification.
    const log = getLogger("accept-display-coverage-test");
    log.setLevel("silent");
    // One token, reused across every rendering, so only the terms move -- minting
    // a fresh one per render would vary the displayed `expires` too. Its
    // `disclosedPayloadColumns` is left absent: it is a token field
    // the inviter derives from its own metadata, not a linkage term, and supplying
    // one would answer the question about it rather than about `payload.send`. The
    // acceptor's own outbound-send set is held at the not-yet-known case for the
    // same reason.
    const token = sampleToken(FUTURE());
    const render = (linkageTerms: LinkageTerms): string =>
      renderDisplayInvitation(log, { ...token, linkageTerms });

    // The shapes that name the accepting party's own `deduplicate` are not
    // measured here: this prompt offers no control over that value, so the
    // accept it describes derives that party's side as false and the pair such
    // a shape states is one it never runs. Held non-vacuous both ways below.
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
        .filter((probe) => probe.unrepresented.cli !== undefined)
        .map((probe) => probe.path)
        .sort(),
    );

    // A term whose variant turns on a disclosure holds the sentence stating it in
    // the classification, and both surfaces are held to that one string: moving the
    // output is not enough where an acceptor is entitled to read what the setting
    // costs. Asserted absent from the base too, so the pin measures the setting
    // rather than a sentence the prompt always prints.
    const pinned = probes.filter(
      (probe) =>
        probe.requiredVariantCopy !== undefined &&
        probe.unrepresented.cli === undefined,
    );
    expect(pinned.length).toBeGreaterThan(0);
    for (const probe of pinned) {
      // Per probe, not only over the set: an entry holding an empty list would
      // otherwise satisfy the loop below by rendering nothing at all.
      const copies = probe.requiredVariantCopy ?? [];
      expect(copies.length, probe.label).toBeGreaterThan(0);
      for (const copy of copies) {
        expect(render(probe.variant), probe.label).toContain(copy);
        expect(render(probe.base), probe.label).not.toContain(copy);
      }
      // And the other half of a term measured under several document shapes: the
      // sentence another shape owes must be absent here, or one sentence rendered
      // for every shape would satisfy the pin above while stating a disclosure this
      // shape's run does not make.
      for (const copy of probe.forbiddenVariantCopy ?? [])
        expect(render(probe.variant), probe.label).not.toContain(copy);
    }
    // Non-vacuous: at least one term is measured under shapes that owe different
    // sentences, so the loop above is a check rather than an empty pass.
    expect(
      pinned.filter((probe) => (probe.forbiddenVariantCopy ?? []).length > 0)
        .length,
    ).toBeGreaterThan(0);
  });

  test("displayInvitation: shows each matching rule the acceptor is consenting to", () => {
    // The representation check above proves each term MOVES the output; these pin
    // what it actually says, so a term cannot satisfy that check while displaying as
    // something else. The probe terms hold one of everything: a parameterized
    // transform, a fuzzy comparison, a swap, field constraints, a payload in both
    // directions, and a legal agreement.
    const log = getLogger("accept-display-rules-test");
    log.setLevel("silent");
    const out = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: CONSENT_PROBE_TERMS,
    });

    expect(out).toContain("    - given name, family name, and date of birth");
    // The elements the key combines, each under its declared semantic type -- the
    // partner-authored field name is not shown.
    expect(out).toContain("        - First name");
    expect(out).toContain("        - Last name");
    expect(out).toContain("        - Date of birth");
    // A transform with its plain-language consequence and every declared parameter.
    expect(out).toContain("          transform: to_upper_case");
    expect(out).toContain("          transform: substring");
    expect(out).toContain("            - start: 1");
    expect(out).toContain("            - length: 3");
    // The fuzzy-comparison expansion, unqualified: the run applies it, so the
    // prompt states the looser match it performs rather than marking it as one
    // the exchange refuses.
    expect(out).toContain(
      "          also matches approximate variants (adjacent years)\n",
    );
    expect(out).not.toContain(PROPOSED_NOT_APPLIED_NOTES.fuzzyComparisons);
    // The swap the two elements are matched under, unqualified for the same
    // reason: the run builds the key in both orders.
    expect(out).toContain(
      "      swap: First name and Last name may be matched in either order\n",
    );
    expect(out).not.toContain(PROPOSED_NOT_APPLIED_NOTES.swappedKeyOrder);
    // The per-field data standards, under a heading marking them as the inviter's
    // own undertaking rather than rules the exchange applies, with the
    // partner-authored character class shown raw after a fixed first-party label
    // rather than paraphrased as a vetted allow-list.
    expect(out).toContain(
      "      declared data standards (your partner's word):",
    );
    expect(out).toContain("        - honorifics and suffixes removed");
    expect(out).toContain("        - 1 excluded value");
    expect(out).toContain("        - values must be valid");
    expect(out).toContain("        - allowed characters: A-Za-z");
    // The unverified note comes before the first partner-supplied class it
    // qualifies, so no class is read as if it were checked.
    const renderedLines = out.split("\n");
    const noteLine = renderedLines.indexOf(
      `    ${CONSENT_FACTS.allowedCharacterPatterns.note}`,
    );
    const classLine = renderedLines.indexOf(
      "        - allowed characters: A-Za-z",
    );
    expect(noteLine).toBeGreaterThanOrEqual(0);
    expect(noteLine).toBeLessThan(classLine);
    // Both payload directions, and the attached agreement.
    expect(out).toContain("    - risk_score");
    expect(out).toContain("    - program_outcome");
    expect(out).toContain("    reference: MOU-2026-0001");
    expect(out).toContain(
      "    stated purpose: Evaluation of the county tutoring program",
    );
    expect(out).toContain("    agreement valid through: 2027-12-31");
  });

  test("displayInvitation: a count-only invitation marks the swap it will refuse", () => {
    // A swapped key order is a candidate set, which a count-only round refuses,
    // so the note stating an either-order match is qualified where it stands
    // rather than left reading as behavior the run performs. The expansion on
    // the same terms is marked for the same reason, so the two producers a
    // reader meets in the key detail are marked together.
    //
    // The count-only probe holds a key declaring neither, since a psi-c
    // document declaring one is refused where it is decoded, so the shape this
    // marking is for is composed here from the shared base's key -- the same
    // composition the web screen's pin uses, so the two surfaces are measured
    // on one input.
    const log = getLogger("accept-display-count-only-swap-test");
    log.setLevel("silent");
    const out = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: {
        ...COUNT_ONLY_PROBE_TERMS,
        linkageKeys: CONSENT_PROBE_TERMS.linkageKeys,
      },
    });
    expect(out).toContain(
      "      swap: First name and Last name may be matched in either order " +
        PROPOSED_NOT_APPLIED_NOTES.swappedKeyOrder,
    );
    expect(out).toContain(PROPOSED_NOT_APPLIED_NOTES.fuzzyComparisons);
    // The always-visible header line degrades the same way a refused fan-out
    // element's header marker does, rather than asserting the either-order
    // match a count-only round refuses.
    expect(out).toContain(
      "      matches on: first name (partial) - last name (partial) - " +
        "date of birth (fuzzy) (either order not supported)",
    );
    expect(out).not.toContain("(matched in either order)");
  });

  test("displayInvitation: a deduplicating term states what it discloses and whose records pay it", () => {
    // The run honors deduplicate, so the line is a plain fact -- and a deduplicating
    // match discloses grouping a one-to-one match does not, which the acceptor is
    // consenting to. The statement is shared wording, printed under the headline it
    // qualifies rather than one block away. The direction note sits with it at the
    // same level: the setting is the inviting party's own, this party's own side
    // being derived as false at accept.
    const log = getLogger("accept-display-deduplicate-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const render = (overrides: Partial<LinkageTerms>): string =>
      renderDisplayInvitation(log, {
        ...base,
        linkageTerms: { ...base.linkageTerms, ...overrides },
      });

    const oneToOne = render({});
    expect(oneToOne).toContain(
      "duplicate matches (enforced): each of the inviting party's records " +
        "matches at most one of the accepting party's records",
    );
    // A one-to-one exchange discloses no grouping at all, so neither sentence must
    // reach it: their presence below is the setting's doing rather than the
    // fixture's.
    expect(oneToOne).not.toContain(
      DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
    );
    expect(oneToOne).not.toContain(
      DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
    );
    expect(oneToOne).not.toContain(DEDUPLICATE_ACCEPTOR_SIDE_NOTE);

    const deduplicating = render({ deduplicate: true });
    expect(deduplicating).toContain(
      "duplicate matches (enforced): more than one of the inviting party's " +
        "records may match a single one of the accepting party's records",
    );
    expect(deduplicating).toContain(
      `    ${DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT}`,
    );
    // Same indent as the statement it follows, so the acceptor reads what the
    // setting discloses and whose file is grouped to disclose it in one place
    // rather than a screen apart.
    expect(deduplicating).toContain(`    ${DEDUPLICATE_ACCEPTOR_SIDE_NOTE}`);
    // The sample token shares the result with this party, so the sole-receiver
    // sentence must not reach it -- nor the display limit that qualifies it, since
    // this party IS presented the grouping here.
    expect(deduplicating).not.toContain(
      DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
    );
    expect(deduplicating).not.toContain(
      CONSENT_FACTS.duplicateGroupingDisplayLimit.note,
    );
  });

  test("displayInvitation: a sole-receiver deduplicating term states Alcove presents the acceptor no grouping when the inviter alone receives", () => {
    // The other output shape a deduplicating invitation can take: the inviting
    // party receives the result and shares none of it, so this party is sent no
    // table and is presented no grouping. The shared-result sentence would tell it
    // what it learns about the inviting party's groups, which this client shows it
    // not at all -- so the shape selects the other statement, and the direction
    // note stays, its widening applying to either shape.
    const log = getLogger("accept-display-deduplicate-sole-receiver-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const soleReceiver = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        deduplicate: true,
        output: { expectsOutput: true, shareWithPartner: false },
      },
    });

    expect(soleReceiver).toContain(
      `    ${DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT}`,
    );
    // The limit on that withholding is its own classified fact, rendered from the
    // shared table at the same level as the statement it qualifies: what the
    // statement says Alcove presents, this says the rounds still hold.
    expect(soleReceiver).toContain(
      `    ${CONSENT_FACTS.duplicateGroupingDisplayLimit.note}`,
    );
    expect(CONSENT_FACTS.duplicateGroupingDisplayLimit.basis).toBe(
      "trust-contingent",
    );
    // The cascade this token names brings the grouping to this party's own
    // process, so the enforced sentence must not stand in for the one above.
    expect(soleReceiver).not.toContain(
      CONSENT_FACTS.duplicateGroupingWithheld.note,
    );
    expect(soleReceiver).toContain(`    ${DEDUPLICATE_ACCEPTOR_SIDE_NOTE}`);
    expect(soleReceiver).not.toContain(
      DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
    );
  });

  test("displayInvitation: a sole-receiver deduplicating term states the exchange's own non-receipt where the run withholds the table", () => {
    // The third shape a deduplicating invitation takes: the sole-receiver
    // output under single-pass with no column requested of this party, which
    // is the one combination the exchange closes itself rather than this
    // client choosing not to show it. The prompt reads which of the two
    // sentences that is from core's resolution of the run, so the register an
    // acceptor is told stays the register the run actually holds.
    const log = getLogger("accept-display-deduplicate-table-withheld-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const withheld = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        deduplicate: true,
        linkageStrategy: "single-pass",
        output: { expectsOutput: true, shareWithPartner: false },
        payload: { send: [], receive: [] },
      },
    });

    expect(withheld).toContain(
      `    ${DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT}`,
    );
    expect(withheld).toContain(
      `    ${CONSENT_FACTS.duplicateGroupingWithheld.note}`,
    );
    expect(CONSENT_FACTS.duplicateGroupingWithheld.basis).toBe("enforced");
    // And the display-scoped sentence stays off a run whose wire holds the
    // withholding: it would tell this party that other software on its own
    // side could show it what the exchange never sends.
    expect(withheld).not.toContain(
      CONSENT_FACTS.duplicateGroupingDisplayLimit.note,
    );
    expect(withheld).toContain(`    ${DEDUPLICATE_ACCEPTOR_SIDE_NOTE}`);
    expect(withheld).not.toContain(
      DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
    );
  });

  test("displayInvitation: a deduplicating term states its disclosure under single-pass too", () => {
    // The renderer withholds what a deduplicating run discloses when the strategy
    // matches no deduplicating cardinality, since stating it would describe a run
    // that cannot happen -- and it reads that verdict from core rather than from
    // the strategy's name, so an invitation on the other strategy states the same
    // disclosure the cascade one does. That the withholding still follows a `false`
    // verdict is driven over the whole verdict table in core's
    // invitationSummary.test.ts, which can flip one.
    const log = getLogger("accept-display-deduplicate-single-pass-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const singlePass = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        deduplicate: true,
        linkageStrategy: "single-pass",
      },
    });

    expect(singlePass).toContain(
      "duplicate matches (enforced): more than one of the inviting party's " +
        "records may match a single one of the accepting party's records",
    );
    expect(singlePass).toContain(
      `    ${DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT}`,
    );
    expect(singlePass).toContain(`    ${DEDUPLICATE_ACCEPTOR_SIDE_NOTE}`);
  });

  test("displayInvitation: the retain line is printed at both decision blocks, its caveat once, and neither where retention is undisclosed", () => {
    const log = getLogger("accept-display-retain-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const RETAIN_LABEL = "  exchange files (enforced): ";

    // The declaration is a decision fact: what outlives the run is exactly what an
    // operator must have in front of them when the y/N question is asked, and the
    // terms are far longer than a screen, so it prints at BOTH decision blocks --
    // heading the terms and again above the prompt -- like every other fact there.
    const retaining = renderDisplayInvitation(log, {
      ...base,
      inviterRetainsFiles: true,
    });
    const lines = retaining.split("\n");
    const retainAt = lines
      .map((line, index) => (line.startsWith(RETAIN_LABEL) ? index : -1))
      .filter((index) => index >= 0);
    expect(retainAt).toHaveLength(2);
    for (const index of retainAt)
      expect(lines[index]).toBe(
        `${RETAIN_LABEL}kept as a permanent transcript, not deleted after the run`,
      );

    // The caveat is the half the run does not hold, and it is printed ONCE, in the
    // outline, rather than at both printings of the block: ten wrapped lines twice
    // over is what pushes the outbound-send list -- the first line of the block, and
    // the acceptor's hardest-to-undo consent -- off a short terminal at the prompt.
    // No shortened wording stands in for it in the block, since an abridgement is a
    // second account of the fact this shape exists to keep to one.
    const noteLine = `    ${CONSENT_FACTS.retainedFiles.note}`;
    expect(lines.filter((line) => line === noteLine)).toHaveLength(1);
    // Directly under the line it explains. The block emits the retain line last for
    // this: a caveat printed after whatever else the block reached would be treated
    // as that line's instead, and the contradicted-citation lines can be there.
    expect(lines[retainAt[0] + 1]).toBe(noteLine);
    // And nothing of it reaches the repetition, whose whole point here is its
    // length: the tail from the heading down is the block alone.
    expect(lines.slice(lines.indexOf(REPEAT_HEADING))).not.toContain(noteLine);

    // Neither absence renders anything, and the two are not alike by accident: an
    // invitation minted before the field existed made no claim, and one declaring
    // delete mode is claiming a cleanup this transport does not promise (a run
    // killed outright, or one failing after the handshake, leaves files in either
    // mode). Both would mislead as a stated fact, so both print nothing.
    for (const declaration of [{}, { inviterRetainsFiles: false }]) {
      const rendered = renderDisplayInvitation(log, {
        ...base,
        ...declaration,
      });
      expect(rendered).not.toContain("exchange files");
      expect(rendered).not.toContain(CONSENT_FACTS.retainedFiles.note);
    }
  });

  test("displayInvitation: a webrtc endpoint's relay is named before consent, escaped, and nothing is said without one", () => {
    const log = getLogger("accept-display-relay-test");
    log.setLevel("silent");
    const relayEndpoint: ConnectionEndpoint = {
      channel: "webrtc",
      host: "peer.example.org",
      relay: {
        turn: ["turns:relay.example.org:443?transport=tcp"],
        stun: ["stun:relay.example.org\u001b[31m:3478"],
      },
    };
    const lines = renderDisplayInvitation(
      log,
      sampleToken(FUTURE(), relayEndpoint),
    ).split("\n");
    const heading = lines.indexOf("  relay your partner named (enforced):");
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(lines.slice(heading + 1, heading + 4)).toEqual([
      "    TURN turns:relay.example.org:443?transport=tcp",
      "    STUN stun:relay.example.org\\x1b[31m:3478",
      `    ${CONSENT_FACTS.invitationRelay.note}`,
    ]);
    expect(heading).toBeLessThan(lines.indexOf(REPEAT_HEADING));

    const without = renderDisplayInvitation(
      log,
      sampleToken(FUTURE(), { channel: "webrtc", host: "peer.example.org" }),
    );
    expect(without).not.toContain("relay your partner named");
    expect(without).not.toContain(CONSENT_FACTS.invitationRelay.note);
  });

  test("displayInvitation: a split-directory endpoint states the retention with no declaration", () => {
    // The seeded sub-case: this accept builds its connection from the endpoint and
    // is put in retain mode by its shape (a split pair cannot be configured
    // without it), so a prompt gated on the declaration alone would take consent to
    // a permanent transcript in silence. Both the seeding and this line read
    // core's endpointRequiresRetainedFiles, so the endpoint that seeds the mode is
    // the endpoint that states it.
    const log = getLogger("accept-display-retain-endpoint-test");
    log.setLevel("silent");
    const split: ConnectionEndpoint = {
      channel: "filedrop",
      inboundPath: "/mnt/share/in",
      outboundPath: "/mnt/share/out",
    };
    const rendered = renderDisplayInvitation(log, sampleToken(FUTURE(), split));
    expect(rendered).toContain(
      "  exchange files (enforced): kept as a permanent transcript, not deleted " +
        "after the run",
    );
    expect(rendered).toContain(`    ${CONSENT_FACTS.retainedFiles.note}`);

    // And the shape test does not widen to "holds an endpoint": a single shared
    // directory seeds no options, and its acceptor sets its own mode, so an
    // invitation naming one and declaring nothing states nothing here.
    const shared: ConnectionEndpoint = {
      channel: "filedrop",
      path: "/mnt/share",
    };
    const sharedRendered = renderDisplayInvitation(
      log,
      sampleToken(FUTURE(), shared),
    );
    expect(sharedRendered).not.toContain("exchange files");
    expect(sharedRendered).not.toContain(CONSENT_FACTS.retainedFiles.note);
  });

  test("displayInvitation: every classified fact is marked, and holds core's caveat verbatim", () => {
    // An acceptor meets two unlike kinds of fact here: ones the exchange holds
    // itself, and ones that are only what the inviting party declared. Treating a
    // cooperative undertaking as a cryptographic guarantee is the error this
    // marking exists to prevent, so an enforced line is marked positively rather
    // than told apart by the absence of a marker on the other.
    const log = getLogger("accept-display-basis-test");
    log.setLevel("silent");
    const render = (output: LinkageTerms["output"], receive: boolean): string =>
      renderDisplayInvitation(log, {
        ...sampleToken(FUTURE()),
        linkageTerms: {
          ...CONSENT_PROBE_TERMS,
          output,
          // A party that receives no output may request no payload columns, so the
          // request is dropped alongside expectsOutput rather than left to fail the
          // schema.
          payload: receive
            ? CONSENT_PROBE_TERMS.payload
            : { ...CONSENT_PROBE_TERMS.payload, receive: [] },
        },
      });
    // Between them these two raise every caveat the shared table holds: this
    // party receives nothing while the inviter does, then the reverse.
    const acceptorWithheld = render(
      { expectsOutput: true, shareWithPartner: false },
      true,
    );
    const inviterWithheld = render(
      { expectsOutput: false, shareWithPartner: true },
      false,
    );
    // The count-only tier is the third rendering, because its caveats are the ones no
    // `psi` invitation raises: a table entry the renderer never reaches is exactly
    // what this test exists to catch, so the tier has to be rendered here rather than
    // exempted from the sweep.
    //
    // The retain declaration is the fourth, and for the same reason one step further
    // out: it is held on the TOKEN rather than in the terms, so no variation of
    // `output`, `payload`, or `algorithm` above can raise its caveat.
    const retaining = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      inviterRetainsFiles: true,
    });
    // The fan-out pair is the fifth and sixth, for the same reason again: both are
    // raised by a linkage key that splits its element's value, and which of the two
    // follows the algorithm and the strategy together, so no variation above
    // reaches either.
    const fanOutMatched = renderDisplayInvitation(
      log,
      splittingKeyToken(FUTURE(), "single-pass"),
    );
    const fanOutRefused = renderDisplayInvitation(
      log,
      splittingKeyToken(FUTURE(), "cascade", "psi-c"),
    );
    // The sole receiver's display limit is the seventh, for the reason the pair
    // above is a pair: it is raised only by a DEDUPLICATING invitation whose
    // inviting party receives the result alone, and no variation above declares
    // the term at all.
    const deduplicatingSoleReceiver = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: {
        ...CONSENT_PROBE_TERMS,
        deduplicate: true,
        output: { expectsOutput: true, shareWithPartner: false },
        payload: { ...CONSENT_PROBE_TERMS.payload, receive: [] },
      },
    });
    // And its enforced counterpart is the eighth: the same sole-receiver shape
    // on the one combination the exchange closes itself, which the seventh's
    // cascade cannot reach.
    const deduplicatingTableWithheld = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: {
        ...CONSENT_PROBE_TERMS,
        deduplicate: true,
        linkageStrategy: "single-pass",
        output: { expectsOutput: true, shareWithPartner: false },
        payload: { send: [], receive: [] },
      },
    });
    // The own-membership pair's enforced half is the ninth: the same one-sided
    // shape as the second rendering, on the combination that leaves the inviting
    // party blind at the wire. Neither the strategy nor the declared-empty send
    // it takes is reachable by any variation of `output` above.
    const inviterLearnsNoMembership = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: {
        ...CONSENT_PROBE_TERMS,
        linkageStrategy: "single-pass",
        output: { expectsOutput: false, shareWithPartner: true },
        payload: { send: [], receive: [] },
      },
    });
    // The chained grouping is the tenth, and the sole-receiver shape is what
    // puts it out of reach of the seventh and eighth: the sentence rests on a
    // pair the accept takes from the ACCEPTING party, which an invitation
    // keeping the result leaves that party no side of. The probe's own key
    // declares the candidate set the grouping needs.
    const deduplicatingSharedResult = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: { ...CONSENT_PROBE_TERMS, deduplicate: true },
    });
    // The named relay is the eleventh: like the retain declaration it is held
    // on the token rather than in the terms, on the endpoint this time.
    const namingRelay = renderDisplayInvitation(
      log,
      sampleToken(FUTURE(), {
        channel: "webrtc",
        host: "peer.example.org",
        relay: { turn: ["turns:relay.example.org:443"] },
      }),
    );
    const rendered = [
      acceptorWithheld,
      inviterWithheld,
      renderCountOnlyFacts(),
      retaining,
      fanOutMatched,
      fanOutRefused,
      deduplicatingSoleReceiver,
      deduplicatingTableWithheld,
      inviterLearnsNoMembership,
      deduplicatingSharedResult,
      namingRelay,
    ].join("\n");

    // The whole table, rather than a list restated here: a caveat this renderer
    // authored for itself instead of reading is absent from the rendering and fails,
    // and one the web reworded on its own side fails there for the same reason.
    // Bar the facts core marks as reachable from another seat only: the ones a
    // seat where the ACCEPTING party declares a grouping of its own can state,
    // which this prompt offers no control over, and the ones a party reading
    // terms it wrote itself states on a basis an acceptance does not hold.
    // Both sets are core's judgment, not this test's, so the seats that do
    // render them are held to the same lists.
    const elsewhere: ReadonlyArray<string> = [
      ...ACCEPTOR_DEDUPLICATE_CONTROL_FACTS,
      ...SELF_AUTHORED_EXCHANGE_FACTS,
    ];
    const classified: Array<ConsentFact> = Object.entries(CONSENT_FACTS)
      .filter(([id]) => !elsewhere.includes(id))
      .map(([, fact]) => fact);
    expect(classified.length).toBeLessThan(Object.keys(CONSENT_FACTS).length);
    const notes = classified
      .map((fact) => fact.note)
      .filter((note) => note !== undefined);
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) expect(rendered).toContain(`\n    ${note}`);

    // Both classes marked, on the pair whose difference in register is the whole
    // reason for marking: this party's own non-receipt is a hard fact the run holds,
    // and withholding a result from the partner is not.
    expect(acceptorWithheld).toContain(
      "  you will receive the result (enforced): no",
    );
    expect(inviterWithheld).toContain(
      "  you will receive the result (enforced): yes",
    );
    // The partner's receipt line is marked by its VALUE, not by the line: a partner
    // that receives is one the run delivers to, and only its use of the result rests
    // on the agreement; a partner that does not receive rests on the agreement for
    // the whole fact.
    expect(acceptorWithheld).toContain(
      "  the inviting party will receive the result (enforced): yes",
    );
    expect(inviterWithheld).toContain(
      "  the inviting party will receive the result (your partner's word): no",
    );
    // The honest-helper disclosure is its own fact, not a rider on the cooperative
    // caveat: it holds however honestly the partner behaves, so it has the
    // opposite basis and may not inherit that line's marker. One label covers
    // both cases of it, so a reader meets the same line whichever the run is.
    for (const document of [inviterWithheld, inviterLearnsNoMembership])
      expect(document).toContain(
        "  what your partner learns about its own records (enforced):",
      );
    // The remaining marked lines, each on the register it belongs to.
    expect(rendered).toContain(`  ${INVITING_PARTY_LABEL}: `);
    expect(rendered).toContain(
      "      declared data standards (your partner's word):",
    );
    expect(rendered).toContain(
      "  allowed-character patterns (your partner's word):",
    );
    // The mode agreement is what the run holds, so the marker is the enforced one;
    // what becomes of the transcript afterwards rides the caveat swept above.
    expect(retaining).toContain(
      "  exchange files (enforced): kept as a permanent transcript, not deleted " +
        "after the run",
    );
  });
});

// The two count-only sentences spelled out rather than read from the shared table,
// for the reason the refusal caveat below is spelled out: an acceptor can ACT on
// either -- the first states the guarantee, the second states what it does not
// cover -- so an edit to either has to be made here as well, on this surface,
// rather than followed. The tier's remaining wording is read from the table, where
// a surface restating it on its own is what fails.
const COUNT_ONLY_STATEMENT =
  "Only the number of records you have in common is revealed, not which " +
  "records match.";
const COUNT_ONLY_INPUT_CHOICE_BOUND =
  "Not enforced against your partner's choice of input: a count-only exchange " +
  "bounds what Alcove hands your partner, not what they can learn by choosing " +
  "which records to ask about. A crafted list, or a second run differing by one " +
  "record, turns a count into an answer about one person.";

/**
 * The five tier sentences, read from the shared table by this surface and by the
 * web consent screen. The algorithm is what makes them one class: a psi-c
 * invitation reaches every one of them on BOTH surfaces and a `psi` invitation
 * reaches none, so an assertion over this list states a cross-surface invariant.
 *
 * COUNT_ONLY_STATEMENT is not in it. That sentence is shared wording
 * with a different placement on each surface -- the web renders it as its
 * matching-method headline, this prompt beneath the algorithm it names -- so its
 * placement is a fact about this prompt alone and is asserted as one.
 */
const COUNT_ONLY_TIER_NOTES = [
  CONSENT_FACTS.countOnlyResult.note,
  CONSENT_FACTS.countOnlyRoundDisclosures.note,
  CONSENT_FACTS.countOnlyReportedCount.note,
  CONSENT_FACTS.countOnlyInputChoice.note,
  CONSENT_FACTS.countOnlyNoPayload.note,
];

/**
 * The decision block for a count-only exchange, over the output direction, the
 * acceptor's own resolved outbound set, and the declared payload each case needs.
 * Rendered from the real shared summary, so what is measured is this renderer's
 * own reading of the algorithm and the words it puts behind it.
 */
function renderCountOnlyFacts(
  output: LinkageTerms["output"] = {
    expectsOutput: true,
    shareWithPartner: true,
  },
  ownOutboundSend: ReadonlyArray<string> = [],
  payload: LinkageTerms["payload"] = COUNT_ONLY_PROBE_TERMS.payload,
): string {
  const block: Array<string> = [];
  logDecisionFacts(
    (line) => {
      block.push(line);
    },
    summarizeInvitation({
      ...sampleToken(FUTURE()),
      linkageTerms: { ...COUNT_ONLY_PROBE_TERMS, output, payload },
    }),
    ownOutboundSend,
  );
  return block.join("\n");
}

describe("the count-only tier", () => {
  test("the count-only tier reaches the prompt, on both surfaces, from one terms document", () => {
    // The exchange conducts a count-only run, so what an acceptor reads for a psi-c
    // invitation is the tier stating what it discloses -- never a caveat saying the
    // algorithm is refused, and never the psi consequence that matched identifiers
    // are revealed.
    //
    // apps/web/test/browser/invitationTermsCountOnly pins the same sentences against
    // the same terms document, so the pair cannot drift apart silently.
    const log = getLogger("accept-display-psi-c-test");
    log.setLevel("silent");
    const shaped = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: COUNT_ONLY_PROBE_TERMS,
    });
    expect(shaped).toContain("PSI algorithm (enforced): psi-c");
    for (const copy of COUNT_ONLY_TIER_NOTES) expect(shaped).toContain(copy);
    expect(shaped).not.toContain(
      "the shared identifiers of matched records are still revealed",
    );
    expect(shaped).not.toContain("does not yet apply it");
    // The headline is the other class: shared wording each surface places for
    // itself, which this prompt prints beneath the algorithm it names. Asserted for
    // this surface only, so the list above keeps stating the invariant both surfaces
    // hold rather than one this one alone does.
    expect(shaped).toContain(`    ${COUNT_ONLY_STATEMENT}`);
    // Non-vacuous the other way: a `psi` invitation reaches no sentence of the tier,
    // so the presence above is the algorithm's doing.
    const revealing = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: CONSENT_PROBE_TERMS,
    });
    for (const copy of COUNT_ONLY_TIER_NOTES)
      expect(revealing).not.toContain(copy);
    expect(revealing).not.toContain(COUNT_ONLY_STATEMENT);
  });

  test("a one-sided count-only invitation states no honest-helper membership disclosure", () => {
    // The membership fact is scoped by the ALGORITHM: by the role rule the
    // non-receiving party of a count-only run is the sender, which computes nothing
    // from the round and is sent no count-report frame, so it learns no membership of
    // its own records. The web consent screen pins the same pair.
    const log = getLogger("accept-display-count-only-membership-test");
    log.setLevel("silent");
    const partnerWithheld: LinkageTerms["output"] = {
      expectsOutput: false,
      shareWithPartner: true,
    };
    const countOnly = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: { ...COUNT_ONLY_PROBE_TERMS, output: partnerWithheld },
    });
    expect(countOnly).toContain("PSI algorithm (enforced): psi-c");
    // The algorithm gate stands ahead of BOTH cases of the fact, so neither the
    // disclosure sentence nor its withheld counterpart reaches a count-only run.
    expect(countOnly).not.toContain(
      "what your partner learns about its own records",
    );
    expect(countOnly).not.toContain(
      CONSENT_FACTS.partnerLearnsOwnMembership.note,
    );
    expect(countOnly).not.toContain(
      CONSENT_FACTS.partnerOwnMembershipWithheld.note,
    );
    // Not the whole block going missing: the line the membership fact sits beneath is
    // still stated, on the register it belongs to.
    expect(countOnly).toContain(
      "  the inviting party will receive the result (your partner's word): no",
    );
    // What replaces it, from docs/spec/PROTOCOL.md's PSI-C learn-basis rows rather
    // than from a softened version of the claim: the enforced half that hands neither
    // party a pairing, and what the rounds disclose beside the count.
    expect(countOnly).toContain(`    ${CONSENT_FACTS.countOnlyResult.note}`);
    expect(countOnly).toContain(
      `    ${CONSENT_FACTS.countOnlyRoundDisclosures.note}`,
    );
    // Non-vacuous the other way: the same one-sided pair under `psi` -- the algorithm
    // the fact is true of -- holds it in full, so the absence above is the
    // algorithm's doing and not the output pair's.
    const revealing = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: {
        ...CONSENT_PROBE_TERMS,
        output: partnerWithheld,
        payload: { ...CONSENT_PROBE_TERMS.payload, receive: [] },
      },
    });
    expect(revealing).toContain(
      "  what your partner learns about its own records (enforced):",
    );
    expect(revealing).toContain(
      `    ${CONSENT_FACTS.partnerLearnsOwnMembership.note}`,
    );
  });

  test("a count-only exchange states its disclosure tier on the register the protocol assigns each half", () => {
    // Each line's marker is the one docs/spec/PROTOCOL.md's PSI-C section assigns
    // that row: a party's own
    // count-only outcome and its view of what the partner receives are held by the
    // run, the count a both-entitled party did not compute is the other's report,
    // and the protection a chosen input set defeats rests on the partner
    // contributing a genuine dataset. Marking any of the three the other way is the
    // error the vocabulary exists to prevent.
    const block = renderCountOnlyFacts();
    expect(block).toContain("  PSI algorithm (enforced): psi-c");
    expect(block).toContain(`    ${COUNT_ONLY_STATEMENT}`);
    expect(block).not.toContain("does not yet apply it");
    expect(block).toContain(
      "  what a count-only exchange still discloses (enforced):",
    );
    expect(block).toContain(
      "  how the count reaches each of you (your partner's word):",
    );
    expect(block).toContain(
      "  what a count-only exchange does not bound (your partner's word):",
    );
    expect(block).toContain(`    ${COUNT_ONLY_INPUT_CHOICE_BOUND}`);
    // The acceptor's own outbound line, answered by the algorithm rather than by who
    // receives the count: both parties are entitled here, so the entitlement-driven
    // sentence would have listed columns instead.
    expect(block).toContain("  columns you will send (enforced): (none)");
    expect(block).toContain(`    ${CONSENT_FACTS.countOnlyNoPayload.note}`);
    expect(block).not.toContain("the inviting party receives no result");
  });

  test("a count-only rendering refuses a resolved outbound set rather than state (none) over it", () => {
    // The "(none)" line states a precondition -- psi-c admits no payload in either
    // direction -- rather than a set the renderer read. This set is this party's own
    // resolved metadata, so a column in it is one the accept path already refused
    // (assertCountOnlyTransmitsNoColumn); this throw is the render-side safety check
    // behind it, since printing "(none)" over a column would take the operator's
    // consent to a disclosure that happens, on the one screen where the disclosure IS
    // the decision. Driven with a column in the set, so the check is measured firing
    // rather than assumed.
    expect(() => renderCountOnlyFacts(undefined, ["risk_score"])).toThrow(
      /no payload in either direction/,
    );
    // Non-vacuous the other way: the same call with an empty set renders the line, so
    // the throw above is the column's doing.
    expect(renderCountOnlyFacts()).toContain(
      "  columns you will send (enforced): (none)",
    );
    // And the check is the count-only branch's alone: a psi invitation resolving the
    // same set lists it, which is what makes the refusal a statement about psi-c.
    const log = getLogger("accept-display-count-only-outbound-test");
    log.setLevel("silent");
    expect(
      renderDisplayInvitation(
        log,
        { ...sampleToken(FUTURE()), linkageTerms: CONSENT_PROBE_TERMS },
        ["risk_score"],
      ),
    ).toContain("  columns you will send (enforced):\n    - risk_score");
  });

  test("a count-only rendering refuses terms that declare a payload column", () => {
    // The mirror of the check above, on the partner's side of it: the invitation is
    // partner-controlled, and a psi-c document declaring a send or a receive is one
    // the spec refuses (docs/spec/PROTOCOL.md, PSI-C). Printed, the tier's no-payload
    // sentence would stand above this same prompt's blocks listing the columns that
    // invitation will send or asks for -- a guarantee stated over the declaration
    // contradicting it. Driven on each direction with the flag forced on, so the check
    // is measured firing rather than assumed.
    expect(() =>
      renderCountOnlyFacts(undefined, [], {
        send: [{ name: "risk_score" }],
        receive: [],
      }),
    ).toThrow(/declare a payload column/);
    expect(() =>
      renderCountOnlyFacts(undefined, [], {
        send: [],
        receive: [{ name: "risk_score" }],
      }),
    ).toThrow(/declare a payload column/);
    // Non-vacuous the other way: the conforming document -- the empty pair psi-c
    // requires -- renders the sentence, so the throws above are the declaration's
    // doing and not the flag's.
    expect(renderCountOnlyFacts()).toContain(
      `    ${CONSENT_FACTS.countOnlyNoPayload.note}`,
    );
    // And the check is the count-only branch's alone: a psi invitation declaring the
    // same columns prints them.
    const log = getLogger("accept-display-count-only-declared-payload-test");
    log.setLevel("silent");
    expect(
      renderDisplayInvitation(log, {
        ...sampleToken(FUTURE()),
        linkageTerms: {
          ...CONSENT_PROBE_TERMS,
          payload: { send: [], receive: [{ name: "risk_score" }] },
        },
      }),
    ).toContain("    - risk_score");
  });

  test("the count a party did not compute is caveated only where both parties are entitled to one", () => {
    // Where exactly one party is entitled to the count, that party is the receiver by
    // the role rule and computes its own, so no report crosses and a line saying one
    // does would name a frame the run does not send. The bound on the guarantee is
    // not conditional in the same way and stays.
    const oneSided = renderCountOnlyFacts({
      expectsOutput: false,
      shareWithPartner: true,
    });
    expect(oneSided).not.toContain("how the count reaches each of you");
    expect(oneSided).not.toContain(CONSENT_FACTS.countOnlyReportedCount.note);
    expect(oneSided).toContain("  what a count-only exchange does not bound");
  });
});

/**
 * The probe terms holding a single linkage key whose one element applies
 * `transform`, so a transform-rendering assertion reads that key's detail with no
 * other key's rules at the same indent. The probe's own fields are reused as-is.
 */
function probeTermsWithTransform(
  transform: Array<TransformStep>,
): LinkageTerms {
  return {
    ...CONSENT_PROBE_TERMS,
    linkageKeys: [
      { name: "probe key", elements: [{ field: "given_name", transform }] },
    ],
  };
}

describe("displayInvitation: linkage-key detail, heading order, and the repeated decision block", () => {
  test("displayInvitation: a transform this version cannot explain is marked as unrecognized", () => {
    // A declared function name core does not recognize has neither a literal slice
    // phrase nor a glossary description, so unmarked it prints in exactly the shape
    // of a recognized rule minus one line -- indistinguishable from a rule Alcove
    // understands. A rule this version cannot explain earns the same explicitness as
    // one it cannot apply.
    const log = getLogger("accept-display-unknown-transform-test");
    log.setLevel("silent");
    const render = (transform: Array<TransformStep>): string =>
      renderDisplayInvitation(log, {
        ...sampleToken(FUTURE()),
        linkageTerms: probeTermsWithTransform(transform),
      });

    const unrecognized = render([{ function: "org_internal_rule" }]);
    expect(unrecognized).toContain("          transform: org_internal_rule");
    expect(unrecognized).toContain(
      `            ${UNRECOGNIZED_TRANSFORM_NOTE}`,
    );
    // A recognized function has its plain-language consequence and no marker, so
    // the marker tells the two apart rather than decorating both.
    const recognized = render([{ function: "to_upper_case" }]);
    expect(recognized).toContain(
      "            Upper-cases the value before matching, so values differing only in letter case can match.",
    );
    expect(recognized).not.toContain(UNRECOGNIZED_TRANSFORM_NOTE);
  });

  test("displayInvitation: a transform parameter is rendered as declared", () => {
    // Every parameter line is the declared value: a token whose parameter the
    // function cannot read as written does not decode, so the CLI has no
    // executed-value line to render beside the declared one.
    const log = getLogger("accept-display-param-test");
    log.setLevel("silent");
    const lines = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: probeTermsWithTransform([
        {
          function: "replace_regex",
          params: { pattern: "-", replacement: "" },
        },
      ]),
    }).split("\n");

    expect(lines).toContain("            - replacement: ");
    expect(lines.some((line) => /runs as/.test(line))).toBe(false);
  });

  test("displayInvitation: a param is named as the document writes it", () => {
    // The acceptor meets this name on this line and in the message of a
    // refusal of the same param, both in the schema's snake_case spelling. The
    // CLI's config-file renderer cuts an issue path at `params`; core's
    // decode-error renderer prints the path whole, camelized key included.
    const log = getLogger("accept-display-param-spelling-test");
    log.setLevel("silent");
    const lines = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: probeTermsWithTransform([
        {
          function: "split_on",
          params: { delimiter: ";", includeOriginal: true },
        },
      ]),
    }).split("\n");

    expect(lines).toContain("            - include_original: true");
    expect(lines.some((line) => line.includes("includeOriginal"))).toBe(false);
  });

  test("displayInvitation: names the fields matched on, once at the top and under each key", () => {
    // The key `name` is partner free text and would otherwise be the only line at a
    // key's own level, so an operator scanning key headings would read nothing but
    // strings the inviter chose. The derived field one-liner is the accurate anchor,
    // and it has the breadth the rules alone do not spell out.
    const log = getLogger("accept-display-matched-fields-test");
    log.setLevel("silent");
    const lines = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: CONSENT_PROBE_TERMS,
    }).split("\n");

    expect(lines).toContain(
      "  matched on (enforced): first name, last name, date of birth",
    );
    // The swap re-attributes each element's marker to its partner's field. Its two
    // positions hold one transform -- the terms refuse a pair whose transforms
    // differ -- so the truncation is shown on both of the fields it reads, and the
    // unswapped date element keeps its own marker.
    const keyIndex = lines.indexOf(
      "    - given name, family name, and date of birth",
    );
    expect(keyIndex).toBeGreaterThanOrEqual(0);
    expect(lines[keyIndex + 1]).toBe(
      "      matches on: first name (partial) - last name (partial) - " +
        "date of birth (fuzzy) (matched in either order)",
    );
    expect(lines[keyIndex + 2]).toBe("      elements:");
  });

  test("displayInvitation: the operator's own outbound heading sits level with the other payload headings", () => {
    // Indentation shows hierarchy in this outline, so the operator's own outbound
    // disclosure must not be the one heading a level below its two counterparts, at
    // the depth of a linkage-key entry.
    const log = getLogger("accept-display-indent-test");
    log.setLevel("silent");
    const lines = renderDisplayInvitation(
      log,
      {
        ...sampleToken(FUTURE()),
        linkageTerms: CONSENT_PROBE_TERMS,
        disclosedPayloadColumns: ["risk_score"],
      },
      ["diagnosis"],
    ).split("\n");

    expect(lines).toContain(`  ${OUTBOUND_SEND_LABEL}:`);
    expect(lines).toContain(
      "  columns you will receive (enforced, 1 declared):",
    );
    expect(lines).toContain(
      "  columns the inviting party requests from you " +
        "(your partner's word, 1 declared):",
    );
    expect(outboundSendEntries(lines)).toEqual(["diagnosis"]);
  });

  test("displayInvitation: the short field list precedes the long key list", () => {
    // The keys enumerate combinations OF the fields and run many times longer, so on
    // a terminal the block printed second is the one that scrolls the first away.
    const log = getLogger("accept-display-order-test");
    log.setLevel("silent");
    const lines = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: CONSENT_PROBE_TERMS,
    }).split("\n");

    const fields = lines.indexOf("  personal data used (enforced):");
    const keys = lines.indexOf("  linkage keys (enforced):");
    expect(fields).toBeGreaterThanOrEqual(0);
    expect(keys).toBeGreaterThan(fields);
  });

  test("displayInvitation: the decision facts are repeated verbatim immediately before the prompt", () => {
    // The terms run well past a screen, so an operator answering the prompt reads the
    // tail: the columns they send, who they disclose to, and the algorithm have all
    // scrolled away. They are printed again last, by the same renderer that prints
    // them first, and this measures the property that makes the second printing a
    // repetition rather than a second account -- the two are byte-identical, so
    // neither can state a fact the other does not. A recap composing its own wording
    // is what would need a check that its facts appear above; this needs only that
    // the bytes match.
    const log = getLogger("accept-display-repeat-test");
    log.setLevel("silent");
    const defaultTerms = sampleTerms("Inviter Org");
    const cases: Array<{
      linkageTerms: LinkageTerms;
      ownOutboundSend: ReadonlyArray<string> | undefined;
      inviterRetainsFiles?: boolean;
    }> = [
      { linkageTerms: defaultTerms, ownOutboundSend: ["diagnosis", "notes"] },
      { linkageTerms: defaultTerms, ownOutboundSend: [] },
      { linkageTerms: defaultTerms, ownOutboundSend: undefined },
      { linkageTerms: CONSENT_PROBE_TERMS, ownOutboundSend: ["diagnosis"] },
      { linkageTerms: COUNT_ONLY_PROBE_TERMS, ownOutboundSend: [] },
      // A retaining invitation, whose fact is held in the block while its caveat
      // is printed once between the two printings. That split is exactly what a
      // sliding or prefix comparison would miss, so the case belongs here: the
      // caveat leaking into either printing lengthens it past the independently
      // rendered block and fails.
      {
        linkageTerms: defaultTerms,
        ownOutboundSend: ["diagnosis"],
        inviterRetainsFiles: true,
      },
      // The hostile fixtures, so the repetition is measured on a partner identity
      // holding escapes rather than only on well-behaved text.
      ...hostileVariants.map(({ source }) => ({
        linkageTerms: source.linkageTerms,
        ownOutboundSend: [`own${BEL}column`],
      })),
    ];

    for (const {
      linkageTerms,
      ownOutboundSend,
      inviterRetainsFiles,
    } of cases) {
      const token = {
        ...sampleToken(FUTURE()),
        linkageTerms,
        ...(inviterRetainsFiles === undefined ? {} : { inviterRetainsFiles }),
      };
      // The block is rendered independently rather than read off either printing, so
      // its LENGTH is measured too. Slicing the tail and comparing it to an
      // equal-length window at the head is a sliding comparison: it cannot see a line
      // appended after the repetition that happens to match the head's next line,
      // which leaves the end of the output unmeasured.
      const block: Array<string> = [];
      logDecisionFacts(
        (entry) => block.push(entry),
        summarizeInvitation(token),
        ownOutboundSend,
      );

      // Both paths through the consent decision. The heading differs -- under
      // --consent-to-terms no prompt follows, so a heading framing the block as
      // something to decide on would be asking for a decision already recorded --
      // and the block below it does not, which is what keeps the two printings one
      // wording rather than two.
      for (const [promptFollows, expectedHeading] of [
        [true, REPEAT_HEADING],
        [false, REPEAT_HEADING_UNATTENDED],
      ] as const) {
        const lines = renderDisplayInvitation(
          log,
          token,
          ownOutboundSend,
          promptFollows,
        ).split("\n");

        expect(lines.filter((line) => line === expectedHeading)).toHaveLength(
          1,
        );
        const heading = lines.indexOf(expectedHeading);
        // Exact equality, not a prefix: a line printed after the repetition makes
        // the tail longer than the block and fails here, whatever that line says.
        expect(lines.slice(heading + 1)).toEqual(block);
        // The same block, byte for byte, at the head of the display -- where index 0
        // is the "Invitation details:" heading the facts open under.
        expect(lines.slice(1, 1 + block.length)).toEqual(block);
        // The unattended heading asks nothing, so the prompting path's framing must
        // not survive anywhere on it.
        if (!promptFollows) expect(lines).not.toContain(REPEAT_HEADING);
      }

      // Non-vacuous: the block holds the decisive partner-controlled fact rather
      // than being an empty tail that trivially matches.
      expect(
        block.some((line) => line.startsWith(`  ${INVITING_PARTY_LABEL}: `)),
      ).toBe(true);
      expect(
        block.some((line) => line.startsWith(`  ${OUTBOUND_SEND_LABEL}`)),
      ).toBe(true);
    }
  });

  test("displayInvitation: every linkage key is listed, including one after an entry with nested detail", () => {
    // entriesUnder backs the separator-safety assertions, so it must collect
    // siblings across an entry's own nested block (a key's derived one-liner and its
    // elements) rather than halting there and silently under-checking. The first key
    // also has the list separator in its name, which a joined list would misread
    // as two keys.
    const log = getLogger("accept-display-key-siblings-test");
    log.setLevel("silent");
    const lines = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: {
        ...CONSENT_PROBE_TERMS,
        linkageKeys: [
          {
            name: "surname, given name",
            elements: [{ field: "family_name" }, { field: "given_name" }],
          },
          { name: "date of birth", elements: [{ field: "birth_date" }] },
        ],
      },
    }).split("\n");

    expect(entriesUnder(lines, "  linkage keys (enforced):")).toEqual([
      "surname, given name",
      "date of birth",
    ]);
  });

  test.each(hostileVariants)(
    "displayInvitation: every line stays printable ASCII on hostile terms ($name)",
    ({ source }) => {
      // The prompt renders every partner-controlled position the summary holds --
      // transform function names and parameters, the allowed-character class, the
      // legal agreement, the expiry -- so the escaping claim is checked over the
      // whole output rather than the few fields an enumeration would list. The
      // fixture is the same one the web app's consent screen is walked with, so the
      // two surfaces cannot drift on what a hostile invitation looks like. This also
      // pins that a key's raw `id` never reaches the prompt: it has the
      // unsanitized key name, which would fail here.
      const log = getLogger("accept-display-hostile-test");
      log.setLevel("silent");
      const lines = renderDisplayInvitation(
        log,
        { ...sampleToken(FUTURE()), ...source },
        [`own${BEL}column`],
      ).split("\n");
      // Guard against a vacuous pass: the prompt must have reached the nested
      // rules, and each hostile code point must appear in its escaped form -- so
      // an output that collapsed, or one the partner text never flowed into,
      // fails here rather than satisfying the assertion below by having nothing
      // to check.
      expect(lines.length).toBeGreaterThan(20);
      for (const hostile of [ESC, RLO, BEL])
        expect(
          lines.filter((line) => line.includes(sanitizeForDisplay(hostile)))
            .length,
        ).toBeGreaterThan(0);
      expect(lines.filter((line) => !PRINTABLE_ASCII.test(line))).toEqual([]);
    },
  );
});
