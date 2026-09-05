import { describe, expect, test } from "vitest";

import {
  directionForOutput,
  outputForDirection,
} from "../../../src/psi/authoring/advancedInviteTypes.js";

import type { Output } from "@psilink/core";
import type { OutputDirection } from "../../../src/psi/authoring/advancedInviteTypes.js";

/** Every direction the editor can hold, as a total record so a fourth one cannot
 * be added without this suite naming it. */
const EVERY_DIRECTION: Record<OutputDirection, true> = {
  both: true,
  inviter: true,
  partner: true,
};

const DIRECTIONS = Object.keys(
  EVERY_DIRECTION,
) as ReadonlyArray<OutputDirection>;

describe("outputForDirection / directionForOutput", () => {
  test("directionForOutput inverts outputForDirection on every valid direction", () => {
    for (const direction of DIRECTIONS) {
      expect(directionForOutput(outputForDirection(direction))).toBe(direction);
    }
  });

  test("no direction the editor can hold maps to the forbidden pair", () => {
    for (const direction of DIRECTIONS) {
      const output = outputForDirection(direction);
      expect(output.expectsOutput || output.shareWithPartner).toBe(true);
    }
  });

  test("the forbidden 'neither receives' pair maps to the safe 'both' default", () => {
    // safeParseLinkageTerms accepts any two output booleans -- the "neither party
    // expects output" check runs later at exchange time -- so an imported set can
    // hold {false, false}. It has no OutputDirection, so directionForOutput must
    // not throw or silently load a forbidden state; it resolves to the reviewable
    // "both" default.
    const neither: Output = { expectsOutput: false, shareWithPartner: false };
    expect(directionForOutput(neither)).toBe("both");
  });
});
