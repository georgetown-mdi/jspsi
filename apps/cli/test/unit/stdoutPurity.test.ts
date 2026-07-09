import { expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Arguments } from "yargs";
import {
  computeCertificateFingerprint,
  generateSigningIdentity,
} from "@psilink/core";

import { handler as inviteHandler } from "../../src/commands/invite";
import { handler as initHandler } from "../../src/commands/init";
import { handler as fingerprintHandler } from "../../src/commands/fingerprint";
import {
  loadSigningIdentity,
  saveSigningIdentity,
} from "../../src/signingIdentityFile";
import {
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../loggingTestSupport";

// Executable form of the contract issue 206965143 establishes: stdout carries
// only a command's result data, and every diagnostic goes to stderr. These tests
// run a command to completion and assert nothing diagnostic reached stdout -- the
// property a prose note could only claim, not enforce (CONTRIBUTING: encode a
// runtime claim as a check). The result reaches stdout by two mechanisms: a
// direct `process.stdout.write` (the CSV writers) or `console.log` (the invitation
// token, the fingerprint value); diagnostics reach stderr through core's
// diagnostic sink, i.e. `process.stderr.write`. So a run's stdout is captured from
// both `console.log` and `process.stdout.write`, and stderr from
// `process.stderr.write`.
//
// Covered here are the offline, no-network commands whose stdout shape is
// unambiguous: `invite` (a single opaque token), `init` (no stdout result -- its
// result is the written file), and `fingerprint` (the bare fingerprint value;
// board item 207023432 routed its action banner, bound identity, --force
// regeneration warning, and out-of-band sharing instructions off stdout and
// through the logger). The online CSV-result commands route diagnostics through
// the same sink, pinned at the sink level in stderrLogging.test.ts.

const DIAGNOSTIC_PREFIX = /\[(TRACE|DEBUG|INFO|WARN|ERROR)\]/;

snapshotDiagnosticSinkAndLevel();

// Run `fn` with stdout and stderr captured. stdout aggregates both `console.log`
// (which formats and appends a newline, as Node's console does) and any direct
// `process.stdout.write`; stderr captures core's diagnostic-sink writes. process
// output is mocked so nothing leaks into the test runner's own streams, and
// process.exit is stubbed so a handler that exits on its success path does not end
// the worker.
async function runCapturing(
  fn: () => Promise<void>,
): Promise<{ stdout: string; stderr: string }> {
  const { stdoutWrites, stderrWrites, restore } = captureStdio();
  // console.log aggregates into the same stdout stream as process.stdout.write,
  // in emit order, so a stdout assertion sees both mechanisms as one run would.
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      stdoutWrites.push(args.map((a) => String(a)).join(" ") + "\n");
    });
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    await fn();
  } finally {
    logSpy.mockRestore();
    restore();
    exitSpy.mockRestore();
  }
  return { stdout: stdoutWrites.join(""), stderr: stderrWrites.join("") };
}

