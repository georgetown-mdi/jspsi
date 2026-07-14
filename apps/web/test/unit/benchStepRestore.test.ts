import { describe, expect, test } from "vitest";

import { restorablePosition, restorableSection } from "@bench/stepRestore";

describe("restorableSection", () => {
  // A start-over clears the invitation but leaves the loaded file and terms, so
  // a `share` entry Back lands on clamps to review rather than a blank column.
  test("clamps share to review when the invitation is gone", () => {
    expect(
      restorableSection("share", {
        hasInvitation: false,
        isCliTransport: false,
      }),
    ).toBe("review");
  });

  test("keeps share when the invitation is still present", () => {
    expect(
      restorableSection("share", {
        hasInvitation: true,
        isCliTransport: false,
      }),
    ).toBe("share");
  });

  // The save surface renders only under a CLI transport; a fresh file resets the
  // transport to browser, stranding a `save` entry the same way.
  test("clamps save to review when the transport is not a CLI transport", () => {
    expect(
      restorableSection("save", {
        hasInvitation: false,
        isCliTransport: false,
      }),
    ).toBe("review");
  });

  test("keeps save under a CLI transport", () => {
    expect(
      restorableSection("save", { hasInvitation: false, isCliTransport: true }),
    ).toBe("save");
  });

  test("restores a step with intact backing state unchanged", () => {
    for (const step of ["file", "columns", "review", "cleaning"] as const)
      expect(
        restorableSection(step, {
          hasInvitation: false,
          isCliTransport: false,
        }),
      ).toBe(step);
  });
});

describe("restorablePosition", () => {
  // A back-to-columns recovery discards the launch but keeps the acquired file
  // and confirmed columns, so a `launched` entry Back lands on clamps to columns
  // rather than a run surface backed by nothing.
  test("clamps launched to columns when the launch is gone", () => {
    expect(restorablePosition("launched", { hasLaunch: false })).toBe(
      "columns",
    );
  });

  test("keeps launched when the launch is still present", () => {
    expect(restorablePosition("launched", { hasLaunch: true })).toBe(
      "launched",
    );
  });

  test("restores a step with intact backing state unchanged", () => {
    for (const token of ["review", "consent", "columns", "columns:cleaning"])
      expect(restorablePosition(token, { hasLaunch: false })).toBe(token);
  });
});
