// The child-process harness both apps/web config load checks drive a load
// through: check-web-config-native-load.mjs, which holds the config to the
// TypeScript syntax Node's strip-only type stripping can erase, and
// check-web-config-image-load.mjs, which holds it to the file subset the image's
// builder stage copies.
//
// Each check owns its own measurement -- which loader, which tree, which control
// fixture, and what a result of its own means. What they share is the mechanism
// here: one load per child `node` process, made by re-invoking the check's own
// file in child mode, so the load runs in an environment the check controls and
// a load that ends the process is a result the check reports rather than its own
// death.
//
// The status vocabulary is shared for the same reason: both checks report the
// same word for the same outcome, so a contributor who has read one failure can
// read the other.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** argv[2] that puts a check's own file in child mode: perform one load and
 * exit. */
export const CHILD_FLAG = "--load";

/** The line a child prints when its load threw, with the error's `code` beside
 * it and the detail below it. */
export const FAILURE_MARKER = "psilink-config-load-failed";

/**
 * The outcomes both checks report:
 *
 * - `loads`: the config loaded everywhere the check drove it.
 * - `missing`: there is no config to load.
 * - `control-loaded`: the control fixture loaded, so the check measures nothing
 *   and fails rather than reporting a result it did not make.
 * - `control-failed-otherwise`: the control was refused, but not for the reason
 *   the check is calibrated against, so the result below it would be unsound.
 * - `refused`: the config itself did not load.
 *
 * A check with an outcome of its own names it beside these.
 */
export const LOAD_STATUSES = Object.freeze({
  loads: "loads",
  missing: "missing",
  controlLoaded: "control-loaded",
  controlFailedOtherwise: "control-failed-otherwise",
  refused: "refused",
});

/**
 * Load one config in a child `node` process: re-invoke `childModule` -- the
 * calling check's own `import.meta.url` -- with {@link CHILD_FLAG} and `args`,
 * from `cwd` when one is given, and report `{ ok, code, output }`. `code` is
 * what the child printed beside {@link FAILURE_MARKER}, or null when it printed
 * none; `output` is the child's stdout and stderr, trimmed.
 *
 * NODE_OPTIONS and VITEST are scrubbed from the child environment: a TypeScript
 * loader installed through NODE_OPTIONS would transform the config out from
 * under whatever the check is measuring, and VITEST changes which plugins the
 * web config constructs, so dropping both makes the result the same whether a
 * check runs from a shell or from inside its own vitest suite.
 */
export function loadConfigInChild({ childModule, args, cwd }) {
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.VITEST;

  const result = spawnSync(
    process.execPath,
    [fileURLToPath(childModule), CHILD_FLAG, ...args],
    {
      cwd,
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = [result.stdout, result.stderr]
    .filter((part) => typeof part === "string" && part.trim() !== "")
    .join("\n")
    .trim();
  if (result.error) {
    return { ok: false, code: null, output: result.error.message };
  }
  const marker = output.match(new RegExp(`^${FAILURE_MARKER} (\\S+)$`, "m"));
  return {
    ok: result.status === 0,
    code: marker ? marker[1] : null,
    output,
  };
}

/**
 * Perform one load in child mode: await `load()`, and on a throw print
 * {@link FAILURE_MARKER} with the error's `code`, then `detail(error)`, and exit
 * 1.
 *
 * `detail` is the check's own choice of how much of the throw its parent reads:
 * the stack where the failure has to be located in a module, the message where
 * it names the specifier that would not resolve.
 */
export async function runChildLoad(load, detail) {
  try {
    await load();
  } catch (error) {
    console.error(`${FAILURE_MARKER} ${error?.code ?? "no-code"}`);
    console.error(detail(error));
    process.exit(1);
  }
}
