import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Arguments } from "yargs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  UsageError,
  computeCertificateFingerprint,
  generateSigningIdentity,
} from "@psilink/core";
import {
  handler,
  readConfigHints,
  resolveSigningIdentity,
} from "../../src/commands/fingerprint";
import { loadSigningIdentity } from "../../src/signingIdentityFile";
import * as idFile from "../../src/signingIdentityFile";
import { FileExistsError } from "../../src/fileUtils";

let dir: string;
const noopLog = { warn: () => {} };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-fp-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- resolveSigningIdentity (lazy create / load / regenerate) ----------------

test("creates the identity on first use and persists it", () => {
  const idPath = path.join(dir, "id.json");
  const { identity, action } = resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A, Agency A",
    force: false,
    log: noopLog,
  });
  expect(action).toBe("Created");
  expect(identity.certificate.identity).toBe("Party A, Agency A");
  expect(fs.existsSync(idPath)).toBe(true);
});

test("loads the existing identity on a second run (same fingerprint)", async () => {
  const idPath = path.join(dir, "id.json");
  const first = resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  const second = resolveSigningIdentity({
    identityPath: idPath,
    force: false,
    log: noopLog,
  });
  expect(second.action).toBe("Loaded");
  expect(await computeCertificateFingerprint(second.identity.certificate)).toBe(
    await computeCertificateFingerprint(first.identity.certificate),
  );
});

test("ignores --identity when an identity already exists, and warns", () => {
  const idPath = path.join(dir, "id.json");
  resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  const warn = vi.fn();
  const { identity, action } = resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Someone Else",
    force: false,
    log: { warn },
  });
  expect(action).toBe("Loaded");
  expect(identity.certificate.identity).toBe("Party A");
  expect(warn).toHaveBeenCalledOnce();
});

test("--force regenerates a new key with a new fingerprint", async () => {
  const idPath = path.join(dir, "id.json");
  const first = resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  const regenerated = resolveSigningIdentity({
    identityPath: idPath,
    force: true,
    log: noopLog,
  });
  expect(regenerated.action).toBe("Regenerated");
  // same bound identity (re-key), different fingerprint
  expect(regenerated.identity.certificate.identity).toBe("Party A");
  expect(
    await computeCertificateFingerprint(regenerated.identity.certificate),
  ).not.toBe(await computeCertificateFingerprint(first.identity.certificate));
  // the new identity is the one now persisted
  const onDisk = loadSigningIdentity(idPath);
  expect(onDisk).toEqual(regenerated.identity);
});

test("--force with --identity rebinds to a new identity string", () => {
  const idPath = path.join(dir, "id.json");
  resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  const { identity, action } = resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A, renamed",
    force: true,
    log: noopLog,
  });
  expect(action).toBe("Regenerated");
  expect(identity.certificate.identity).toBe("Party A, renamed");
});

test("errors when no identity is available to create one", () => {
  const idPath = path.join(dir, "id.json");
  expect(() =>
    resolveSigningIdentity({
      identityPath: idPath,
      force: false,
      log: noopLog,
    }),
  ).toThrow(UsageError);
  expect(fs.existsSync(idPath)).toBe(false);
});

test("a corrupt identity file is an error without --force", () => {
  const idPath = path.join(dir, "id.json");
  fs.writeFileSync(idPath, "{ not valid json");
  expect(() =>
    resolveSigningIdentity({
      identityPath: idPath,
      identityArg: "Recovered",
      force: false,
      log: noopLog,
    }),
  ).toThrow(UsageError);
});

test("--force regenerates over a corrupt identity file", () => {
  const idPath = path.join(dir, "id.json");
  fs.writeFileSync(idPath, "{ not valid json");
  const warn = vi.fn();
  const { identity, action } = resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Recovered",
    force: true,
    log: { warn },
  });
  expect(action).toBe("Regenerated");
  expect(identity.certificate.identity).toBe("Recovered");
  expect(warn).toHaveBeenCalledOnce(); // warned that the old file was unreadable
  // the file is now a valid, loadable identity
  expect(loadSigningIdentity(idPath)).toEqual(identity);
});

