/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  assembleExchangeSpec,
  connectionFromLocator,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";

import {
  HandleReadPermissionError,
  acquireManagedInput,
  acquireValidatedManagedInput,
  capturedInputHandle,
  ensureHandleReadPermission,
  fileSystemAccessSupported,
} from "@psi/managedInputHandle";
import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  persistManagedExchangeInputHandle,
} from "@psi/managedExchangeStore";
import { ManagedInputError } from "@psi/managedInputGuard";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { runManagedExchange } from "@psi/managedExchangeRun";

import type { ExchangeSpec, WebRTCExchangeLocator } from "@psilink/core";
import type {
  HandleReadPermissionQuery,
  HandleReadPermissionState,
} from "@psi/managedInputHandle";
import type { NewManagedExchange } from "@psi/managedExchangeRecord";

// The platform half of the input-file handle lifecycle, exercised against real
// Chromium: reading a File through a FileSystemFileHandle at run start (real
// getFile, via the origin-private file system), the read-through-not-snapshot
// property, the benign missing-file and column-shape failures, and the run-seam
// composition (the input guard gating the handshake). The permission layer is
// injected: an origin-private-file-system handle implements neither queryPermission
// nor requestPermission, so its real behavior is the always-granted feature-detect
// fallback; the non-granted and prompt cases can only be covered by injection, and
// are, in the "permission layer" block below. The pure column-shape verdict and the
// input-rejection classification are unit-tested in test/unit/managedInputGuard.test.ts.

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

/** The standing exchange-file document a managed record persists. */
function standingExchangeFile(): ExchangeSpec {
  return assembleExchangeSpec({
    connection: connectionFromLocator(webrtcLocator),
    linkageTerms,
  });
}

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

const CONFORMING_HEADER = "ssn,first_name,last_name,date_of_birth\n";
const CONFORMING_ROW = "123456789,ADA,LOVELACE,01/01/1990\n";
const DRIFTED_CSV = "unrelated_a,unrelated_b\n1,2\n";

/** Write `content` to an origin-private-file-system file and return its handle.
 * OPFS handles are structured-cloneable and support getFile(), so they stand in
 * for a picker handle for everything except the permission extension. */
async function writeOpfsFile(
  name: string,
  content: string,
): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
  return handle;
}

/** A permission seam that reports a fixed state and records whether it prompted,
 * so the unattended-never-prompts and attended-prompts paths can be asserted
 * against a handle that (being OPFS) implements no real permission extension. */
function fakePermission(
  queryState: HandleReadPermissionState,
  requestState: HandleReadPermissionState = "granted",
): HandleReadPermissionQuery & { requested: boolean } {
  const seam = {
    requested: false,
    query: () => Promise.resolve(queryState),
    request: () => {
      seam.requested = true;
      return Promise.resolve(requestState);
    },
  };
  return seam;
}

const OPFS_NAMES: Array<string> = [];
async function trackedOpfsFile(
  name: string,
  content: string,
): Promise<FileSystemFileHandle> {
  OPFS_NAMES.push(name);
  return writeOpfsFile(name, content);
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
  const root = await navigator.storage.getDirectory();
  for (const name of OPFS_NAMES.splice(0)) {
    try {
      await root.removeEntry(name);
    } catch {
      // Already gone (a test that removed the entry itself).
    }
  }
});

describe("fileSystemAccessSupported", () => {
  test("is true in Chromium, which has FileSystemFileHandle", () => {
    expect(fileSystemAccessSupported()).toBe(true);
  });
});

