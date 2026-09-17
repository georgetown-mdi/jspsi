import { describe, expect, test } from "vitest";

import {
  RETAKE_ACTION_LABEL,
  RETAKE_KEY_FILE_NOTE,
  RETAKE_LEAD,
  RETAKE_NO_KEY_FILE_NOTE,
  RETAKE_STORE_FAILED,
  managedRetakeRefusal,
} from "@recurring/managedRetakeModel";
import { handedOffImportReason } from "@recurring/managedHandoffGate";

// The words the re-take is offered and refused in. The action is attested, so the
// confirmation has to state the one thing the operator must already have done and
// the one file that answers what this browser cannot see; the refusals have to
// leave the operator knowing nothing was written.

describe("what the confirmation asks the operator to attest", () => {
  test("names stopping the scheduled run, and what happens if it is not stopped", () => {
    expect(RETAKE_LEAD).toMatch(/[Ss]top the scheduled run/);
    expect(RETAKE_LEAD).toContain("shared secret");
  });

  test("names the file to choose and why a run there changes it", () => {
    expect(RETAKE_KEY_FILE_NOTE).toContain(".psilink.key");
    expect(RETAKE_KEY_FILE_NOTE).toMatch(/each run changes the shared secret/);
  });

  test("states what the wrong key file costs, and where the right one is", () => {
    // Nothing in a key file names the exchange it belongs to, so the operator is
    // the only check on which one is chosen: the copy has to say that the choice
    // replaces the stored secret, what that leaves behind, and where to take the
    // file from.
    expect(RETAKE_KEY_FILE_NOTE).toMatch(/psilink\.yaml/);
    expect(RETAKE_KEY_FILE_NOTE).toMatch(/same name/);
    expect(RETAKE_KEY_FILE_NOTE).toMatch(
      /replaces the only copy of the secret/,
    );
    expect(RETAKE_KEY_FILE_NOTE).toMatch(/unable to connect/);
    expect(RETAKE_KEY_FILE_NOTE).toMatch(/fresh invitation/);
  });

  test("states the case needing no file, and the way out when it cannot be had", () => {
    expect(RETAKE_NO_KEY_FILE_NOTE).toMatch(/not need the file/);
    expect(RETAKE_NO_KEY_FILE_NOTE).toMatch(/fresh invitation/);
  });
});

describe("a take-back that wrote nothing", () => {
  test("says so, whichever way it was refused", () => {
    for (const kind of [
      "unreadable-key-file",
      "run-in-flight",
      "gone",
      "not-handed-off",
    ] as const)
      expect(managedRetakeRefusal(kind).reason).toMatch(
        /Nothing changed|nothing was taken back|nothing here to take back/i,
      );
    expect(RETAKE_STORE_FAILED.reason).toMatch(/Nothing changed here/);
  });

  test("tells a run in flight from a file this app will not read", () => {
    // Two different things to do: wait out the run, or choose the right file.
    expect(managedRetakeRefusal("run-in-flight").reason).toMatch(
      /When it finishes/,
    );
    expect(managedRetakeRefusal("unreadable-key-file").reason).toMatch(
      /Check that you chose/,
    );
  });

  test("a record no longer here points at the files, not at a retry", () => {
    const reason = managedRetakeRefusal("gone").reason;
    expect(reason).toContain(".psilink.key");
    expect(reason).not.toMatch(/try again/i);
  });
});

describe("the import refusal's way back", () => {
  test("names the re-take control by the words on it", () => {
    // The refusal is met at the import affordance, which renders only beside an
    // empty or unreadable listing -- another screen from the one offering the
    // re-take -- so it has to name the control the operator will look for.
    expect(handedOffImportReason("command-line", "Riverbend")).toContain(
      RETAKE_ACTION_LABEL,
    );
  });

  test("leaves the fresh invitation to the re-take, which offers it in place", () => {
    expect(handedOffImportReason("command-line", "")).not.toMatch(
      /create a fresh invitation/i,
    );
  });
});
