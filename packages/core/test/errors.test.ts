import { describe, expect, test } from "vitest";

import {
  UsageError,
  BilateralModeMismatchError,
  FrameSizeExceededError,
  DirectoryListingBoundsError,
  TransportOperationStalledError,
  ConnectionClosedError,
  PeerAbortError,
} from "../src/errors";

// These assertions guard the operator-facing-error audit (board item 199419757):
// the terminal transport/directory UsageError family carries a recovery-hint tag
// and a concrete operator next step so the CLI's hint-walker suppresses its
// generic "retry without re-inviting" advisory (which would contradict a terminal
// refusal). They pin the tag and a stable fragment of the appended step, not a
// brittle full-string match, and confirm the exit-64 classification (instanceof
// UsageError) the appended prose must not disturb.
describe("terminal transport/directory error taxonomy", () => {
  test("FrameSizeExceededError tags the recovery hint and appends a next step", () => {
    const err = new FrameSizeExceededError("inbound frame exceeds the cap");
    expect(err).toBeInstanceOf(UsageError);
    expect(err.name).toBe("FrameSizeExceededError");
    expect(err.psilinkRecoveryHintEmitted).toBe(true);
    // The call-site fault detail is preserved verbatim at the front...
    expect(err.message).toMatch(/^inbound frame exceeds the cap\. /);
    // ...and the class appends a concrete operator next step.
    expect(err.message).toContain("contact your partner");
  });

  test("DirectoryListingBoundsError tags the recovery hint and appends a next step", () => {
    const err = new DirectoryListingBoundsError(
      "directory has too many entries",
    );
    expect(err).toBeInstanceOf(UsageError);
    expect(err.name).toBe("DirectoryListingBoundsError");
    expect(err.psilinkRecoveryHintEmitted).toBe(true);
    expect(err.message).toMatch(/^directory has too many entries\. /);
    expect(err.message).toContain("dedicated to a single exchange");
  });

  test("TransportOperationStalledError tags the recovery hint and appends a next step", () => {
    const err = new TransportOperationStalledError("SFTP read stalled");
    expect(err).toBeInstanceOf(UsageError);
    expect(err.name).toBe("TransportOperationStalledError");
    expect(err.psilinkRecoveryHintEmitted).toBe(true);
    expect(err.message).toMatch(/^SFTP read stalled\. /);
    expect(err.message).toContain("then retry");
  });

  test("BilateralModeMismatchError tags the hint but leaves the call-site message intact", () => {
    // Unlike its siblings the constructor appends nothing: the call-site message
    // already carries the fix. The tag is present for family consistency even
    // though detection is pre-handshake, where the generic advisory never fires.
    const message =
      "retain_files mismatch: this party has retain_files=true but the peer " +
      "has retain_files=false; both parties must use the same setting";
    const err = new BilateralModeMismatchError(message);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.name).toBe("BilateralModeMismatchError");
    expect(err.psilinkRecoveryHintEmitted).toBe(true);
    expect(err.message).toBe(message);
  });
});

describe("errors deliberately left without a recovery hint", () => {
  test("ConnectionClosedError carries no hint and is not a UsageError", () => {
    // Judged stepless by the audit: an internal teardown signal that almost
    // never reaches the exit code, so the generic advisory has nothing to
    // contradict and it stays a plain Error (CLI exit 69, not 64).
    const err = new ConnectionClosedError();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UsageError);
    expect(
      (err as { psilinkRecoveryHintEmitted?: unknown })
        .psilinkRecoveryHintEmitted,
    ).toBeUndefined();
  });
});

describe("PeerAbortError exemplar (unchanged)", () => {
  test("still carries the hint and its pinned partner-contact message", () => {
    // The audit's exemplar: its message is deliberately pinned and must not be
    // reworded. This guards against an accidental edit to the bar the rest rose
    // to meet.
    const err = new PeerAbortError();
    expect(err.name).toBe("PeerAbortError");
    expect(err.psilinkRecoveryHintEmitted).toBe(true);
    expect(err.message).toContain(
      "Contact your partner, who holds the specific error locally.",
    );
  });
});