describe("read through the handle at run start", () => {
  test("getFile picks up replaced contents at the same path", async () => {
    const handle = await trackedOpfsFile(
      "managed-input.csv",
      CONFORMING_HEADER + CONFORMING_ROW,
    );
    const first = await acquireManagedInput({
      kind: "handle",
      handle,
      attendance: "unattended",
    });
    expect(first.columns).toEqual([
      "ssn",
      "first_name",
      "last_name",
      "date_of_birth",
    ]);
    // The parsed rows ride the same single parse as the columns, so the run
    // consumes the input without a second read.
    expect(first.rows).toEqual([
      {
        ssn: "123456789",
        first_name: "ADA",
        last_name: "LOVELACE",
        date_of_birth: "01/01/1990",
      },
    ]);

    // Drop the next period's extract over the same name -- the data-refresh
    // workflow -- and the same handle reads the new contents, no re-selection.
    const writable = await handle.createWritable();
    await writable.write("email_address\nada@example.org\n");
    await writable.close();

    const second = await acquireManagedInput({
      kind: "handle",
      handle,
      attendance: "unattended",
    });
    expect(second.columns).toEqual(["email_address"]);
    expect(second.rows).toEqual([{ email_address: "ada@example.org" }]);
  });

  test("a missing file fails as a benign acquire rejection", async () => {
    const handle = await trackedOpfsFile(
      "managed-input.csv",
      CONFORMING_HEADER + CONFORMING_ROW,
    );
    // Remove the entry the handle points at: getFile now rejects with a not-found,
    // the clean missing-input state -- never a desync or attack.
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("managed-input.csv");

    const error: unknown = await acquireManagedInput({
      kind: "handle",
      handle,
      attendance: "unattended",
    }).then(
      () => {
        throw new Error("the acquire should have rejected");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ManagedInputError);
    expect((error as ManagedInputError).rejection.reason).toBe("acquire");
  });
});

describe("acquireValidatedManagedInput: column-shape guard on each path", () => {
  test("accepts a conforming file read through a handle", async () => {
    const handle = await trackedOpfsFile(
      "managed-input.csv",
      CONFORMING_HEADER + CONFORMING_ROW,
    );
    const acquired = await acquireValidatedManagedInput(
      standingExchangeFile(),
      {
        kind: "handle",
        handle,
        attendance: "unattended",
      },
    );
    expect(acquired.columns[0]).toBe("ssn");
  });

  test("rejects a drifted file read through a handle (columns rejection)", async () => {
    const handle = await trackedOpfsFile("drifted.csv", DRIFTED_CSV);
    const error: unknown = await acquireValidatedManagedInput(
      standingExchangeFile(),
      { kind: "handle", handle, attendance: "unattended" },
    ).then(
      () => {
        throw new Error("the validated acquire should have rejected");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ManagedInputError);
    expect((error as ManagedInputError).rejection.reason).toBe("columns");
  });

  test("rejects a drifted re-selected file (the no-API path)", async () => {
    // The re-selection path supplies a File directly rather than a handle; the
    // same column guard applies.
    const file = new File([DRIFTED_CSV], "drifted.csv", { type: "text/csv" });
    const error: unknown = await acquireValidatedManagedInput(
      standingExchangeFile(),
      { kind: "file", file },
    ).then(
      () => {
        throw new Error("the validated acquire should have rejected");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ManagedInputError);
    expect((error as ManagedInputError).rejection.reason).toBe("columns");
  });

  test("accepts a conforming re-selected file", async () => {
    const file = new File([CONFORMING_HEADER + CONFORMING_ROW], "input.csv", {
      type: "text/csv",
    });
    const acquired = await acquireValidatedManagedInput(
      standingExchangeFile(),
      {
        kind: "file",
        file,
      },
    );
    expect(acquired.columns[0]).toBe("ssn");
  });
});

describe("permission layer (injected)", () => {
  test("the unattended path proceeds on an existing grant, never prompting", async () => {
    const handle = await trackedOpfsFile(
      "managed-input.csv",
      CONFORMING_HEADER,
    );
    const permission = fakePermission("granted");
    await ensureHandleReadPermission(handle, "unattended", permission);
    expect(permission.requested).toBe(false);
  });

  test("the unattended path fails on a non-granted state without prompting", async () => {
    const handle = await trackedOpfsFile(
      "managed-input.csv",
      CONFORMING_HEADER,
    );
    const permission = fakePermission("prompt");
    await expect(
      ensureHandleReadPermission(handle, "unattended", permission),
    ).rejects.toBeInstanceOf(HandleReadPermissionError);
    // A scheduled run has nobody to answer a prompt, so it must not request.
    expect(permission.requested).toBe(false);
  });

  test("the attended path prompts when the state is prompt and proceeds on grant", async () => {
    const handle = await trackedOpfsFile(
      "managed-input.csv",
      CONFORMING_HEADER,
    );
    const permission = fakePermission("prompt", "granted");
    await ensureHandleReadPermission(handle, "attended", permission);
    expect(permission.requested).toBe(true);
  });

  test("the attended path fails when the operator denies the prompt", async () => {
    const handle = await trackedOpfsFile(
      "managed-input.csv",
      CONFORMING_HEADER,
    );
    const permission = fakePermission("prompt", "denied");
    await expect(
      ensureHandleReadPermission(handle, "attended", permission),
    ).rejects.toBeInstanceOf(HandleReadPermissionError);
    expect(permission.requested).toBe(true);
  });

  test("a denied state fails the unattended acquire as a benign acquire rejection", async () => {
    const handle = await trackedOpfsFile(
      "managed-input.csv",
      CONFORMING_HEADER,
    );
    const permission = fakePermission("denied");
    const error: unknown = await acquireManagedInput(
      { kind: "handle", handle, attendance: "unattended" },
      permission,
    ).then(
      () => {
        throw new Error("the acquire should have rejected");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ManagedInputError);
    expect((error as ManagedInputError).rejection.reason).toBe("acquire");
    expect((error as ManagedInputError).cause).toBeInstanceOf(
      HandleReadPermissionError,
    );
  });
});

describe("handle persistence and re-point", () => {
  test("no handle is persisted where none is supplied (the unsupported-platform shape)", async () => {
    // On a browser without the API the save flow supplies no handle; the record
    // carries none, and the first run re-selects the file.
    const created = await createManagedExchange(newExchange());
    expect(created.inputFileHandle).toBeUndefined();
    expect(
      (await getManagedExchange(created.id))?.inputFileHandle,
    ).toBeUndefined();
  });

  test("an imported record re-acquires a handle by re-point (the post-import path)", async () => {
    // An imported record carries no handle (the export omits it); the first run
    // after import re-acquires one by selection, persisted through the re-point
    // write.
    const created = await createManagedExchange(newExchange());
    expect(created.inputFileHandle).toBeUndefined();

    const handle = await trackedOpfsFile(
      "managed-input.csv",
      CONFORMING_HEADER,
    );
    const repointed = await persistManagedExchangeInputHandle(
      created.id,
      handle,
    );
    expect(repointed.inputFileHandle).toBeDefined();
    const stored = await getManagedExchange(created.id);
    expect(await stored?.inputFileHandle?.isSameEntry(handle)).toBe(true);
    // The re-point advanced only the handle; the secret and document are intact.
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
    expect(stored?.exchangeFile).toEqual(created.exchangeFile);
  });

  test("re-pointing to a new handle replaces the old one, and null drops it", async () => {
    const first = await trackedOpfsFile("first.csv", CONFORMING_HEADER);
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: first }),
    );
    expect(
      await (
        await getManagedExchange(created.id)
      )?.inputFileHandle?.isSameEntry(first),
    ).toBe(true);

    const second = await trackedOpfsFile("second.csv", CONFORMING_HEADER);
    await persistManagedExchangeInputHandle(created.id, second);
    const afterRepoint = await getManagedExchange(created.id);
    expect(await afterRepoint?.inputFileHandle?.isSameEntry(second)).toBe(true);
    expect(await afterRepoint?.inputFileHandle?.isSameEntry(first)).toBe(false);

    await persistManagedExchangeInputHandle(created.id, null);
    expect(
      (await getManagedExchange(created.id))?.inputFileHandle,
    ).toBeUndefined();
  });
});

describe("run seam composition: the input guard gates the handshake", () => {
  test("a missing file records a benign input failure and never handshakes", async () => {
    const handle = await trackedOpfsFile(
      "managed-input.csv",
      CONFORMING_HEADER + CONFORMING_ROW,
    );
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: handle }),
    );
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("managed-input.csv");

    let handshakeRan = false;
    const error: unknown = await runManagedExchange({
      record: created,
      acquireInput: () =>
        acquireValidatedManagedInput(created.exchangeFile, {
          kind: "handle",
          handle,
          attendance: "unattended",
        }),
      handshake: () => {
        handshakeRan = true;
        return Promise.resolve({
          rotatedSecret: generateSharedSecret(),
          handshake: "c",
        });
      },
      dataExchange: () => Promise.resolve("done"),
    }).then(
      () => {
        throw new Error("the run should have rejected on the missing input");
      },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ManagedInputError);
    // No connection was attempted: the guard fails before the handshake.
    expect(handshakeRan).toBe(false);
    // The benign input failure is recorded, never desync/attack framing.
    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun?.outcome).toBe("failed");
    expect(stored?.lastRun?.failureKind).toBe("input");
    // The rotation did not run: the pre-run secret is intact.
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
  });

  test("a column-shape rejection records a benign input failure and never handshakes", async () => {
    const handle = await trackedOpfsFile("drifted.csv", DRIFTED_CSV);
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: handle }),
    );

    let handshakeRan = false;
    const error: unknown = await runManagedExchange({
      record: created,
      acquireInput: () =>
        acquireValidatedManagedInput(created.exchangeFile, {
          kind: "handle",
          handle,
          attendance: "unattended",
        }),
      handshake: () => {
        handshakeRan = true;
        return Promise.resolve({
          rotatedSecret: generateSharedSecret(),
          handshake: "c",
        });
      },
      dataExchange: () => Promise.resolve("done"),
    }).then(
      () => {
        throw new Error("the run should have rejected on the drifted columns");
      },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ManagedInputError);
    expect((error as ManagedInputError).rejection.reason).toBe("columns");
    expect(handshakeRan).toBe(false);
    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun?.failureKind).toBe("input");
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
  });

  test("a conforming file passes the guard and reaches the handshake", async () => {
    const handle = await trackedOpfsFile(
      "managed-input.csv",
      CONFORMING_HEADER + CONFORMING_ROW,
    );
    const created = await createManagedExchange(
      newExchange({ inputFileHandle: handle }),
    );
    const rotatedSecret = generateSharedSecret();

    // The handshake receives the acquired input, proving the guard gates it.
    let handshakeColumns: Array<string> | undefined;
    const result = await runManagedExchange({
      record: created,
      acquireInput: () =>
        acquireValidatedManagedInput(created.exchangeFile, {
          kind: "handle",
          handle,
          attendance: "unattended",
        }),
      handshake: (input) => {
        handshakeColumns = input.columns;
        return Promise.resolve({ rotatedSecret, handshake: "c" });
      },
      dataExchange: () => Promise.resolve("done"),
    });

    expect(handshakeColumns?.[0]).toBe("ssn");
    expect(result.exchange).toBe("done");
    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun?.outcome).toBe("succeeded");
    expect(stored?.sharedSecret).toBe(rotatedSecret);
  });
});

