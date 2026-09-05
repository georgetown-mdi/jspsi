import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  END_OF_FILE,
  RESTORE_SIGNALS,
  firstDifference,
  firstDifferingLine,
  withRestoreOnSignal,
} from "./regenerationChecks.mjs";

// The signal cases run in a child process, by design: a restore that
// re-raises kills the process it runs in, which inside a vitest worker would
// take the rest of the suite with it. The child is the real thing -- a real
// SIGINT or SIGTERM, this module's real handler -- and what it leaves behind is
// a marker file and its own exit signal.
const MODULE_URL = new URL("./regenerationChecks.mjs", import.meta.url).href;
// A child that ignored its signal would run its two-second body out and exit on
// its own, so the timeout is a safety check for a child that hangs instead. The case
// timeout is the wider of the two, leaving the assertions to report a failure
// rather than the runner reporting a timeout over them.
const CHILD_TIMEOUT_MS = 10_000;
const CASE_TIMEOUT_MS = 15_000;

describe("firstDifference", () => {
  it("locates the first changed line and includes both sides", () => {
    expect(firstDifference("a\nb\nc\n", "a\nB\nc\n")).toEqual({
      line: 2,
      committed: "b",
      produced: "B",
    });
  });

  it("reports the trailing empty line when one file has more lines", () => {
    expect(firstDifference("a\nb\n", "a\nb\nc\n")).toEqual({
      line: 3,
      committed: "",
      produced: "c",
    });
  });

  it("reports the end of a side that has run out of lines", () => {
    expect(firstDifference("a\nb", "a\nb\nc")).toEqual({
      line: 3,
      committed: END_OF_FILE,
      produced: "c",
    });
  });

  it("is null for identical text", () => {
    expect(firstDifference("a\nb\n", "a\nb\n")).toBeNull();
  });
});

describe("firstDifferingLine", () => {
  it("is the line number alone", () => {
    expect(firstDifferingLine("a\nb\nc\n", "a\nB\nc\n")).toBe(2);
  });

  it("is null rather than undefined for identical text", () => {
    expect(firstDifferingLine("a\nb\n", "a\nb\n")).toBeNull();
  });
});

describe("withRestoreOnSignal on an ordinary exit", () => {
  it("returns what a synchronous body returns, restoring after it", () => {
    const order = [];
    const value = withRestoreOnSignal(
      () => order.push("restore"),
      () => {
        order.push("body");
        return "returned";
      },
    );
    expect(value).toBe("returned");
    expect(order).toEqual(["body", "restore"]);
  });

  it("restores before a synchronous throw propagates", () => {
    const order = [];
    expect(() =>
      withRestoreOnSignal(
        () => order.push("restore"),
        () => {
          throw new Error("body failed");
        },
      ),
    ).toThrow("body failed");
    expect(order).toEqual(["restore"]);
  });

  it("waits for an async body to settle before restoring", async () => {
    const order = [];
    let release;
    const pending = withRestoreOnSignal(
      () => order.push("restore"),
      async () => {
        await new Promise((resolve) => {
          release = resolve;
        });
        order.push("body");
        return "resolved";
      },
    );
    expect(order).toEqual([]);
    release();
    await expect(pending).resolves.toBe("resolved");
    expect(order).toEqual(["body", "restore"]);
  });

  it("restores before a rejection propagates", async () => {
    const order = [];
    const pending = withRestoreOnSignal(
      () => order.push("restore"),
      async () => {
        throw new Error("body rejected");
      },
    );
    await expect(pending).rejects.toThrow("body rejected");
    expect(order).toEqual(["restore"]);
  });

  it("holds a handler for the run and leaves none behind", () => {
    const before = RESTORE_SIGNALS.map((signal) =>
      process.listenerCount(signal),
    );
    const during = withRestoreOnSignal(
      () => {},
      () => RESTORE_SIGNALS.map((signal) => process.listenerCount(signal)),
    );
    expect(during).toEqual(before.map((count) => count + 1));
    expect(
      RESTORE_SIGNALS.map((signal) => process.listenerCount(signal)),
    ).toEqual(before);
  });

  it("propagates a throw from the restore itself", () => {
    expect(() =>
      withRestoreOnSignal(
        () => {
          throw new Error("could not restore");
        },
        () => "returned",
      ),
    ).toThrow("could not restore");
  });
});

describe("withRestoreOnSignal on a signal", () => {
  let workspace;

  const runChild = (source, args = []) => {
    const script = join(workspace, "child.mjs");
    writeFileSync(script, source.replaceAll("<module>", MODULE_URL));
    const marker = join(workspace, "marker.txt");
    const child = spawnSync(process.execPath, [script, marker, ...args], {
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
    });
    return { child, marker: readFileSync(marker, "utf8") };
  };

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "regeneration-checks-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("arms the two signals an interrupted run arrives as", () => {
    expect(RESTORE_SIGNALS).toEqual(["SIGINT", "SIGTERM"]);
  });

  // The body would run for two more seconds and record that it finished; a
  // marker holding only the restore is the handler having cut it short.
  const INTERRUPTED = `
import { appendFileSync, writeFileSync } from "node:fs";
import { withRestoreOnSignal } from "<module>";

const [, , marker, signal] = process.argv;
writeFileSync(marker, "");
await withRestoreOnSignal(
  () => appendFileSync(marker, "restored\\n"),
  async () => {
    process.kill(process.pid, signal);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    appendFileSync(marker, "body-finished\\n");
  },
);
`;

  for (const signal of RESTORE_SIGNALS) {
    it(
      `restores and re-raises ${signal}, so the run still dies of it`,
      () => {
        const { child, marker } = runChild(INTERRUPTED, [signal]);
        expect(marker).toBe("restored\n");
        expect(child.signal).toBe(signal);
        expect(child.status).toBeNull();
      },
      CASE_TIMEOUT_MS,
    );
  }

  // The gap the handlers do not close, as a case rather than a claim in a
  // comment: the grandchild signals its grandparent and then holds the
  // execFileSync open, so the handler cannot run until that call has returned.
  const SIGNALLED_MID_RUN = `
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { withRestoreOnSignal } from "<module>";

const [, , marker] = process.argv;
writeFileSync(marker, "");
await withRestoreOnSignal(
  () => appendFileSync(marker, "restored\\n"),
  async () => {
    execFileSync(process.execPath, [
      "-e",
      \`process.kill(process.ppid, "SIGINT");
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);\`,
    ]);
    appendFileSync(marker, "generator-returned\\n");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    appendFileSync(marker, "body-finished\\n");
  },
);
`;

  it(
    "cannot restore until a synchronous generator run has returned",
    () => {
      const { child, marker } = runChild(SIGNALLED_MID_RUN);
      expect(marker).toBe("generator-returned\nrestored\n");
      expect(child.signal).toBe("SIGINT");
    },
    CASE_TIMEOUT_MS,
  );
});
