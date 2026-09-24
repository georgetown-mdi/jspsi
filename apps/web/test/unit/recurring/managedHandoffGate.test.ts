import { describe, expect, test } from "vitest";

import {
  CUSTODY_UNREADABLE_IMPORT_TITLE,
  RECORD_GONE_HANDOFF_REASON,
  RECORD_GONE_HANDOFF_TITLE,
  RUN_IN_FLIGHT_HANDOFF_REASON,
  SUPERSEDED_HANDOFF_TITLE,
  custodyUnreadableImportReason,
  handedOffImportReason,
  supersededHandoffReason,
} from "@recurring/managedHandoffGate";

// The refusals the managed hand-offs show. What happened is one explanation at
// both hand-offs; what to DO about it is only useful if it names something the
// operator can reach from the screen showing it, which is what these pin -- a
// refusal that instructs a download the screen cannot perform leaves the operator
// to find the route themselves.

describe("the superseded refusal", () => {
  test("says the same thing happened at both hand-offs", () => {
    const explanation = "This exchange's secret has changed since you";
    expect(supersededHandoffReason("command-line")).toContain(explanation);
    expect(supersededHandoffReason("migration")).toContain(explanation);
    for (const handoff of ["command-line", "migration"] as const)
      expect(supersededHandoffReason(handoff)).toContain(
        "Nothing was handed over.",
      );
  });

  test("sends the command-line operator to the download beside the confirmation", () => {
    // The panel renders its download button and its confirmation together, so
    // "download again" is a control the operator can see from where they are.
    expect(supersededHandoffReason("command-line")).toMatch(
      /Download the two files again/,
    );
  });

  test("sends the migration operator through the screen they are actually on", () => {
    // The migration confirmation is a full screen that replaces the one holding
    // "Move to another device", so the download control is not reachable from it:
    // the way to a fresh copy is out of this screen first.
    const reason = supersededHandoffReason("migration");
    expect(reason).toContain('"Keep it on this device"');
    expect(reason).toContain("move it again");
    expect(reason).not.toMatch(/Download this exchange again/i);
  });

  test("its heading names the state, which both hand-offs share", () => {
    expect(SUPERSEDED_HANDOFF_TITLE).not.toMatch(/download/i);
  });
});

describe("the record-gone refusal", () => {
  test("points at no download, because there is no record left to download", () => {
    // The refusal a hand-off meets when the exchange was deleted or its storage
    // cleared while the confirmation stood. The superseded copy's remedy is the
    // one sentence this case must not include.
    expect(RECORD_GONE_HANDOFF_REASON).not.toMatch(/download .*again/i);
    expect(RECORD_GONE_HANDOFF_REASON).toMatch(/no longer in this browser/);
    expect(RECORD_GONE_HANDOFF_REASON).toMatch(/nothing was written/);
    expect(RECORD_GONE_HANDOFF_TITLE).not.toMatch(/download/i);
  });

  test("is not the superseded refusal in other words", () => {
    expect(RECORD_GONE_HANDOFF_REASON).not.toBe(
      supersededHandoffReason("migration"),
    );
    expect(RECORD_GONE_HANDOFF_REASON).not.toBe(
      supersededHandoffReason("command-line"),
    );
  });
});

describe("the reasons around them", () => {
  test("the run-in-flight reason still names every context a run can be in", () => {
    expect(RUN_IN_FLIGHT_HANDOFF_REASON).toMatch(/another tab/);
    expect(RUN_IN_FLIGHT_HANDOFF_REASON).toMatch(/schedule/);
  });

  test("the run-in-flight reason invites the retry rather than only asking to wait", () => {
    // The confirm control stays enabled through this refusal (the click-time
    // recheck is the control, not the disabled prop), so the copy must say the
    // retry is the way out rather than displaying as a dead end.
    expect(RUN_IN_FLIGHT_HANDOFF_REASON).toMatch(/hand off again/i);
  });

  test("the refused import names the exchange the operator knows", () => {
    expect(handedOffImportReason("command-line", "Riverbend")).toContain(
      '"Riverbend"',
    );
    expect(handedOffImportReason("command-line", "")).toContain(
      "That exchange",
    );
  });
});

describe("the import refusal for a stored copy that could not be read", () => {
  test("names this browser's stored copy, not the file it was given", () => {
    expect(CUSTODY_UNREADABLE_IMPORT_TITLE).toContain("stored copy");
    expect(CUSTODY_UNREADABLE_IMPORT_TITLE).not.toContain("file");
    expect(custodyUnreadableImportReason("Riverbend")).toContain(
      "This browser could not read the note it keeps beside",
    );
  });

  test("names no hand-off route, none having been read", () => {
    const reason = custodyUnreadableImportReason("Riverbend");
    expect(reason).not.toContain("command line");
    expect(reason).not.toContain("alcove.yaml");
  });

  test("names the exchange the operator knows", () => {
    expect(custodyUnreadableImportReason("Riverbend")).toContain('"Riverbend"');
    expect(custodyUnreadableImportReason("")).toContain("that exchange");
  });

  test("gives both branches of the answer only the operator has", () => {
    // Whether the exchange was handed off is the one thing this browser could not
    // read and the operator can, so the remedy is stated for each answer rather
    // than sending them to a control that cannot decide it.
    const reason = custodyUnreadableImportReason("Riverbend");
    expect(reason).toContain("If you handed this exchange off");
    expect(reason).toContain("If you did not, delete that exchange");
  });
});
