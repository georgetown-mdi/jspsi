import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  fixedNothing,
  LARGE_DIFF_LINES,
  parseLedger,
  roundRefusal,
  SMALL_DIFF_LINES,
  sizeAdvice,
} from "./reviewRoundPolicy.mjs";

const row = (kind, ...dispositions) => ({
  kind,
  dispositions: dispositions.map((disposition, i) => ({
    item: `item ${i}`,
    disposition,
  })),
});

const refusal = (rows, extra = {}) =>
  roundRefusal({
    ref: "feature",
    rows,
    role: null,
    ownerCapRaise: false,
    changedLines: 100,
    ...extra,
  });

describe("fixedNothing", () => {
  it.each([
    [["limit"], true],
    [["deferred", "narrowed"], true],
    [[], true],
    [["limit", "fixed"], false],
    [["contested"], false],
    [["open"], false],
  ])("reads dispositions %j as fixed nothing: %s", (dispositions, expected) => {
    expect(fixedNothing(row("light", ...dispositions))).toBe(expected);
  });

  it("does not count a row that predates the dispositions field", () => {
    expect(fixedNothing({ kind: "light" })).toBe(false);
  });
});

describe("roundRefusal", () => {
  it("admits rounds 1 and 2 whatever came before", () => {
    expect(refusal([])).toBeNull();
    expect(refusal([row("light", "limit")])).toBeNull();
  });

  it("refuses round 3 and later after a round that fixed nothing", () => {
    expect(refusal([row("light", "fixed"), row("light", "limit")])).toContain(
      "round 3 of 'feature' would follow round 2",
    );
    expect(
      refusal([
        row("light", "fixed"),
        row("security-reviewer", "fixed"),
        row("light"),
      ]),
    ).toContain("round 4");
  });

  it("admits round 3 after a round that fixed something", () => {
    expect(
      refusal([row("light", "limit"), row("light", "limit", "fixed")]),
    ).toBeNull();
  });

  it("admits the refused round on the owner's cap raise", () => {
    expect(
      refusal([row("light", "fixed"), row("light", "deferred")], {
        ownerCapRaise: true,
      }),
    ).toBeNull();
  });

  it("does not take a truthy non-boolean as the owner's cap raise", () => {
    expect(
      refusal([row("light", "fixed"), row("light", "deferred")], {
        ownerCapRaise: "yes",
      }),
    ).not.toBeNull();
  });

  it("keeps a branch's first role round, however large or late", () => {
    const rows = [row("light", "fixed"), row("light", "fixed"), row("light")];
    expect(
      refusal(rows, { role: "security-reviewer", changedLines: 5000 }),
    ).toBeNull();
    expect(refusal(rows, { role: "adversarial-verifier" })).toBeNull();
  });

  it("holds a role round to the rule once the branch has had one", () => {
    const rows = [row("security-reviewer", "fixed"), row("light", "limit")];
    expect(refusal(rows, { role: "security-reviewer" })).toContain("round 3");
  });

  it("states the size advice in the refusal", () => {
    const rows = [row("light", "fixed"), row("light")];
    expect(refusal(rows, { changedLines: SMALL_DIFF_LINES })).toContain(
      sizeAdvice(SMALL_DIFF_LINES),
    );
  });
});

describe("sizeAdvice", () => {
  it("recommends the role-round rule at or under the small threshold", () => {
    expect(sizeAdvice(SMALL_DIFF_LINES)).toContain(
      "run a role round only when the lens round fixed a major",
    );
  });

  it("recommends the late-round rule over the large threshold", () => {
    expect(sizeAdvice(LARGE_DIFF_LINES + 1)).toContain(
      "run round 4 or later only after a round that fixed a runtime major",
    );
  });

  it("gives no recommendation between the thresholds", () => {
    expect(sizeAdvice(LARGE_DIFF_LINES)).toContain(
      "no size-keyed recommendation applies",
    );
  });

  it("labels the thresholds as measured", () => {
    expect(sizeAdvice(1)).toContain(
      "thresholds measured on the rounds of 2026-08-31 to 2026-09-25",
    );
  });

  it("says so when the diff size is unmeasured", () => {
    expect(sizeAdvice(null)).toContain("could not be measured");
  });
});

describe("parseLedger", () => {
  it("reads one row per non-blank line", () => {
    expect(parseLedger('{"round":1}\n\n{"round":2}\n')).toEqual([
      { round: 1 },
      { round: 2 },
    ]);
  });

  it.each(["not json", "[1]", "null"])("throws on the line %j", (line) => {
    expect(() => parseLedger(`{"round":1}\n${line}\n`)).toThrow(
      "ledger line 2",
    );
  });
});

describe("light-review.md thresholds", () => {
  it("states each size threshold the module exports", () => {
    const prose = readFileSync(
      new URL("../../commands/light-review.md", import.meta.url),
      "utf8",
    );
    for (const threshold of [SMALL_DIFF_LINES, LARGE_DIFF_LINES]) {
      expect(prose).toContain(
        ` ${threshold.toLocaleString("en-US")} changed lines`,
      );
    }
  });
});
