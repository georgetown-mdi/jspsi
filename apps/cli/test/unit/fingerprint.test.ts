import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Arguments } from "yargs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  DISPLAY_TRUNCATION_MARKER,
  MAX_TEXT_LENGTH,
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
import {
  argv,
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../loggingTestSupport";
import { captureProcessExit } from "../exitCapture";

let dir: string;
const noopLog = { warn: () => {} };

snapshotDiagnosticSinkAndLevel();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-fp-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- resolveSigningIdentity (lazy create / load / regenerate) ----------------

test("creates the identity on first use and persists it", async () => {
  const idPath = path.join(dir, "id.json");
  const { identity, action } = await resolveSigningIdentity({
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
  const first = await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  const second = await resolveSigningIdentity({
    identityPath: idPath,
    force: false,
    log: noopLog,
  });
  expect(second.action).toBe("Loaded");
  expect(await computeCertificateFingerprint(second.identity.certificate)).toBe(
    await computeCertificateFingerprint(first.identity.certificate),
  );
});

test("ignores --identity when an identity already exists, and warns", async () => {
  const idPath = path.join(dir, "id.json");
  await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  const warn = vi.fn();
  const { identity, action } = await resolveSigningIdentity({
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
  const first = await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  const regenerated = await resolveSigningIdentity({
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
  const onDisk = await loadSigningIdentity(idPath);
  expect(onDisk).toEqual(regenerated.identity);
});

test("--force with --identity rebinds to a new identity string", async () => {
  const idPath = path.join(dir, "id.json");
  await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  const { identity, action } = await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A, renamed",
    force: true,
    log: noopLog,
  });
  expect(action).toBe("Regenerated");
  expect(identity.certificate.identity).toBe("Party A, renamed");
});

test("errors when no identity is available to create one", async () => {
  const idPath = path.join(dir, "id.json");
  await expect(
    resolveSigningIdentity({
      identityPath: idPath,
      force: false,
      log: noopLog,
    }),
  ).rejects.toThrow(UsageError);
  expect(fs.existsSync(idPath)).toBe(false);
});

test("a corrupt identity file is an error without --force", async () => {
  const idPath = path.join(dir, "id.json");
  fs.writeFileSync(idPath, "{ not valid json");
  await expect(
    resolveSigningIdentity({
      identityPath: idPath,
      identityArg: "Recovered",
      force: false,
      log: noopLog,
    }),
  ).rejects.toThrow(UsageError);
});

test("--force regenerates over a corrupt identity file", async () => {
  const idPath = path.join(dir, "id.json");
  fs.writeFileSync(idPath, "{ not valid json");
  const warn = vi.fn();
  const { identity, action } = await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Recovered",
    force: true,
    log: { warn },
  });
  expect(action).toBe("Regenerated");
  expect(identity.certificate.identity).toBe("Recovered");
  expect(warn).toHaveBeenCalledOnce(); // warned that the old file was unreadable
  // the file is now a valid, loadable identity
  await expect(loadSigningIdentity(idPath)).resolves.toEqual(identity);
});

test("on a lost create race, adopts the winner's identity instead of failing", async () => {
  const idPath = path.join(dir, "id.json");
  // A "winner" process has already written a valid identity to disk.
  idFile.saveSigningIdentity(
    idPath,
    await generateSigningIdentity("Winner Party"),
  );
  const realLoad = idFile.loadSigningIdentity;
  let calls = 0;
  const spy = vi
    .spyOn(idFile, "loadSigningIdentity")
    .mockImplementation(async (p: string) => {
      calls += 1;
      // First call is resolve's existence check: report absent so it attempts
      // an exclusive create and then loses the race to the file on disk. The
      // recovery re-load (second call) uses the real implementation.
      return calls === 1 ? undefined : realLoad(p);
    });
  try {
    const warn = vi.fn();
    const { identity, action } = await resolveSigningIdentity({
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

test("on a lost create race, no divergence warning fires for the discarded local intent", async () => {
  const idPath = path.join(dir, "id.json");
  // The winner's on-disk identity matches the config; only this invocation's
  // discarded intent diverges. The identity in effect is the winner's, so there
  // is nothing to warn about -- the discarded intent binds nothing.
  idFile.saveSigningIdentity(
    idPath,
    await generateSigningIdentity("Config Party"),
  );
  const realLoad = idFile.loadSigningIdentity;
  let calls = 0;
  const spy = vi
    .spyOn(idFile, "loadSigningIdentity")
    .mockImplementation(async (p: string) => {
      calls += 1;
      return calls === 1 ? undefined : realLoad(p);
    });
  try {
    const warn = vi.fn();
    const { identity, action } = await resolveSigningIdentity({
      identityPath: idPath,
      identityArg: "Loser Party",
      configIdentity: "Config Party",
      force: false,
      log: { warn },
    });
    expect(action).toBe("Loaded");
    expect(identity.certificate.identity).toBe("Config Party");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).not.toContain("linkage_terms.identity");
  } finally {
    spy.mockRestore();
  }
});

test("retries the exclusive create after the winner vanishes, then creates", async () => {
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
    .mockResolvedValue(undefined);
  try {
    const { identity, action } = await resolveSigningIdentity({
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

test("fails with a usage error (not a stale exists error) when a create race flaps", async () => {
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
    .mockResolvedValue(undefined);
  try {
    await expect(
      resolveSigningIdentity({
        identityPath: idPath,
        identityArg: "Party A",
        force: false,
        log: noopLog,
      }),
    ).rejects.toThrow(UsageError);
  } finally {
    saveSpy.mockRestore();
    loadSpy.mockRestore();
  }
});

test("falls back to the config identity when --identity is absent", async () => {
  const idPath = path.join(dir, "id.json");
  const warn = vi.fn();
  const { identity, action } = await resolveSigningIdentity({
    identityPath: idPath,
    configIdentity: "Configured Party",
    force: false,
    log: { warn },
  });
  expect(action).toBe("Created");
  expect(identity.certificate.identity).toBe("Configured Party");
  // nothing to diverge from: the bound identity IS the config's
  expect(warn).not.toHaveBeenCalled();
});

// --- the label bound into the certificate ------------------------------------

/** A control character by code point, so the fixtures below stay printable
 * ASCII in the source while holding the byte under test. */
const control = (code: number): string => String.fromCharCode(code);

test.each([
  ["a NUL", `Party${control(0x00)}A`],
  ["a line feed", "Party\nA"],
  ["a terminal escape", `Party ${control(0x1b)}[31mA`],
  ["a DEL", `Party${control(0x7f)}A`],
  ["a C1 byte", `Party${control(0x9b)}A`],
])(
  "refuses to bind an identity holding %s, and writes no file",
  async (_label, identityArg) => {
    // The label is bound into a long-lived certificate the partner pins and
    // DISPLAYS long after this run, and it reaches this command without passing
    // through the linkage-terms schema that refuses these characters on every
    // other route into the same field.
    const idPath = path.join(dir, "id.json");
    await expect(
      resolveSigningIdentity({
        identityPath: idPath,
        identityArg,
        force: false,
        log: noopLog,
      }),
    ).rejects.toThrow(UsageError);
    expect(fs.existsSync(idPath)).toBe(false);
  },
);

test("the refusal names the shape rule and never echoes the label back", async () => {
  const idPath = path.join(dir, "id.json");
  let caught: unknown;
  try {
    await resolveSigningIdentity({
      identityPath: idPath,
      identityArg: `Party${control(0x07)}Secret-Looking-Value`,
      force: false,
      log: noopLog,
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  const message = (caught as Error).message;
  expect(message).toContain("must not contain control characters");
  expect(message).toContain("--identity");
  expect(message).toContain("linkage_terms.identity");
  expect(message).not.toContain("Secret-Looking-Value");
});

test("refuses a label longer than the bound the linkage terms hold", async () => {
  const idPath = path.join(dir, "id.json");
  await expect(
    resolveSigningIdentity({
      identityPath: idPath,
      identityArg: "A".repeat(MAX_TEXT_LENGTH + 1),
      force: false,
      log: noopLog,
    }),
  ).rejects.toThrow(UsageError);
  expect(fs.existsSync(idPath)).toBe(false);
  // The bound itself is admissible, so what was added is the terms document's
  // ceiling rather than a stricter rule smuggled in beside it.
  const { action } = await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "A".repeat(MAX_TEXT_LENGTH),
    force: false,
    log: noopLog,
  });
  expect(action).toBe("Created");
});

test("a control-character label from the config is refused too", async () => {
  // linkage_terms.identity is the other route into the same binding, so it takes
  // the same rule: a config value the terms schema would refuse cannot enter a
  // certificate through this command either.
  const idPath = path.join(dir, "id.json");
  await expect(
    resolveSigningIdentity({
      identityPath: idPath,
      configIdentity: `Party${control(0x01)}A`,
      force: false,
      log: noopLog,
    }),
  ).rejects.toThrow(UsageError);
  expect(fs.existsSync(idPath)).toBe(false);
});

test("a --force re-key passing a bad label forward is refused", async () => {
  // A re-key binds the EXISTING label into a new certificate, so the check is
  // about what that certificate would hold rather than about how the value
  // arrived; the remedy is a clean --identity, and the old file survives until
  // one is given.
  const idPath = path.join(dir, "id.json");
  idFile.saveSigningIdentity(
    idPath,
    await generateSigningIdentity(`Party${control(0x00)}A`),
  );
  const before = fs.readFileSync(idPath, "utf8");
  await expect(
    resolveSigningIdentity({ identityPath: idPath, force: true, log: noopLog }),
  ).rejects.toThrow(UsageError);
  expect(fs.readFileSync(idPath, "utf8")).toBe(before);
  const { action, identity } = await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: true,
    log: noopLog,
  });
  expect(action).toBe("Regenerated");
  expect(identity.certificate.identity).toBe("Party A");
});

// --- creation-time divergence from linkage_terms.identity --------------------

test("warns when the bound identity diverges from the config identity", async () => {
  const idPath = path.join(dir, "id.json");
  const warn = vi.fn();
  const { identity, action } = await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    configIdentity: "Party A, Agency A, a@agency-a.gov",
    force: false,
    log: { warn },
  });
  // warned, but still created and bound to the requested identity
  expect(action).toBe("Created");
  expect(identity.certificate.identity).toBe("Party A");
  expect(warn).toHaveBeenCalledOnce();
  const message = warn.mock.calls[0]?.[0] as string;
  // both values are named, along with the downstream consequence
  expect(message).toContain('"Party A"');
  expect(message).toContain('"Party A, Agency A, a@agency-a.gov"');
  expect(message).toContain("linkage_terms.identity");
  expect(message).toContain("reject");
  // `psilink fingerprint` sends nothing, so it reports and prints the
  // fingerprint. What it must not leave unsaid is that the exchange command
  // disposes of the same divergence differently: it refuses the run.
  expect(message).toContain("refused before it runs");
});

test("a control-character label is escaped where the warning is logged", async () => {
  // This log sink is where these values get their one escape pass
  // (CONTRIBUTING.md, Operator-facing escaping), via the shared party-identity
  // helper; a label holding a terminal escape must not reach the operator's
  // terminal as one. Reached over an identity ALREADY on disk: a new binding
  // holding a control character is refused outright (below), but the
  // certificate schema admits an existing one, so a loaded file is how such a
  // label still reaches this sink.
  const idPath = path.join(dir, "id.json");
  const warn = vi.fn();
  const esc = String.fromCharCode(0x1b);
  idFile.saveSigningIdentity(
    idPath,
    await generateSigningIdentity(`Party ${esc}[31mA`),
  );
  await resolveSigningIdentity({
    identityPath: idPath,
    configIdentity: `Agency\nA`,
    force: false,
    log: { warn },
  });
  const message = warn.mock.calls[0]?.[0] as string;
  expect(message).toContain("Party \\x1b[31mA");
  expect(message).toContain("Agency\\x0aA");
  expect(/[^\t\x20-\x7e]/.test(message)).toBe(false);
});

test("is silent when the bound identity matches the config identity", async () => {
  const idPath = path.join(dir, "id.json");
  const warn = vi.fn();
  const { identity } = await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    configIdentity: "Party A",
    force: false,
    log: { warn },
  });
  expect(identity.certificate.identity).toBe("Party A");
  expect(warn).not.toHaveBeenCalled();
});

test("is silent when the config has no linkage_terms.identity", async () => {
  const idPath = path.join(dir, "id.json");
  const warn = vi.fn();
  await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: { warn },
  });
  expect(warn).not.toHaveBeenCalled();
});

test("an empty config identity is treated as absent, not as a divergence", async () => {
  const idPath = path.join(dir, "id.json");
  const warn = vi.fn();
  await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    configIdentity: "",
    force: false,
    log: { warn },
  });
  expect(warn).not.toHaveBeenCalled();
});

test("a --force re-key that keeps a divergent bound identity warns", async () => {
  const idPath = path.join(dir, "id.json");
  await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  // No --identity, so the re-key passes the existing binding forward; it is
  // still the identity the new certificate is bound to.
  const warn = vi.fn();
  const { action } = await resolveSigningIdentity({
    identityPath: idPath,
    configIdentity: "Party A, Agency A",
    force: true,
    log: { warn },
  });
  expect(action).toBe("Regenerated");
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[0]).toContain("linkage_terms.identity");
});

test("loading an existing divergent identity warns on every run", async () => {
  const idPath = path.join(dir, "id.json");
  await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  // A config edited after the binding was made leaves the divergence standing,
  // and nothing else re-reports it: the load path is the only place a routine
  // run sees it.
  const warn = vi.fn();
  const { action } = await resolveSigningIdentity({
    identityPath: idPath,
    configIdentity: "Party A, Agency A",
    force: false,
    log: { warn },
  });
  expect(action).toBe("Loaded");
  expect(warn).toHaveBeenCalledOnce();
  const message = warn.mock.calls[0]?.[0] as string;
  expect(message).toContain('"Party A"');
  expect(message).toContain('"Party A, Agency A"');
  expect(message).toContain("linkage_terms.identity");
  expect(message).toContain("reject");

  // Nagging by design: the second run repeats it rather than remembering that
  // the first one warned.
  const warnAgain = vi.fn();
  await resolveSigningIdentity({
    identityPath: idPath,
    configIdentity: "Party A, Agency A",
    force: false,
    log: { warn: warnAgain },
  });
  expect(warnAgain).toHaveBeenCalledOnce();
});

test("loading a matching identity stays silent", async () => {
  const idPath = path.join(dir, "id.json");
  await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  const warn = vi.fn();
  const { action } = await resolveSigningIdentity({
    identityPath: idPath,
    configIdentity: "Party A",
    force: false,
    log: { warn },
  });
  expect(action).toBe("Loaded");
  expect(warn).not.toHaveBeenCalled();
});

test("loading with no config identity stays silent", async () => {
  const idPath = path.join(dir, "id.json");
  await resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  const warn = vi.fn();
  const { action } = await resolveSigningIdentity({
    identityPath: idPath,
    force: false,
    log: { warn },
  });
  expect(action).toBe("Loaded");
  expect(warn).not.toHaveBeenCalled();
});

test("an adopted concurrent identity that diverges warns", async () => {
  const idPath = path.join(dir, "id.json");
  // The winner's on-disk binding is what this run ends up using, so it is the
  // value the config is compared against -- not this invocation's discarded
  // --identity intent, which matches the config here and binds nothing.
  idFile.saveSigningIdentity(
    idPath,
    await generateSigningIdentity("Winner Party"),
  );
  const realLoad = idFile.loadSigningIdentity;
  let calls = 0;
  const spy = vi
    .spyOn(idFile, "loadSigningIdentity")
    .mockImplementation(async (p: string) => {
      calls += 1;
      return calls === 1 ? undefined : realLoad(p);
    });
  try {
    const warn = vi.fn();
    const { identity, action } = await resolveSigningIdentity({
      identityPath: idPath,
      identityArg: "Config Party",
      configIdentity: "Config Party",
      force: false,
      log: { warn },
    });
    expect(action).toBe("Loaded");
    expect(identity.certificate.identity).toBe("Winner Party");
    const messages = warn.mock.calls.map((c) => c[0] as string);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("another process created");
    expect(messages[1]).toContain("linkage_terms.identity");
    expect(messages[1]).toContain('"Winner Party"');
  } finally {
    spy.mockRestore();
  }
});

test("handler puts the divergence warning on stderr, leaving stdout the bare value", async () => {
  const idPath = path.join(dir, "id.json");
  const cfg = path.join(dir, "psilink.yaml");
  fs.writeFileSync(cfg, "linkage_terms:\n  identity: Party From Config\n");
  const { stdoutWrites, stderrWrites, restore } = captureStdio();
  // console.log is vitest-intercepted, so it never reaches the stdout spy;
  // collect it into the same buffer to see everything a run puts on stdout.
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      stdoutWrites.push(args.map((a) => String(a)).join(" ") + "\n");
    });
  try {
    await handler(
      argv({
        identity: "Party A",
        "identity-file": idPath,
        "config-file": cfg,
        force: false,
      }),
    );
  } finally {
    logSpy.mockRestore();
    restore();
  }
  const stored = await loadSigningIdentity(idPath);
  if (stored === undefined) throw new Error("the identity was not persisted");
  const fingerprint = await computeCertificateFingerprint(stored.certificate);
  // stdout holds the value and nothing else, so `FP=$(psilink fingerprint)`
  // captures a clean fingerprint even when the warning fires.
  expect(stdoutWrites.join("")).toBe(`${fingerprint}\n`);
  expect(stderrWrites.join("")).toContain("linkage_terms.identity");
  expect(stderrWrites.join("")).toContain("Party From Config");
});

