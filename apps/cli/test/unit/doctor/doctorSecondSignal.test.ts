import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Starting the child and transpiling what it imports takes seconds on a loaded
// machine; the child's delete is held for a minute, so the kill bound sits
// between the two and a child still spinning on its own signal is stopped.
const CHILD_KILL_MS = 30_000;
const TEST_TIMEOUT_MS = 40_000;
const PROMPT_EXIT_MS = 5_000;

interface ChildExit {
  signal: NodeJS.Signals | null;
  exitedAt: number;
  stdout: string;
}

function runSecondSignalProbe(): Promise<ChildExit> {
  const probe = fileURLToPath(
    new URL("../../doctorSecondSignalProbe.ts", import.meta.url),
  );
  const child = spawn(process.execPath, ["--import=tsx", probe], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    stdio: ["ignore", "pipe", "inherit"],
    timeout: CHILD_KILL_MS,
    killSignal: "SIGKILL",
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (_code, signal) =>
      resolve({ signal, exitedAt: Date.now(), stdout }),
    );
  });
}

function reported(stdout: string, key: string): string {
  const line = stdout.split("\n").find((entry) => entry.startsWith(`${key} `));
  if (line === undefined) throw new Error(`the child reported no ${key}`);
  return line.slice(key.length + 1);
}

// Windows has no signal a process can catch from itself: process.kill ends it.
test.skipIf(process.platform === "win32")(
  "a second interrupt exits on that signal at once and removes the credentials file",
  async () => {
    const { signal, exitedAt, stdout } = await runSecondSignalProbe();
    expect(signal).toBe("SIGTERM");
    const sentAt = Number(reported(stdout, "second-signal"));
    expect(exitedAt - sentAt).toBeLessThan(PROMPT_EXIT_MS);
    expect(fs.existsSync(reported(stdout, "credentials"))).toBe(false);
  },
  TEST_TIMEOUT_MS,
);