test("on a lost create race, adopts the winner's identity instead of failing", () => {
  const idPath = path.join(dir, "id.json");
  // A "winner" process has already written a valid identity to disk.
  idFile.saveSigningIdentity(idPath, generateSigningIdentity("Winner Party"));
  const realLoad = idFile.loadSigningIdentity;
  let calls = 0;
  const spy = vi
    .spyOn(idFile, "loadSigningIdentity")
    .mockImplementation((p: string) => {
      calls += 1;
      // First call is resolve's existence check: report absent so it attempts
      // an exclusive create and then loses the race to the file on disk. The
      // recovery re-load (second call) uses the real implementation.
      return calls === 1 ? undefined : realLoad(p);
    });
  try {
    const warn = vi.fn();
    const { identity, action } = resolveSigningIdentity({
      identityPath: idPath,
      identityArg: "Loser Party",
      force: false,
      log: { warn },
    });
    expect(action).toBe("Loaded");
    expect(identity.certificate.identity).toBe("Winner Party");
    expect(warn).toHaveBeenCalledOnce();
    // proves the race path ran: existence check + recovery re-load
    expect(calls).toBeGreaterThanOrEqual(2);
  } finally {
    spy.mockRestore();
  }
});

test("retries the exclusive create after the winner vanishes, then creates", () => {
  const idPath = path.join(dir, "id.json");
  const realSave = idFile.saveSigningIdentity;
  let saveCalls = 0;
  const saveSpy = vi
    .spyOn(idFile, "saveSigningIdentity")
    .mockImplementation((p, id, opts) => {
      saveCalls += 1;
      // First attempt loses the race; on the second the path is free again.
      if (saveCalls === 1) throw new FileExistsError(p);
      realSave(p, id, opts);
    });
  // The existence check and the post-failure recovery read both report the file
  // absent (the winner vanished), so the loop retries rather than adopting.
  const loadSpy = vi
    .spyOn(idFile, "loadSigningIdentity")
    .mockReturnValue(undefined);
  try {
    const { identity, action } = resolveSigningIdentity({
      identityPath: idPath,
      identityArg: "Party A",
      force: false,
      log: noopLog,
    });
    expect(action).toBe("Created");
    expect(identity.certificate.identity).toBe("Party A");
    expect(saveCalls).toBe(2); // proves the create was retried, not abandoned
  } finally {
    saveSpy.mockRestore();
    loadSpy.mockRestore();
  }
});

test("fails with a usage error (not a stale exists error) when a create race flaps", () => {
  const idPath = path.join(dir, "id.json");
  // Every exclusive create loses the race and every recovery read finds the file
  // gone -- a pathological create/delete flap. The bounded retry must give up
  // with a UsageError, never re-throw the (non-UsageError) FileExistsError for a
  // file that no longer exists.
  const saveSpy = vi
    .spyOn(idFile, "saveSigningIdentity")
    .mockImplementation((p) => {
      throw new FileExistsError(p);
    });
  const loadSpy = vi
    .spyOn(idFile, "loadSigningIdentity")
    .mockReturnValue(undefined);
  try {
    expect(() =>
      resolveSigningIdentity({
        identityPath: idPath,
        identityArg: "Party A",
        force: false,
        log: noopLog,
      }),
    ).toThrow(UsageError);
  } finally {
    saveSpy.mockRestore();
    loadSpy.mockRestore();
  }
});

test("falls back to the config identity when --identity is absent", () => {
  const idPath = path.join(dir, "id.json");
  const { identity, action } = resolveSigningIdentity({
    identityPath: idPath,
    configIdentity: "Configured Party",
    force: false,
    log: noopLog,
  });
  expect(action).toBe("Created");
  expect(identity.certificate.identity).toBe("Configured Party");
});

// --- handler: --export-certificate guard -------------------------------------

