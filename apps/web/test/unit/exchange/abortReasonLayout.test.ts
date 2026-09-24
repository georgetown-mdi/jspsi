import { describe, expect, test } from "vitest";

import {
  errorWithPartnerCauseLinks,
  partnerOriginTextList,
} from "@alcove/core";

import { failureFor } from "@exchange/useInviterExchange";
import { layOutValueLineBreaks } from "@exchange/RunSurface";

// How a terms-exchange abort reads once a seat has laid it out. The abort packs
// the partner's reasons several to a cause link, separated by a break of its
// own (`errorWithPartnerCauseLinks` in packages/core/src/utils/partnerOriginText.ts,
// whose budgets and ceiling packages/core/test/partnerAbortLinkBudget.test.ts
// pins); the seat lays the rendered chain out on the breaks a VALUE holds, and
// those are the two different breaks that meet on this route.
//
// What the layout leaves is measured rather than assumed: a break a partner
// wrote opens a line, and the labelled values packed behind it ride on the line
// it opened.

/** The first-party sentence and label the abort composes, as
 * `packages/core/src/protocolSetup.ts` writes them. */
const ABORT_MESSAGE = "partner aborted linkage terms exchange";
const ABORT_LABEL = "reason the partner gave: ";

/** The seat's rendering of an abort holding `reasons`, laid out as the operator
 * reads it: the display escape the category's block applies, then the break in
 * front of each line-break marker. */
function laidOutLines(reasons: ReadonlyArray<string>): Array<string> {
  const failure = failureFor(
    "exchange",
    errorWithPartnerCauseLinks(
      ABORT_MESSAGE,
      ABORT_LABEL,
      partnerOriginTextList(reasons),
    ),
  );
  expect(failure.reportedCause).toBeDefined();
  return layOutValueLineBreaks(failure.reportedCause ?? "").split("\n");
}

describe("a packed abort-reason list at a seat", () => {
  test("a partner's own break opens a line the following values ride on", () => {
    const lines = laidOutLines([
      "first line\nsecond line",
      "another reason",
      "third reason",
    ]);
    // Three lines and no more: the sentence, the link the pack opens, and the
    // one line the partner's break opened. The values packed behind that break
    // are on the line it opened, because the separator between two packed
    // values is this composition's own break and the layout does not open a
    // line on one.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(ABORT_MESSAGE);
    expect(lines[1]).toBe(`caused by: 1. ${ABORT_LABEL}first line`);
    expect(lines[2]).toMatch(/^<0a>second line/);
    expect(lines[2]).toContain(`2. ${ABORT_LABEL}another reason`);
    expect(lines[2]).toContain(`3. ${ABORT_LABEL}third reason`);
  });

  test("the two breaks are told apart by what renders them", () => {
    const lines = laidOutLines(["first line\nsecond line", "another reason"]);
    // The partner's break is a marker, at the head of the line it opened; the
    // composition's own is the escape's token, inline where it was placed. A
    // value cannot write the token, so the line a value opened is always the
    // one headed by a marker.
    expect(lines[2]).toMatch(/^<0a>/);
    expect(lines[2]).toContain("\\x0a\\x0a");
    expect(lines[1]).not.toContain("<0a>");
  });

  test("a reason with no break of its own opens no line", () => {
    expect(laidOutLines(["plain reason", "another plain reason"])).toEqual([
      ABORT_MESSAGE,
      `caused by: 1. ${ABORT_LABEL}plain reason\\x0a\\x0a2. ${ABORT_LABEL}another plain reason`,
    ]);
  });
});
