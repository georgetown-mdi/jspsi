import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";

import { mountHandler } from "../../../src/commands/doctor";
import { handler as fingerprintHandler } from "../../../src/commands/fingerprint";
import { handler as probeHostKeyHandler } from "../../../src/commands/probeHostKey";
import { handler as verifyReceiptHandler } from "../../../src/commands/verifyReceipt";
import { runMountChecks } from "../../../src/doctor/mount";
import { parseSensitiveJson } from "../../../src/sensitiveFile";
import { loadSigningIdentity } from "../../../src/signingIdentityFile";
import { captureProcessExit } from "../../exitCapture";
import { ERROR_CLASS_EXIT_CODES } from "../../exitCodeCases";
import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";

// The exit code each command's error boundary reports for each class of caught
// error. Every boundary routes through the one exitCodeForError
// (src/util/exit.ts), so a boundary that stops reading it, or reads it and
// reports something else, changes what an unattended supervisor is told. The
// codes are docs/CLI.md's exit-code table. Each test plants one error at the
// module call the boundary wraps; the exchange command's three boundaries are
// pinned the same way in exchange.test.ts, on the handler harness they need.
// These say what a boundary reports for an error that reaches it, and nothing
// about which classes can reach it.

const probeState = vi.hoisted(() => ({ error: undefined as unknown }));

// The doctor's mount checks, the signing-identity load fingerprint resolves
// through, and the sensitive-JSON parse verify-receipt reads its artifact with
// are each the first module call inside their boundary's try. The last two are
// spy-WRAPPED rather than replaced, keeping the real implementation for what a
// run reaches before the planted error.
vi.mock("../../../src/doctor/mount", () => ({ runMountChecks: vi.fn() }));

vi.mock("../../../src/signingIdentityFile", async (importActual) => {
  const actual =
    await importActual<typeof import("../../../src/signingIdentityFile")>();
  return { ...actual, loadSigningIdentity: vi.fn(actual.loadSigningIdentity) };
});

vi.mock("../../../src/sensitiveFile", async (importActual) => {
  const actual =
    await importActual<typeof import("../../../src/sensitiveFile")>();
  return { ...actual, parseSensitiveJson: vi.fn(actual.parseSensitiveJson) };
});

// probe-host-key builds its own FileSyncConnection over a real ssh2 adapter, so
// both are replaced: the connection rejects with whatever the running test
// planted, and the adapter stands in for the client that would otherwise be
// constructed on the way to it. Everything else in core stays real, so the error
// classes the boundary reads are the ones the source imports.
vi.mock("../../../src/connection/ssh2SftpAdapter", () => ({
  SSH2SFTPClientAdapter: class {},
}));

vi.mock("@psilink/core", async (importActual) => {
  const actual = await importActual<typeof import("@psilink/core")>();
  return {
    ...actual,
    FileSyncConnection: class {
      probeHostKeyFingerprint(): Promise<never> {
        return Promise.reject(probeState.error);
      }
    },
  };
});

snapshotDiagnosticSinkAndLevel();

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-exit-boundary-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Run `handler`, asserting it exits with `code` and nothing else. */
async function expectExit(
  run: () => Promise<void>,
  code: number,
): Promise<void> {
  const exitSpy = captureProcessExit();
  try {
    await expect(run()).rejects.toThrow(`exit:${code}`);
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(code);
  } finally {
    exitSpy.mockRestore();
  }
}

describe("doctor mount reports the class of what stopped the checks", () => {
  test.each(ERROR_CLASS_EXIT_CODES)(
    "$planted exits $code",
    async ({ plant, code }) => {
      vi.mocked(runMountChecks).mockImplementationOnce(() => {
        throw plant();
      });
      await expectExit(
        () =>
          mountHandler({
            _: [],
            $0: "psilink",
            directory: dir,
            json: false,
            "log-level": "silent",
          } as unknown as Arguments),
        code,
      );
    },
  );
});

describe("fingerprint reports the class of what stopped the identity", () => {
  test.each(ERROR_CLASS_EXIT_CODES)(
    "$planted exits $code",
    async ({ plant, code }) => {
      vi.mocked(loadSigningIdentity).mockRejectedValueOnce(plant());
      await expectExit(
        () =>
          fingerprintHandler({
            _: [],
            $0: "psilink",
            force: false,
            "identity-file": path.join(dir, "signing-identity.json"),
            "log-level": "silent",
          } as unknown as Arguments),
        code,
      );
    },
  );
});

describe("probe-host-key reports the class of what stopped the dial", () => {
  test.each(ERROR_CLASS_EXIT_CODES)(
    "$planted exits $code",
    async ({ plant, code }) => {
      probeState.error = plant();
      await expectExit(
        () =>
          probeHostKeyHandler({
            _: [],
            $0: "psilink",
            "sftp-url": "sftp://sftp.example.org",
            json: false,
            "log-level": "silent",
          } as unknown as Arguments),
        code,
      );
    },
  );
});

describe("verify-receipt reports the class of what stopped the read", () => {
  test.each(ERROR_CLASS_EXIT_CODES)(
    "$planted exits $code",
    async ({ plant, code }) => {
      const recordPath = path.join(dir, "record.json");
      fs.writeFileSync(recordPath, "{}\n");
      vi.mocked(parseSensitiveJson).mockImplementationOnce(() => {
        throw plant();
      });
      await expectExit(
        () =>
          verifyReceiptHandler({
            _: [],
            $0: "psilink",
            record: recordPath,
            "log-level": "silent",
          } as unknown as Arguments),
        code,
      );
    },
  );
});