test("handler warns on a divergent load and still prints the bare value", async () => {
  const idPath = path.join(dir, "id.json");
  const cfg = path.join(dir, "psilink.yaml");
  // The identity was bound before the config named a different party -- the
  // routine re-run that used to print the fingerprint and nothing else.
  const stored = await generateSigningIdentity("Party A");
  idFile.saveSigningIdentity(idPath, stored);
  fs.writeFileSync(cfg, "linkage_terms:\n  identity: Party From Config\n");
  const { stdoutWrites, stderrWrites, restore } = captureStdio();
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      stdoutWrites.push(args.map((a) => String(a)).join(" ") + "\n");
    });
  try {
    await handler(
      argv({
        "identity-file": idPath,
        "config-file": cfg,
        force: false,
      }),
    );
  } finally {
    logSpy.mockRestore();
    restore();
  }
  const fingerprint = await computeCertificateFingerprint(stored.certificate);
  expect(stdoutWrites.join("")).toBe(`${fingerprint}\n`);
  const stderr = stderrWrites.join("");
  expect(stderr).toContain("Loaded signing identity");
  expect(stderr).toContain("linkage_terms.identity");
  expect(stderr).toContain("Party From Config");
  expect(stderr).toContain("Party A");
  // The identity file is untouched by a load that warns.
  await expect(loadSigningIdentity(idPath)).resolves.toEqual(stored);
});

