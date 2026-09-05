import { describe, expect, test } from "vitest";

import { nodeCommandRunner } from "../../../src/doctor/runner";

// Driven against a real child process rather than a mock: the properties that
// make this boundary safe -- no shell, a bounded wait, and a child environment
// with the password removed -- are properties of the spawn, so only a spawn can
// establish them.

const NODE = process.execPath;
const RUN_TIMEOUT_MS = 20_000;

function evaluate(source: string): string[] {
  return ["-e", source];
}

describe("the process runner", () => {
  test("captures stdout and stderr together with the exit status", async () => {
    const result = await nodeCommandRunner.run(
      NODE,
      evaluate(
        "process.stdout.write('out\\n');process.stderr.write('err\\n');process.exit(3)",
      ),
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    expect(result.code).toBe(3);
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
    expect(result.timedOut).toBe(false);
    expect(result.spawnErrorCode).toBeUndefined();
  });

  test("passes arguments as an array, so shell syntax in one stays data", async () => {
    // The server, share, path, username, and domain are operator input and land
    // in these arguments; a shell-interpolated command line would execute what
    // is only meant to be a folder name.
    const hostile = "q3;touch /tmp/psilink-doctor-should-not-exist";
    const result = await nodeCommandRunner.run(
      NODE,
      [...evaluate("process.stdout.write(process.argv[1])"), hostile],
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    expect(result.output).toBe(hostile);
  });

  test("reports a binary that is not installed as a spawn failure, not an exit", async () => {
    const result = await nodeCommandRunner.run(
      "psilink-no-such-binary-exists",
      [],
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    expect(result.spawnErrorCode).toBe("ENOENT");
    expect(result.code).toBeNull();
  });

  test("kills a child that never answers, and says the wait ran out", async () => {
    const result = await nodeCommandRunner.run(
      NODE,
      evaluate("setInterval(() => {}, 1000)"),
      { timeoutMs: 250 },
    );
    expect(result.timedOut).toBe(true);
  });

  test("removes the password variable from the child's environment", async () => {
    process.env["SMB_PASS"] = "must-not-reach-the-child";
    try {
      const result = await nodeCommandRunner.run(
        NODE,
        evaluate(
          "process.stdout.write(String(process.env.SMB_PASS)+'|'+String(process.env.PATH !== undefined))",
        ),
        { timeoutMs: RUN_TIMEOUT_MS },
      );
      // The password is gone; the rest of the environment the child needs is not.
      expect(result.output).toBe("undefined|true");
    } finally {
      delete process.env["SMB_PASS"];
    }
  });

  test("runs the child in the working directory it is given", async () => {
    const result = await nodeCommandRunner.run(
      NODE,
      evaluate("process.stdout.write(process.cwd())"),
      { cwd: __dirname, timeoutMs: RUN_TIMEOUT_MS },
    );
    expect(result.output).toContain("unit");
  });

  test("bounds the output it captures from a torrential child", async () => {
    const result = await nodeCommandRunner.run(
      NODE,
      evaluate(
        "for (let i = 0; i < 4000; i++) process.stdout.write('x'.repeat(1000))",
      ),
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    expect(result.output.length).toBeLessThanOrEqual(256 * 1024);
  });
});
