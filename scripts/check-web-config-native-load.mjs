#!/usr/bin/env node
// apps/web/vite.config.ts native-loadability check, run by static_checks.yaml on
// every PR.
//
// The web config is TypeScript, and two paths evaluate it with no transform in
// front: Vite's `configLoader: "native"`, and a plain `node` import of the file.
// Both hand it to Node's strip-only type stripping, which erases annotations and
// nothing else -- so any TypeScript construct that needs code GENERATED for it is
// refused outright with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. Driven against Node
// 26.7, that is: a constructor parameter property, an `enum` (`const` or not), a
// non-`declare` `namespace`, and an `import x = require(...)` alias. Modifiers
// that erase -- `private`, `readonly`, `abstract`, `declare` -- do not, which is
// why the rewrite below is a rewrite and not a deletion. That list is written
// for a reader; what the check enforces is the measurement, not the list.
//
// The refusal is a parse error in the module that holds the construct, so it
// fires for anything anywhere in the config's transitive import graph, not just
// the config file itself -- and the graph reaches app source
// (`src/utils/serverConfig.ts` -> `src/utils/configManager.ts`,
// `src/httpServer.ts`), which nothing else holds to erasable syntax. Neither
// typecheck nor lint nor a bundling `vite build` sees it, since every one of
// those runs a real TypeScript transform.
//
// So this check drives the two load paths themselves and fails when either one
// refuses the config.
//
// Two properties the implementation is built around:
//
//   1. FAILS CLOSED when the load path stopped being strip-only. A check that
//      only loaded the real config would pass forever, detecting nothing, if a
//      future Vite made "native" a transforming loader or Node grew a transform
//      of its own. So each loader is first driven against a CONTROL fixture that
//      is nothing but a parameter property, and a control that LOADS is a
//      failure rather than a pass: the measurement is gone, and the check says
//      so instead of reporting a result it did not make.
//   2. MEASURED, NOT MODELLED. Nothing here parses TypeScript or predicts what
//      Node would refuse (CLAUDE.md, Agent conventions). It spawns the real
//      loaders in child processes and reads their exit status.
//
// The two loaders overlap: Vite's native loader imports the config through Node,
// so today the plain-import leg is the narrower of the two. It is driven anyway,
// because that overlap is a property of the current Vite and not a guarantee --
// if a later "native" grows a transform, the plain leg is the one still
// measuring Node's own behavior, and it is what a contributor running
// `node apps/web/vite.config.ts` gets.
//
// What this check cannot see:
//   - It measures the LOCALLY INSTALLED Vite and the running Node. It says
//     nothing about another version of either.
//   - It loads the config with `command: "serve"`. A construct reached only from
//     a branch some other command takes is outside what this drives.
//   - It is about SYNTAX Node refuses, not about the config being correct: a
//     config that loads here can still be wrong for the dev server or the build.
//   - It scrubs NODE_OPTIONS and VITEST from the child environment so the
//     measurement does not depend on who invoked it. A TypeScript loader
//     installed by any other means -- a `node --import` in a wrapper, a
//     registered hook in an inherited env var this does not name -- would still
//     transform the config out from under the control fixture, which is why the
//     control's rejection is asserted rather than assumed.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The config this check guards, relative to the repository root. */
export const WEB_CONFIG = "apps/web/vite.config.ts";

/** Node's refusal of a construct strip-only type stripping cannot erase. */
export const REJECTION_CODE = "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX";

/** argv[2] that puts this file in child mode: perform one load and exit. */
const CHILD_FLAG = "--load";

/** The line a child prints before its stack when the load threw. */
const FAILURE_MARKER = "psilink-config-load-failed";

async function loadThroughVite(configFile, viteFrom) {
  // Resolve Vite from the web app rather than from this script or from the file
  // being loaded: the workspace copy the web config would really be loaded by is
  // the one to drive, and the control fixture -- which sits outside the
  // repository and so resolves no bare specifier of its own -- has to be driven
  // through that same copy for its refusal to say anything about this one.
  const require = createRequire(pathToFileURL(viteFrom));
  const { loadConfigFromFile } = await import(
    pathToFileURL(require.resolve("vite")).href
  );
  await loadConfigFromFile(
    { command: "serve", mode: "development" },
    configFile,
    dirname(configFile),
    // Silent: the loader's own "failed to load config from ..." line adds
    // nothing to the error this check reports, and would be the first thing a
    // contributor read on an unrelated failure.
    "silent",
    undefined,
    "native",
  );
}

async function loadThroughNode(configFile) {
  await import(pathToFileURL(configFile).href);
}

/**
 * The load paths driven, in the order they run. `label` is how a failure names
 * the leg to a contributor.
 */
export const LOADERS = [
  {
    id: "vite-native",
    label: 'Vite\'s `configLoader: "native"`',
    load: loadThroughVite,
  },
  {
    id: "node-import",
    label: "a plain `node` import",
    load: loadThroughNode,
  },
];

/**
 * Write the control fixture into `directory`: a config whose import graph holds
 * one constructor parameter property and nothing else. Both loaders must refuse
 * it, or they are no longer strip-only and this check measures nothing.
 *
 * The `package.json` pins the module format, so the fixture cannot pick up a
 * `type` from whatever directory the temp root happens to sit under.
 */
