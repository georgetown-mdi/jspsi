import { describe, expect, test } from "vitest";

import {
  RETAKE_ACTION_LABEL,
  RETAKE_KEY_FILE_NOTE,
  RETAKE_LEAD,
  RETAKE_NOT_A_PAIR,
  RETAKE_NO_KEY_FILE_NOTE,
  RETAKE_STORE_FAILED,
  managedRetakeRefusal,
} from "@recurring/managedRetakeModel";
import { handedOffImportReason } from "@recurring/managedHandoffGate";

// The words the re-take is offered and refused in. The action is attested, so the
// confirmation has to state the one thing the operator must already have done and
// the files that answer what this browser cannot see; the refusals have to
// leave the operator knowing nothing was written.

describe("what the confirmation asks the operator to attest", () => {
  test("names stopping the scheduled run, and what happens if it is not stopped", () => {
    expect(RETAKE_LEAD).toMatch(/[Ss]top the scheduled run/);
    expect(RETAKE_LEAD).toContain("shared secret");
  });

  test("names both files to choose and why a run there changes the key file", () => {
    expect(RETAKE_KEY_FILE_NOTE).toContain("alcove.yaml and the .alcove.key");
    expect(RETAKE_KEY_FILE_NOTE).toMatch(/both at once/);
    expect(RETAKE_KEY_FILE_NOTE).toMatch(/each run changes the shared secret/);
  });

  test("states what is refused, what the wrong key file still costs, and where the right one is", () => {
    // The alcove.yaml lets the take-back refuse other terms or the other side,
    // but nothing tells a stale key file from the current one, so the copy has
    // to say that the choice replaces the stored secret and what that leaves
    // behind.
    expect(RETAKE_KEY_FILE_NOTE).toMatch(
      /other terms or the other side are refused/,
    );
    expect(RETAKE_KEY_FILE_NOTE).toMatch(
      /replaces the only copy of the secret/,
    );
    expect(RETAKE_KEY_FILE_NOTE).toMatch(/older copy/);
    expect(RETAKE_KEY_FILE_NOTE).toMatch(/unable to connect/);
    expect(RETAKE_KEY_FILE_NOTE).toMatch(/fresh invitation/);
  });

  test("states the case needing no files, and the way out when they cannot be had", () => {
    expect(RETAKE_NO_KEY_FILE_NOTE).toMatch(/not need the files/);
    expect(RETAKE_NO_KEY_FILE_NOTE).toMatch(/fresh invitation/);
  });
});

describe("a take-back that wrote nothing", () => {
  test("says so, whichever way it was refused", () => {
    for (const result of [
      { kind: "unreadable-files" },
      { kind: "run-in-flight" },
      { kind: "gone" },
      { kind: "not-handed-off" },
      { kind: "mismatch", on: "terms" },
      { kind: "mismatch", on: "side" },
    ] as const)
      expect(managedRetakeRefusal(result).reason).toMatch(
        /Nothing changed|nothing was taken back|nothing here to take back/i,
      );
    expect(RETAKE_STORE_FAILED.reason).toMatch(/Nothing changed here/);
    expect(RETAKE_NOT_A_PAIR.reason).toMatch(/Nothing changed here/);
  });

  test("tells a run in flight from files this app will not read", () => {
    // Two different things to do: wait out the run, or choose the right files.
    expect(managedRetakeRefusal({ kind: "run-in-flight" }).reason).toMatch(
      /When it finishes/,
    );
    expect(managedRetakeRefusal({ kind: "unreadable-files" }).reason).toMatch(
      /Check that you chose/,
    );
  });

  test("a pair that is not this exchange's names which way it differs", () => {
    expect(
      managedRetakeRefusal({ kind: "mismatch", on: "terms" }).reason,
    ).toMatch(/different terms/);
    expect(
      managedRetakeRefusal({ kind: "mismatch", on: "side" }).reason,
    ).toMatch(/other side/);
  });

  test("a key file chosen alone is asked for with its alcove.yaml", () => {
    expect(RETAKE_NOT_A_PAIR.reason).toMatch(
      /alcove\.yaml and the \.alcove\.key/,
    );
  });

  test("a record no longer here points at the files, not at a retry", () => {
    const reason = managedRetakeRefusal({ kind: "gone" }).reason;
    expect(reason).toContain(".alcove.key");
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
