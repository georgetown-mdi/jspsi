import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import { createHooks } from "hookable";
import { setupGracefulShutdown } from "nitropack/runtime/internal/shutdown";

import { JobManager } from "@jobs/jobManager";
import { registerJobManagerShutdown } from "@jobs/index";

import {
  STUB_CLI_PATH,
  tempDataRoot,
  validIntent,
} from "../../utils/jobFixtures";

import type { JobRecord } from "@jobs/jobManager";
import type { NitroApp } from "nitropack/types";

// A server shutting down while an exchange runs must wait for the CLI child to
// exit: in the image the server is PID 1, so its exit kills the child
// mid-cleanup, and elsewhere the child would outlive it.

const dirs: Array<string> = [];

afterEach(() => {
  globalThis.jobManagerInstance = undefined;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A created scratch directory, removed after the test. */
function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

async function waitForFile(filePath: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A manager running one stub exchange that stays up until signalled, with the
 * child's signal handlers installed before this resolves. `cleanupFile` is
 * written by the child just before its SIGTERM exit.
 */
async function runningJob(
  childEnv: NodeJS.ProcessEnv,
  options: { cancelSigkillGraceMs?: number } = {},
): Promise<{ manager: JobManager; record: JobRecord; cleanupFile: string }> {
  const scratch = scratchDir("shutdown-scratch");
  const readyFile = path.join(scratch, "ready");
  const cleanupFile = path.join(scratch, "cleaned-up");
  const manager = new JobManager({
    dataRoot: scratchDir("shutdown-root"),
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir("shutdown-rvz"),
    ...options,
    childEnv: {
      STUB_FD3_EVENTS: "[]",
      STUB_DELAY_MS: "30000",
      STUB_READY_FILE: readyFile,
      STUB_SIGTERM_CLEANUP_FILE: cleanupFile,
      ...childEnv,
    },
  });
  const record = manager.getJob(await manager.createJob(validIntent()))!;
  await waitForFile(readyFile);
  return { manager, record, cleanupFile };
}

describe("JobManager.shutdown waits for the running child", () => {
  test("it resolves only after the child has finished its SIGTERM cleanup", async () => {
    const { manager, record, cleanupFile } = await runningJob({
      STUB_SIGTERM_CLEANUP_MS: "400",
    });
    const started = Date.now();
    await manager.shutdown();
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(fs.existsSync(cleanupFile)).toBe(true);
    expect(record.terminal).toEqual({
      outcome: "cancelled",
      exitCode: 143,
      signal: null,
    });
  });

  test("it SIGKILLs a child still running after the grace, then resolves on its exit", async () => {
    const { manager, record } = await runningJob(
      { STUB_IGNORE_SIGTERM: "1" },
      { cancelSigkillGraceMs: 200 },
    );
    await manager.shutdown();
    expect(record.terminal).toEqual({
      outcome: "failed",
      exitCode: null,
      signal: "SIGKILL",
    });
  });

  test("a repeated call waits on the same exit", async () => {
    const { manager, record } = await runningJob({
      STUB_SIGTERM_CLEANUP_MS: "200",
    });
    const first = manager.shutdown();
    const second = manager.shutdown();
    expect(second).toBe(first);
    await second;
    expect(record.terminal?.exitCode).toBe(143);
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  test("it resolves at once when no exchange is running", async () => {
    const manager = new JobManager({
      dataRoot: scratchDir("shutdown-idle"),
      binaryPath: STUB_CLI_PATH,
    });
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
});

describe("the server's graceful shutdown", () => {
  test("exits the process only after the running child has exited", async () => {
    const { manager, record, cleanupFile } = await runningJob({
      STUB_SIGTERM_CLEANUP_MS: "400",
    });
    globalThis.jobManagerInstance = manager;

    // Signal listeners already on this process (the test runner's) are set
    // aside, so the emitted SIGTERM reaches only the handlers under test.
    const signals = ["SIGINT", "SIGTERM"] as const;
    const runnerListeners = new Map(
      signals.map((signal) => [signal, process.listeners(signal)]),
    );
    for (const signal of signals) process.removeAllListeners(signal);

    const server = http.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const hooks = createHooks();
      registerJobManagerShutdown(hooks);
      setupGracefulShutdown(server, { hooks } as unknown as NitroApp);

      let childExitedAtProcessExit: boolean | undefined;
      const processExited = new Promise<void>((resolve) => {
        vi.spyOn(process, "exit").mockImplementation((() => {
          childExitedAtProcessExit =
            record.terminal !== null && fs.existsSync(cleanupFile);
          resolve();
        }) as () => never);
      });

      process.emit("SIGTERM", "SIGTERM");
      await processExited;

      expect(childExitedAtProcessExit).toBe(true);
      expect(record.terminal?.exitCode).toBe(143);
    } finally {
      for (const signal of signals) {
        process.removeAllListeners(signal);
        for (const listener of runnerListeners.get(signal)!)
          process.on(signal, listener);
      }
      if (server.listening) server.close();
    }
  }, 15000);
});
