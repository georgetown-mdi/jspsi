import { describe, expect, test } from "vitest";

import {
  formatRuntimeEnv,
  readRuntimeEnv,
  type RuntimeEnvSnapshot,
} from "../../src/util/runtimeEnv";

const GIB = 1024 * 1024 * 1024;

const base: RuntimeEnvSnapshot = {
  nodeVersion: "v26.3.0",
  hostMemBytes: 16 * GIB,
  heapLimitBytes: 4 * GIB,
  constrainedMemBytes: 0,
};

describe("formatRuntimeEnv", () => {
  test("reports node version, host memory, and V8 heap limit", () => {
    const line = formatRuntimeEnv(base);
    expect(line).toContain("Node v26.3.0");
    expect(line).toContain("host memory 16.0 GiB");
    expect(line).toContain("V8 heap limit 4.0 GiB");
  });

  test("omits the container limit when undetermined (0)", () => {
    expect(formatRuntimeEnv(base)).not.toContain("container memory limit");
  });

  test("omits the container limit for the unconstrained sentinel", () => {
    // cgroup v2's "max" surfaces as UINT64_MAX (~2^64), far above host memory.
    const line = formatRuntimeEnv({
      ...base,
      constrainedMemBytes: 2 ** 64,
    });
    expect(line).not.toContain("container memory limit");
  });

  test("appends a real, tighter container limit", () => {
    const line = formatRuntimeEnv({ ...base, constrainedMemBytes: 2 * GIB });
    expect(line).toContain("container memory limit 2.0 GiB");
  });

  test("treats a limit equal to host memory as no tighter constraint", () => {
    const line = formatRuntimeEnv({
      ...base,
      constrainedMemBytes: base.hostMemBytes,
    });
    expect(line).not.toContain("container memory limit");
  });
});

describe("readRuntimeEnv", () => {
  test("snapshots plausible live values", () => {
    const snap = readRuntimeEnv();
    expect(snap.nodeVersion).toBe(process.version);
    expect(snap.hostMemBytes).toBeGreaterThan(0);
    expect(snap.heapLimitBytes).toBeGreaterThan(0);
    expect(snap.constrainedMemBytes).toBeGreaterThanOrEqual(0);
  });
});