test("offline invite: stdout is the invitation token only, diagnostics on stderr", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-stdout-invite-"));
  try {
    const input = path.join(dir, "in.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,date_of_birth\nAda,Lovelace,1815-12-10\n",
    );
    const { stdout, stderr } = await runCapturing(() =>
      inviteHandler({
        _: [],
        $0: "psilink",
        args: [input],
        "config-file": path.join(dir, "psilink.yaml"),
        "key-file": path.join(dir, ".psilink.key"),
        identity: "Tester",
        "log-level": "info",
        record: false,
      } as unknown as Arguments),
    );

    // stdout is exactly one line -- the opaque token -- with no diagnostic prefix,
    // no whitespace (prose would carry spaces), and none of the guidance the
    // command also emits.
    const stdoutLines = stdout.split("\n").filter((l) => l.length > 0);
    expect(stdoutLines).toHaveLength(1);
    expect(stdout).not.toMatch(DIAGNOSTIC_PREFIX);
    expect(stdout).not.toContain(" ");
    expect(stdout).not.toContain("Share this invitation");
    expect(stdout).not.toContain("wrote");

    // The guidance that surrounds the token is diagnostic, so it is on stderr.
    expect(stderr).toContain("Share this invitation");
    expect(stderr).toMatch(DIAGNOSTIC_PREFIX);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init: stdout is empty (its result is the written file), diagnostics on stderr", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-stdout-init-"));
  try {
    const configFile = path.join(dir, "psilink.yaml");
    const { stdout, stderr } = await runCapturing(() =>
      initHandler({
        _: [],
        $0: "psilink",
        "config-file": configFile,
      } as unknown as Arguments),
    );

    // init's result is the file it writes, so stdout carries nothing at all.
    expect(stdout).toBe("");
    // The "wrote a configuration template to ..." notice is a diagnostic on stderr.
    expect(fs.existsSync(configFile)).toBe(true);
    expect(stderr).toContain("wrote a configuration template");
    expect(stderr).toMatch(DIAGNOSTIC_PREFIX);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fingerprint (created): stdout is the bare fingerprint value, diagnostics on stderr", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-stdout-fp-new-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir); // hermetic: no ambient ./psilink.yaml is consulted
    const idPath = path.join(dir, "id.json");
    const { stdout, stderr } = await runCapturing(() =>
      fingerprintHandler({
        _: [],
        $0: "psilink",
        "identity-file": idPath,
        identity: "Party A, Agency A",
        "log-level": "info",
        force: false,
      } as unknown as Arguments),
    );

    // stdout is exactly the fingerprint of the identity just created: the bare
    // value and a newline, with no diagnostic prefix, no spaces (the value is
    // base64url), and none of the banner/identity/instruction prose the command
    // also emits.
    const created = loadSigningIdentity(idPath);
    if (created === undefined) throw new Error("identity was not created");
    const fingerprint = await computeCertificateFingerprint(
      created.certificate,
    );
    expect(stdout).toBe(fingerprint + "\n");
    expect(stdout).not.toMatch(DIAGNOSTIC_PREFIX);
    expect(stdout).not.toContain(" ");
    expect(stdout).not.toContain("signing identity");
    expect(stdout).not.toContain("Identity:");
    expect(stdout).not.toContain("Share the fingerprint");

    // The action banner, the bound identity, and the sharing instructions are
    // diagnostics, so they land on stderr (naming the stream each is on, not just
    // asserting its absence from stdout, so dropping a line entirely still fails).
    expect(stderr).toContain("Created signing identity");
    expect(stderr).toContain("Identity:");
    expect(stderr).toContain("Share the fingerprint");
    expect(stderr).toMatch(DIAGNOSTIC_PREFIX);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fingerprint (loaded): stdout is the bare fingerprint value, diagnostics on stderr", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-stdout-fp-load-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir); // hermetic: no ambient ./psilink.yaml is consulted
    const idPath = path.join(dir, "id.json");
    // Seed an existing identity so a plain (no --force) run loads it (Loaded)
    // rather than creating or regenerating; report() runs the same on this path,
    // so a stray console.log added only to the load path is caught here.
    saveSigningIdentity(idPath, generateSigningIdentity("Party A"));

    const { stdout, stderr } = await runCapturing(() =>
      fingerprintHandler({
        _: [],
        $0: "psilink",
        "identity-file": idPath,
        "log-level": "info",
        force: false,
      } as unknown as Arguments),
    );

    // stdout is exactly the loaded identity's fingerprint (loading does not
    // change it), bare and alone.
    const loaded = loadSigningIdentity(idPath);
    if (loaded === undefined) throw new Error("identity was not loaded");
    const fingerprint = await computeCertificateFingerprint(loaded.certificate);
    expect(stdout).toBe(fingerprint + "\n");
    expect(stdout).not.toMatch(DIAGNOSTIC_PREFIX);
    expect(stdout).not.toContain(" ");
    expect(stdout).not.toContain("signing identity");
    expect(stdout).not.toContain("Share the fingerprint");

    // The load banner, the bound identity, and the sharing instructions are
    // diagnostics on stderr.
    expect(stderr).toContain("Loaded signing identity");
    expect(stderr).toContain("Identity:");
    expect(stderr).toContain("Share the fingerprint");
    expect(stderr).toMatch(DIAGNOSTIC_PREFIX);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fingerprint (regenerated): stdout is the new bare fingerprint value, the --force warning on stderr", async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "psilink-stdout-fp-regen-"),
  );
  const cwd = process.cwd();
  try {
    process.chdir(dir); // hermetic: no ambient ./psilink.yaml is consulted
    const idPath = path.join(dir, "id.json");
    // Seed an existing identity so the --force run re-keys it (Regenerated).
    saveSigningIdentity(idPath, generateSigningIdentity("Party A"));

    const { stdout, stderr } = await runCapturing(() =>
      fingerprintHandler({
        _: [],
        $0: "psilink",
        "identity-file": idPath,
        "log-level": "info",
        force: true,
      } as unknown as Arguments),
    );

    // stdout is exactly the NEW fingerprint (the re-keyed identity now on disk),
    // nothing else.
    const regenerated = loadSigningIdentity(idPath);
    if (regenerated === undefined)
      throw new Error("identity was not regenerated");
    const fingerprint = await computeCertificateFingerprint(
      regenerated.certificate,
    );
    expect(stdout).toBe(fingerprint + "\n");
    expect(stdout).not.toMatch(DIAGNOSTIC_PREFIX);
    expect(stdout).not.toContain(" ");
    expect(stdout).not.toContain("NEW identity");

    // The regeneration warning -- which must stay visible, not be swallowed -- and
    // the "Regenerated" banner land on stderr.
    expect(stderr).toContain("Regenerated signing identity");
    expect(stderr).toContain("NEW identity with a NEW fingerprint");
    expect(stderr).toMatch(/\[WARN\]/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
