import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProvidedContext } from "vitest";

import { INTEGRATION_CONSOLE_ALLOWLIST } from "../integration/consoleAllowlist";
import {
  selectedBackend,
  selectedNativeProfile,
  startSelectedSftpServer,
} from "./index";

// Structural slice of vitest's globalSetup context: only `provide` is used, and
// typing it inline keeps this robust to where vitest re-exports the full context
// type across versions.
interface GlobalSetupContext {
  provide<T extends keyof ProvidedContext & string>(
    key: T,
    value: ProvidedContext[T],
  ): void;
}

// Vitest globalSetup for the `integration` project: starts the selected SFTP
// test server before the suite, hands its connection details and served
// directory to the test workers through `provide`, and stops it on teardown, so
// `npm run test:integration` is self-contained. Only the integration project
// references this file, so the unit project (and `npm run test`) never starts a
// server.
export default async function setup({
  provide,
}: GlobalSetupContext): Promise<() => Promise<void>> {
  const server = await startSelectedSftpServer();
  provide("sftpServer", server.handle);

  // Suite-wide sink for the console sentinel's dead-entry report. Each file's
  // worker appends the allowlist matchers it exercised (via the setup file's
  // afterAll); the teardown below reads the union and reports any matcher that
  // NO file fired across the whole run -- the `forks` pool isolates files
  // per-process, so a per-file "unused" view would be misleading.
  const sentinelSinkDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "psilink-console-sentinel-"),
  );
  const sentinelSink = path.join(sentinelSinkDir, "matched-ids.log");
  fs.writeFileSync(sentinelSink, "");
  provide("consoleSentinelSink", sentinelSink);
  const backend = selectedBackend();
  // Surface the native profile (other than the default baseline) so a CI leg's
  // log makes clear which hardened configuration ran.
  const profile =
    backend === "native" ? selectedNativeProfile() : ("baseline" as const);
  const label =
    backend === "native" && profile !== "baseline"
      ? `${backend} (${profile})`
      : backend;
  console.log(
    `[sftp-test-server] ${label} backend listening on ` +
      `${server.handle.host}:${server.handle.port}`,
  );
  return async () => {
    await server.stop();
    reportDeadAllowlistEntries(sentinelSink);
    fs.rmSync(sentinelSinkDir, { recursive: true, force: true });
  };
}

// Reports console-sentinel allowlist matchers that no file fired during the run,
// so the allowlist cannot silently accumulate dead entries. Advisory (a warning,
// not a failure): a single-file run legitimately fires only a few, and an entry
// kept against a known-intermittent diagnostic is a judgement call for review,
// not a hard gate. Runs in the main process, where the sentinel is not
// installed, so this output does not trip it.
function reportDeadAllowlistEntries(sink: string): void {
  let matched: Set<string>;
  try {
    matched = new Set(
      fs
        .readFileSync(sink, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  } catch {
    return;
  }
  const dead = INTEGRATION_CONSOLE_ALLOWLIST.filter(
    (entry) => !matched.has(entry.id),
  );
  if (dead.length === 0) return;
  console.warn(
    `[console-sentinel] ${dead.length} allowlist matcher(s) never fired this ` +
      `run; prune them if permanently dormant, or confirm the intended output ` +
      `still occurs:\n` +
      dead.map((entry) => `  - ${entry.id}: ${entry.reason}`).join("\n"),
  );
}