describe("capturedInputHandle", () => {
  // The bench's Dropzone (over file-selector) attaches a `handle` to a dropped
  // File in a secure context on Chromium; capturedInputHandle reads it back so a
  // deposit persists a reusable pointer without a second picker dialog. Here the
  // handle is a real OPFS FileSystemFileHandle attached the same way file-selector
  // attaches a picker handle.
  test("returns a handle attached to the selected file where the API exists", async () => {
    expect(fileSystemAccessSupported()).toBe(true);
    const handle = await writeOpfsFile("captured.csv", CONFORMING_HEADER);
    const file = await handle.getFile();
    (file as File & { handle?: FileSystemFileHandle }).handle = handle;
    expect(capturedInputHandle(file)).toBe(handle);
  });

  test("returns undefined for a plain File with no attached handle", () => {
    const plain = new File(["a,b\n1,2\n"], "plain.csv", { type: "text/csv" });
    expect(capturedInputHandle(plain)).toBeUndefined();
  });

  test("ignores a non-handle value on the handle property", () => {
    const file = new File(["a,b\n1,2\n"], "spoofed.csv", { type: "text/csv" });
    (file as File & { handle?: unknown }).handle = { name: "not-a-handle.csv" };
    expect(capturedInputHandle(file)).toBeUndefined();
  });
});
