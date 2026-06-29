import os from "node:os";
import v8 from "node:v8";

/**
 * A point-in-time snapshot of the runtime resource ceilings an exchange runs
 * under. Separated from its formatter ({@link formatRuntimeEnv}) so the gathering
 * (which reads process/os/v8 globals) stays out of the unit test and the
 * formatting -- including its branches -- can be checked from fixed inputs.
 */
export interface RuntimeEnvSnapshot {
  /** `process.version`, e.g. `v26.3.0`. */
  nodeVersion: string;
  /** Host (or VM) physical memory in bytes, from `os.totalmem()`. */
  hostMemBytes: number;
  /**
   * V8's old-space ceiling in bytes (`heap_size_limit`). This is the limit a
   * heap-heavy run aborts at with a `JavaScript heap out of memory` error, so it
   * is the number that matters when reading a failed log.
   */
  heapLimitBytes: number;
  /**
   * The cgroup/OS memory limit in bytes from `process.constrainedMemory()`, or
   * `0` when undetermined. When the process is unconstrained this is a sentinel
   * far larger than {@link hostMemBytes} (cgroup v2 reports "max" as ~2^63), so a
   * "real" container limit is only the case `0 < constrainedMemBytes <
   * hostMemBytes`.
   */
  constrainedMemBytes: number;
}

/** Read the current runtime ceilings from the process/os/v8 globals. */
export function readRuntimeEnv(): RuntimeEnvSnapshot {
  // constrainedMemory has existed since Node 18.15/19.6; guard anyway so a future
  // runtime that drops it degrades to "no limit reported" rather than throwing.
  const constrainedMemBytes =
    typeof process.constrainedMemory === "function"
      ? (process.constrainedMemory() ?? 0)
      : 0;
  return {
    nodeVersion: process.version,
    hostMemBytes: os.totalmem(),
    heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
    constrainedMemBytes,
  };
}

const BYTES_PER_GIB = 1024 * 1024 * 1024;
const gib = (bytes: number): string =>
  `${(bytes / BYTES_PER_GIB).toFixed(1)} GiB`;

/**
 * Render a one-line runtime banner for the start of an exchange log: the Node
 * version and the memory ceilings the run operates under. It states observed
 * facts only -- it deliberately does NOT editorialize (e.g. warn when the V8 heap
 * limit exceeds a container limit), because this tool's real peak is well under a
 * gigabyte, so such a warning would cry wolf on every modestly-sized container.
 * A human reading a failed log connects the numbers; the line just makes sure the
 * numbers are present.
 *
 * The container memory limit is appended only when a real, tighter cgroup limit
 * is detected (`0 < constrainedMemBytes < hostMemBytes`); the unconstrained
 * sentinel and the undetermined `0` both omit it.
 */
export function formatRuntimeEnv(snapshot: RuntimeEnvSnapshot): string {
  const { nodeVersion, hostMemBytes, heapLimitBytes, constrainedMemBytes } =
    snapshot;
  const hasContainerLimit =
    constrainedMemBytes > 0 && constrainedMemBytes < hostMemBytes;
  return (
    `runtime: Node ${nodeVersion}; host memory ${gib(hostMemBytes)}; ` +
    `V8 heap limit ${gib(heapLimitBytes)}` +
    (hasContainerLimit
      ? `; container memory limit ${gib(constrainedMemBytes)}`
      : "")
  );
}
