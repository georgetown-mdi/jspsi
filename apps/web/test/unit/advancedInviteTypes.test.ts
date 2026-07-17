import { describe, expect, test } from "vitest";

import {
  directionForOutput,
  outputForDirection,
} from "../../src/psi/advancedInviteTypes.js";

import type { Output } from "@psilink/core";
import type { OutputDirection } from "../../src/psi/advancedInviteTypes.js";

const DIRECTIONS: ReadonlyArray<OutputDirection> = [
  "both",
  "inviter",
  "partner",
];

describe("outputForDirection / directionForOutput", () => {
  test("directionForOutput inverts outputForDirection on every valid direction", () => {
    for (const direction of DIRECTIONS) {
      expect(directionForOutput(outputForDirection(direction))).toBe(direction);
    }
  });

  test("the forbidden 'neither receives' pair maps to the safe 'both' default", () => {
    // safeParseLinkageTerms accepts any two output booleans -- the "neither party
    // expects output" check runs later at exchange time -- so an imported set can
    // carry {false, false}. It has no OutputDirection, so directionForOutput must
    // not throw or silently load a forbidden state; it resolves to the reviewable
    // "both" default.
    const neither: Output = { expectsOutput: false, shareWithPartner: false };
    expect(directionForOutput(neither)).toBe("both");
  });

  test("each direction produces a distinct, non-forbidden output pair", () => {
    const pairs = DIRECTIONS.map((direction) => outputForDirection(direction));
    expect(pairs).not.toContainEqual({
      expectsOutput: false,
      shareWithPartner: false,
    });
    expect(new Set(pairs.map((pair) => JSON.stringify(pair))).size).toBe(3);
  });
});