export function writeStripOnlyControl(directory) {
  writeFileSync(join(directory, "package.json"), '{ "type": "module" }\n');
  writeFileSync(
    join(directory, "parameterProperty.ts"),
    "export class ParameterProperty {\n" +
      "  constructor(private readonly value: string) {}\n" +
      "}\n",
  );
  const configFile = join(directory, "vite.config.ts");
  writeFileSync(
    configFile,
    'import { ParameterProperty } from "./parameterProperty.ts";\n' +
      "\n" +
      "export default { define: { probe: ParameterProperty.name } };\n",
  );
  return configFile;
}

/**
 * Load `configFile` through the loader named by `loaderId`, in a child `node`
 * process, and report `{ok, code, output}` -- `code` being the `code` property
 * of whatever the load threw, or null on success. `viteFrom` is the file Vite is
 * resolved from (see loadThroughVite); the plain-import loader ignores it.
 */
export function loadInChildProcess(loaderId, configFile, viteFrom) {
  const environment = { ...process.env };
  // A TypeScript loader in NODE_OPTIONS would transform the config and hide
  // exactly what this measures; VITEST changes which plugins the web config
  // constructs, so dropping it makes the result the same whether this check runs
  // from a shell or from inside its own vitest suite.
  delete environment.NODE_OPTIONS;
  delete environment.VITEST;

  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      CHILD_FLAG,
      loaderId,
      configFile,
      viteFrom,
    ],
    { encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"] },
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
 * Drive both load paths against the control fixture and then against the web
 * config, and report `{ok, status, message}`.
 *
 * Statuses: `loads` (ok), `missing`, `control-loaded`,
 * `control-failed-otherwise`, `refused`.
 *
 * `load` is injectable so a test can drive the outcomes without spawning.
 */
export function checkWebConfigNativeLoad({
  root,
  load = loadInChildProcess,
} = {}) {
  const configFile = resolve(root, WEB_CONFIG);
  if (!existsSync(configFile)) {
    return {
      ok: false,
      status: "missing",
      message: `${WEB_CONFIG} is absent, so there is nothing to load.`,
    };
  }

  const controlDirectory = mkdtempSync(join(tmpdir(), "web-config-control-"));
  try {
    const control = writeStripOnlyControl(controlDirectory);
    for (const loader of LOADERS) {
      const result = load(loader.id, control, configFile);
      if (result.ok) {
        return {
          ok: false,
          status: "control-loaded",
          message: `${loader.label} loaded a config whose import graph holds a TypeScript parameter property, which strip-only type stripping refuses. That load path is no longer strip-only, so driving ${WEB_CONFIG} through it would prove nothing about the syntax it may contain. This check fails rather than report a measurement it did not make -- re-establish what the leg measures, or retire it, in scripts/check-web-config-native-load.mjs.`,
        };
      }
      if (result.code !== REJECTION_CODE) {
        return {
          ok: false,
          status: "control-failed-otherwise",
          message: `${loader.label} refused the control fixture, but with ${result.code ?? "no error code"} rather than ${REJECTION_CODE}, so it is not the strip-only refusal this check is calibrated against and the result below it would be unsound:\n\n${result.output}`,
        };
      }
    }
  } finally {
    rmSync(controlDirectory, { recursive: true, force: true });
  }

  for (const loader of LOADERS) {
    const result = load(loader.id, configFile, configFile);
    if (!result.ok) {
      const cause =
        result.code === REJECTION_CODE
          ? `A TypeScript construct that strip-only type stripping cannot erase -- a constructor parameter property, an \`enum\`, a non-\`declare\` \`namespace\`, an \`import x = require(...)\` alias -- has entered the config's transitive import graph. Rewrite the construct the trace names into erasable syntax: a parameter property becomes a field declaration plus an assignment in the constructor body.`
          : `The load failed for a reason other than ${REJECTION_CODE}, so it is the config or its imports, not their syntax.`;
      return {
        ok: false,
        status: "refused",
        message: `${WEB_CONFIG} does not load under ${loader.label}. ${cause}\n\n${result.output}`,
      };
    }
  }

  return {
    ok: true,
    status: "loads",
    message: `${WEB_CONFIG} and everything it imports load under ${LOADERS.map((loader) => loader.label).join(" and ")}.`,
  };
}

// CLI entry: child mode performs one load; otherwise the full check. Neither
// runs on import, so the test can drive the functions above directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === CHILD_FLAG) {
    const [loaderId, configFile, viteFrom] = process.argv.slice(3);
    const loader = LOADERS.find((candidate) => candidate.id === loaderId);
    if (!loader) {
      console.error(`unknown loader ${loaderId}`);
      process.exit(2);
    }
    try {
      await loader.load(configFile, viteFrom);
    } catch (error) {
      console.error(`${FAILURE_MARKER} ${error?.code ?? "no-code"}`);
      console.error(error?.stack ?? String(error));
      process.exit(1);
    }
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const result = checkWebConfigNativeLoad({ root });
    if (!result.ok) {
      console.error(`Web config native load check failed: ${result.message}`);
      process.exit(1);
    }
    console.log(`Web config native load check passed: ${result.message}`);
  }
}