test("handler refuses to export the certificate over the identity file itself", async () => {
  const idPath = path.join(dir, "id.json");
  // Seed a real identity file (it holds the private key).
  idFile.saveSigningIdentity(idPath, generateSigningIdentity("Party A"));
  const before = fs.readFileSync(idPath, "utf8");

  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  const cwd = process.cwd();
  try {
    process.chdir(dir); // hermetic: no ambient psilink.yaml is consulted
    await expect(
      handler({
        _: [],
        $0: "psilink",
        "identity-file": idPath,
        "export-certificate": idPath, // the destructive fat-finger
        "log-level": "silent",
        force: false,
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64"); // UsageError -> exit 64, not a silent clobber
  } finally {
    process.chdir(cwd);
    exitSpy.mockRestore();
  }
  // The identity file is byte-for-byte intact: the private key was not destroyed.
  expect(fs.readFileSync(idPath, "utf8")).toBe(before);
  const reloaded = loadSigningIdentity(idPath);
  expect(reloaded).toBeDefined();
  expect(reloaded?.privateKey).toBeDefined();
});

// --- handler: repeated single-value flag -------------------------------------

test("handler rejects a repeated single-value flag with a usage error (exit 64)", async () => {
  // A repeated --identity (a string flag) is read through singleValue inside the
  // command's try block, so the UsageError it raises is mapped to exit 64 by the
  // existing catch -- the same exit code as the unrecognized-value usage errors.
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  const cwd = process.cwd();
  try {
    process.chdir(dir); // hermetic: no ambient psilink.yaml is consulted
    await expect(
      handler({
        _: [],
        $0: "psilink",
        identity: ["Party A", "Party B"],
        "log-level": "silent",
        force: false,
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64");
  } finally {
    process.chdir(cwd);
    exitSpy.mockRestore();
  }
});

test("handler rejects a repeated --log-level (exit 64) naming the flag", async () => {
  // --log-level is resolved before the logger exists, so its repeat guard reports
  // on stderr and exits 64 directly rather than through the logger-based catch.
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    await expect(
      handler({
        _: [],
        $0: "psilink",
        "log-level": ["info", "debug"],
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64");
    expect(errSpy).toHaveBeenCalledWith("--log-level may be given only once");
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
});

test("handler rejects an unrecognized --log-level (exit 64) with the same idiom", async () => {
  // The repeat guard and the unrecognized-value check share one pre-logger
  // UsageError path, so a typo'd log-level still exits 64 on stderr.
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    await expect(
      handler({
        _: [],
        $0: "psilink",
        "log-level": "bogus",
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64");
    expect(errSpy).toHaveBeenCalledWith("unrecognized log-level: bogus");
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
});

// --- readConfigHints ---------------------------------------------------------

test("readConfigHints returns empty when the default config is absent", () => {
  // run from a dir with no psilink.yaml
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    expect(readConfigHints(undefined, false)).toEqual({});
  } finally {
    process.chdir(cwd);
  }
});

test("readConfigHints throws when an explicit config file is missing", () => {
  expect(() => readConfigHints(path.join(dir, "nope.yaml"), true)).toThrow(
    UsageError,
  );
});

// A YAML parse failure embeds a snippet of the offending source in its message,
// which can carry an inline credential; the path-only guard must close both a
// syntax error (a YAMLParseError reproducing the malformed line) and an
// unresolved alias (a plain ReferenceError echoing the alias name). Mirrors the
// exchange-side guard (exchange.test.ts).
test.each([
  ["syntax error (tab indentation)", (s: string) => `\t  password: ${s}\n`],
  ["unresolved alias", (s: string) => `signing:\n  password: *${s}\n`],
])("readConfigHints does not echo an inline credential: %s", (_, mk) => {
  const SECRET = "S3cr3tSFTPPassw0rd";
  const cfg = path.join(dir, "psilink.yaml");
  fs.writeFileSync(cfg, mk(SECRET));
  let caught: unknown;
  try {
    readConfigHints(cfg, true);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toContain("could not be parsed as YAML");
  expect((caught as Error).message).not.toContain(SECRET);
});

test("readConfigHints reads identity and identity_file from YAML", () => {
  const cfg = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    cfg,
    [
      "linkage_terms:",
      "  identity: Party From Config",
      "signing:",
      "  identity_file: /keys/id.json",
    ].join("\n"),
  );
  expect(readConfigHints(cfg, true)).toEqual({
    identity: "Party From Config",
    identityFile: "/keys/id.json",
  });
});