// --- handler: no identity path named -----------------------------------------

/** Run the handler with `process.exit` stubbed to throw, collecting everything
 * that reached stdout (including console.log, which vitest intercepts) and
 * stderr. Runs from a directory holding no `psilink.yaml`, so no ambient config
 * supplies a path. */
async function runFingerprint(options: Record<string, unknown>): Promise<{
  stdout: string;
  stderr: string;
  thrown: unknown;
}> {
  const { stdoutWrites, stderrWrites, restore } = captureStdio();
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      stdoutWrites.push(args.map((a) => String(a)).join(" ") + "\n");
    });
  const exitSpy = captureProcessExit();
  const cwd = process.cwd();
  let thrown: unknown;
  try {
    process.chdir(dir);
    await handler({
      _: [],
      $0: "psilink",
      force: false,
      ...options,
    } as unknown as Arguments);
  } catch (err) {
    thrown = err;
  } finally {
    process.chdir(cwd);
    exitSpy.mockRestore();
    logSpy.mockRestore();
    restore();
  }
  return {
    stdout: stdoutWrites.join(""),
    stderr: stderrWrites.join(""),
    thrown,
  };
}

test("handler refuses with nothing on stdout when no identity path is named", async () => {
  // `FP=$(psilink fingerprint)` must capture an EMPTY value and a nonzero
  // status, never a fingerprint minted at a location the operator did not
  // choose. Stdout holds the command's one result, so the refusal has to leave
  // it empty rather than explain itself there.
  const { stdout, stderr, thrown } = await runFingerprint({
    identity: "Party A",
  });
  expect((thrown as Error).message).toBe("exit:64");
  expect(stdout).toBe("");
  expect(stderr).toContain("no signing identity path is configured");
});

