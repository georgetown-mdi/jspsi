import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * The built `psilink` entry this suite drives. The CLI is a separate workspace
 * apps/web may not import, so the interop party on that side of the wire is the
 * real command-line program, spawned exactly as the console's job driver spawns
 * it (apps/web/src/jobs/cliDriver.ts).
 */
const cliEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../apps/cli/dist/index.js",
);

/** Whether the CLI has been built. `npm run build -w apps/cli` produces it; the
 * suite skips rather than failing on a tree that has not. */
export const cliIsBuilt = existsSync(cliEntry);

/** How one `psilink` invocation ended. */
export interface CliRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** stdout and stderr interleaved in arrival order, which is what an operator
   * reads and what the invitation is looked for in. */
  output: string;
  /** The run outlived its deadline and was killed. */
  timedOut: boolean;
}

/** Spawn one `psilink` invocation and collect everything it wrote. */
export function startCli(params: {
  args: Array<string>;
  cwd: string;
  timeoutMs: number;
}): Promise<CliRun> {
  const { args, cwd, timeoutMs } = params;
  return new Promise<CliRun>((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (output += chunk));
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(deadline);
      resolve({ exitCode, signal, output, timedOut });
    });
  });
}

/** Fail with everything the run wrote, so a broken invocation reports its own
 * cause rather than an assertion on a downstream artifact. */
export function expectCliSucceeded(run: CliRun, what: string): void {
  if (run.exitCode === 0) return;
  throw new Error(
    `psilink ${what} exited ${String(run.exitCode)}` +
      (run.timedOut ? " (killed on its deadline)" : "") +
      `\n${run.output}`,
  );
}

/**
 * The invitation an offline `psilink invite` printed.
 *
 * Matched by shape rather than by the sentence above it: the invitation is the
 * one base64url run long enough to be a token, so the extraction survives a
 * rewording of the operator copy around it. More than one is an ambiguity
 * and is refused rather than guessed at.
 */
export function invitationFrom(run: CliRun): string {
  const candidates = run.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9_-]{200,}$/.test(line));
  if (candidates.length !== 1)
    throw new Error(
      `expected exactly one invitation in the invite output, found ` +
        `${candidates.length}\n${run.output}`,
    );
  return candidates[0];
}

/** The file-drop connection block a party's configuration names. */
function fileDropConnectionBlock(params: {
  dropDir: string;
  pollIntervalMs: number;
  peerTimeoutMs: number;
}): string {
  return [
    "connection:",
    "  channel: filedrop",
    `  path: ${params.dropDir}`,
    "  options:",
    `    poll_interval_ms: ${params.pollIntervalMs}`,
    `    peer_timeout_ms: ${params.peerTimeoutMs}`,
    "",
  ].join("\n");
}

/** Whether a configuration already names this file-drop directory, so the
 * caller can tell an endpoint the partner's invitation held from one the
 * operator had to supply. */
export function namesFileDrop(configPath: string, dropDir: string): boolean {
  const config = readFileSync(configPath, "utf8");
  return (
    config.includes("channel: filedrop") && config.includes(`path: ${dropDir}`)
  );
}

/**
 * Fill in the configuration's connection block, the step `psilink invite` and
 * `psilink accept` tell the operator to take when the invitation named no
 * endpoint of its own ("fill in the connection block in ./psilink.yaml before
 * running 'psilink exchange'").
 *
 * A line-scoped rewrite rather than a YAML round-trip: the file is one psilink
 * just wrote, `connection` is its first top-level block, and re-emitting the
 * document through a parser would rewrite every other block as a side effect of
 * replacing one.
 */
export function fillInFileDropConnection(params: {
  configPath: string;
  dropDir: string;
  pollIntervalMs: number;
  peerTimeoutMs: number;
}): void {
  const { configPath } = params;
  const lines = readFileSync(configPath, "utf8").split("\n");
  const start = lines.findIndex((line) => line === "connection:");
  if (start === -1)
    throw new Error(`${configPath} carries no connection block to fill in`);
  let end = start + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
  writeFileSync(
    configPath,
    [
      ...lines.slice(0, start),
      fileDropConnectionBlock(params).trimEnd(),
      ...lines.slice(end),
    ].join("\n"),
  );
}

/** The matched (own row, partner row) pairs a party's result CSV holds. */
export function pairsFromResultCsv(
  resultPath: string,
): Array<[number, number]> {
  const [header, ...rows] = readFileSync(resultPath, "utf8").trim().split("\n");
  if (header !== "row_id,their_row_id")
    throw new Error(`unexpected result header: ${String(header)}`);
  return rows
    .map((row): [number, number] => {
      const [own, partner] = row.split(",");
      return [Number(own), Number(partner)];
    })
    .sort((a, b) => a[0] - b[0]);
}