test("the refusal holds the whole remedy, unrendered by the display sanitizer", async () => {
  // The guidance is critical rather than cosmetic: a bare "name a path"
  // invites a throwaway location whose loss forces a re-key coordinated with
  // every partner. It renders through sanitizeErrorForDisplay, which truncates a
  // long message, so each part is asserted where the operator actually reads it.
  const { stderr } = await runFingerprint({ identity: "Party A" });
  // Why the operator names the path is contributor-tier, kept in the module
  // comment rather than spent on the terminal.
  expect(stderr).not.toContain("yours to decide");
  expect(stderr).not.toContain(
    "reused across every exchange and every partner",
  );
  // Both spellings, with an example under a mount of the identity's own.
  expect(stderr).toContain("--identity-file");
  expect(stderr).toContain("signing.identity_file");
  expect(stderr).toContain("/run/signing/psilink-signing-identity.json");
  // What the directory has to be.
  expect(stderr).toContain("writable for this creating run");
  expect(stderr).toContain("read-only");
  expect(stderr).toContain("durable");
  expect(stderr).toContain("your partner syncs into");
  // The static reuse line, which closes the message rather than probing for a
  // file psilink no longer knows a location for.
  expect(stderr).toContain("already hold an identity from an earlier release");
  expect(stderr).toContain("re-pin");
  // Nothing was truncated away, and no elision marker reached the operator.
  expect(stderr).not.toContain(DISPLAY_TRUNCATION_MARKER);
});

test.each([
  ["absent", undefined],
  ["a path that does not exist", path.join(os.tmpdir(), "psilink-no-home")],
])(
  "a HOME that is %s changes nothing: still a refusal, still no file",
  async (_label, home) => {
    // The ephemeral-container defect stated as a check. With no configured path
    // the home directory is not consulted, so its state cannot decide whether a
    // key is minted -- and no key is minted either way.
    const previousHome = process.env["HOME"];
    const previousProfile = process.env["USERPROFILE"];
    try {
      if (home === undefined) {
        delete process.env["HOME"];
        delete process.env["USERPROFILE"];
      } else {
        process.env["HOME"] = home;
        process.env["USERPROFILE"] = home;
      }
      const { stdout, stderr, thrown } = await runFingerprint({
        identity: "Party A",
      });
      expect((thrown as Error).message).toBe("exit:64");
      expect(stdout).toBe("");
      expect(stderr).toContain("no signing identity path is configured");
      if (home !== undefined) expect(fs.existsSync(home)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      if (previousProfile === undefined) delete process.env["USERPROFILE"];
      else process.env["USERPROFILE"] = previousProfile;
    }
    // Nothing was written into the working directory either -- refusing means
    // creating nowhere, not falling back to somewhere visible.
    expect(fs.readdirSync(dir)).toEqual([]);
  },
);

test("--identity-file creates the identity exactly where it was named", async () => {
  const idPath = path.join(dir, "named", "psilink-signing-identity.json");
  const { stdout, thrown } = await runFingerprint({
    identity: "Party A",
    "identity-file": idPath,
  });
  expect(thrown).toBeUndefined();
  const stored = await loadSigningIdentity(idPath);
  if (stored === undefined) throw new Error("the identity was not persisted");
  expect(stdout).toBe(
    `${await computeCertificateFingerprint(stored.certificate)}\n`,
  );
});

test("signing.identity_file in the config is honoured, and re-runs are stable", async () => {
  // The mounted-credentials shape: the path lives in the config, the home
  // directory is somewhere else and ephemeral, and a second run reports the
  // fingerprint the first one minted rather than a new one.
  const idPath = path.join(dir, "secrets", "psilink-signing-identity.json");
  const cfg = path.join(dir, "config.yaml");
  fs.writeFileSync(
    cfg,
    ["signing:", `  identity_file: ${idPath}`, "  mode: certificate"].join(
      "\n",
    ),
  );
  const ephemeralHome = (run: number): string =>
    path.join(os.tmpdir(), `psilink-ephemeral-${path.basename(dir)}-${run}`);
  const previousHome = process.env["HOME"];
  try {
    // A different, never-created home on each run, as a container restart
    // gives: what makes the two fingerprints agree is the configured path.
    process.env["HOME"] = ephemeralHome(1);
    const first = await runFingerprint({
      identity: "Party A",
      "config-file": cfg,
    });
    process.env["HOME"] = ephemeralHome(2);
    const second = await runFingerprint({ "config-file": cfg });
    expect(first.thrown).toBeUndefined();
    expect(second.thrown).toBeUndefined();
    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
  }
});

test("--identity-file wins over signing.identity_file in the config", async () => {
  const configPath = path.join(dir, "from-config.json");
  const flagPath = path.join(dir, "from-flag.json");
  const cfg = path.join(dir, "config.yaml");
  fs.writeFileSync(cfg, `signing:\n  identity_file: ${configPath}\n`);
  const { thrown } = await runFingerprint({
    identity: "Party A",
    "identity-file": flagPath,
    "config-file": cfg,
  });
  expect(thrown).toBeUndefined();
  expect(fs.existsSync(flagPath)).toBe(true);
  expect(fs.existsSync(configPath)).toBe(false);
});

test("a ~-relative identity path the operator named is expanded, not refused", async () => {
  // psilink never CHOOSES the home directory; an operator who names one is
  // honoured exactly as they wrote it.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-home-"));
  const previousHome = process.env["HOME"];
  const previousProfile = process.env["USERPROFILE"];
  try {
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    const { thrown } = await runFingerprint({
      identity: "Party A",
      "identity-file": "~/my-signing-identity.json",
    });
    expect(thrown).toBeUndefined();
    expect(fs.existsSync(path.join(home, "my-signing-identity.json"))).toBe(
      true,
    );
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    if (previousProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = previousProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// --- handler: --export-certificate guard -------------------------------------

test("handler refuses to export the certificate over the identity file itself", async () => {
  const idPath = path.join(dir, "id.json");
  // Seed a real identity file (it holds the private key).
  idFile.saveSigningIdentity(idPath, await generateSigningIdentity("Party A"));
  const before = fs.readFileSync(idPath, "utf8");

  const exitSpy = captureProcessExit();
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
  const reloaded = await loadSigningIdentity(idPath);
  expect(reloaded).toBeDefined();
  expect(reloaded?.privateKey).toBeDefined();
});

// --- handler: repeated single-value flag -------------------------------------

test("handler rejects a repeated single-value flag with a usage error (exit 64)", async () => {
  // A repeated --identity (a string flag) is read through singleValue inside the
  // command's try block, so the UsageError it raises is mapped to exit 64 by the
  // existing catch -- the same exit code as the unrecognized-value usage errors.
  const exitSpy = captureProcessExit();
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
  const exitSpy = captureProcessExit();
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
// which can hold an inline credential; the path-only guard must close both a
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
