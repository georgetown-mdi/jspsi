#!/usr/bin/env node
// Does a psilink image answer what the shipped file-drop support scripts ask of
// it? Run by image_smoke.yaml against the image that job just built, and on its
// weekly schedule against the published tag the setup script really pulls.
//
// The set under test is derived rather than listed: scripts/derive-image-
// dependencies.mjs reads it out of the scripts themselves. This module holds
// only how to exercise each derived thing, and refuses to pass when a derived
// capability has no recipe -- which is how a new call site reddens a run instead
// of being quietly left out.
//
// Every dependency is exercised, never matched against help text or a
// Dockerfile: a psilink argument vector is handed to a container and its verdict
// read back, and a helper script is piped into a shell in the image exactly as
// cmd_Setup-PsilinkFileDrop.cmd pipes it, so the in-image tools it needs are
// resolved by the run rather than enumerated anywhere.
//
// Two fixture shapes decide whether a red result is about the image at all, and
// both are set up here rather than left to the caller:
//
//   - The rendezvous directory the mount checks are pointed at. A fresh named
//     volume belongs to root, the default image runs as uid 1000, and the
//     checks then fail their write with EACCES -- a verdict about the fixture.
//     The bind mount below is world-writable, so the account the image runs as
//     can write it whichever image is under test.
//   - A TCP peer on port 445. `doctor probe` and cmd_psilink-probe.sh both stop
//     at their reachability check when nothing answers, leaving smbclient
//     unreached and unproven. A stub container accepts and immediately drops
//     each connection, which is enough for both to run smbclient and report on
//     it, and a fixture that does not come up is reported as a fixture failure
//     rather than as a verdict about the image.
//
// What the run may claim is bounded by exit codes it treats as evidence. The
// doctor refusing its input exits 64 having run no check, and so does an
// image whose CLI has no `doctor` command at all -- so 64 is never taken as
// proof that anything ran. The evidence is a verdict: the machine-readable
// document, whose version the shipped launchers refuse to read past.

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveImageDependencies,
  repositoryRoot,
  SUPPORT_DIR,
} from "./derive-image-dependencies.mjs";

/** The container path the checks and the volume helper are pointed at. */
const RENDEZVOUS = "/rz";

/** The marker filename the shipped launchers use for the cross-check. */
const MARKER_NAME = "psilink-setup-check.tmp";

/**
 * Values for the environment names the `.cmd` call sites pass through.
 *
 * The share and the credential are fixtures for a stub that drops every
 * connection, so nothing here is a secret and nothing leaves the runner. A
 * derived environment name with no value here fails the coverage check rather
 * than reaching a container unset, where a script would report a defect in its
 * own caller instead of anything about the image.
 */
export const FIXTURE_ENVIRONMENT = {
  SMB_SHARE: "psilink-gate",
  SMB_PATH: "",
  SMB_USER: "psilink-gate",
  SMB_DOMAIN: "",
  SMB_PASS: "psilink-gate-fixture-credential",
  SMB_DIALECT: "",
  SMB_MARKER: MARKER_NAME,
  MARKER: MARKER_NAME,
};

/** Environment names whose value the run mints rather than fixes. */
export const GENERATED_ENVIRONMENT = ["SMB_SERVER", "SMB_TOKEN", "TOKEN"];

/**
 * How each derived psilink argument vector is exercised, by recipe key.
 *
 * A key is the vector's first two tokens, so `doctor mount /rz` and
 * `doctor mount /rz --json` are one recipe run twice, once per derived vector.
 */
export const CLI_RECIPES = {
  "doctor --help": exerciseDoctorHelp,
  "doctor probe": exerciseDoctorProbe,
  "doctor mount": exerciseDoctorMount,
  serve: exerciseServe,
};

/**
 * What each helper script must show for its run to have proven the image.
 *
 * `reaches` are strings the run's output must contain, each chosen to sit after
 * the in-image tools that step needs: a script that reached them resolved them.
 * `refuses` are the arms a script takes when the image is missing something,
 * which must not appear.
 */
export const HELPER_EXPECTATIONS = {
  "cmd_psilink-credcheck.sh": {
    reaches: ["VERDICT=", "TOKEN="],
    refuses: [],
    pattern: /^TOKEN=[0-9a-f]{32}$/m,
  },
  "cmd_psilink-probe.sh": {
    reaches: ["-- 1.", "-- 2.", "-- 3. Authentication"],
    refuses: ["smbclient is not in the image"],
  },
  "cmd_psilink-volcheck.sh": {
    reaches: ["WRITE_OK", "EXCL_OK", "RENAME_OK"],
    refuses: ["NOMOUNT", "Permission denied"],
  },
};

/** The recipe key for a derived argument vector. */
export function recipeKey(argv) {
  return argv.slice(0, 2).join(" ");
}

/**
 * Where the derived set and the recipes disagree, in both directions.
 *
 * A derived capability with no recipe is a call site this cannot exercise; a
 * recipe nothing derives is a capability the scripts stopped asking for, and
 * leaving it would let the table drift into describing a surface that is gone.
 */
export function coverageGaps(
  derived,
  cliRecipes = CLI_RECIPES,
  helperExpectations = HELPER_EXPECTATIONS,
  fixtureEnvironment = FIXTURE_ENVIRONMENT,
) {
  const gaps = [];
  const derivedKeys = new Set(
    derived.cli.map((entry) => recipeKey(entry.argv)),
  );
  const derivedScripts = new Set(derived.helpers.map((entry) => entry.script));

  for (const entry of derived.cli) {
    const key = recipeKey(entry.argv);
    if (!(key in cliRecipes)) {
      gaps.push(
        `${entry.sites.join(", ")} hands the image "${entry.argv.join(" ")}", and no recipe named "${key}" exercises it -- add one to CLI_RECIPES in scripts/assert-image-capabilities.mjs`,
      );
    }
  }
  for (const key of Object.keys(cliRecipes)) {
    if (!derivedKeys.has(key)) {
      gaps.push(
        `CLI_RECIPES carries "${key}", and no support script asks the image for it -- drop it from scripts/assert-image-capabilities.mjs`,
      );
    }
  }
  for (const entry of derived.helpers) {
    if (!(entry.script in helperExpectations)) {
      gaps.push(
        `${entry.sites.join(", ")} pipes ${entry.script} into the image, and nothing says what its run must show -- add it to HELPER_EXPECTATIONS in scripts/assert-image-capabilities.mjs`,
      );
    }
    for (const name of entry.env) {
      if (
        !(name in fixtureEnvironment) &&
        !GENERATED_ENVIRONMENT.includes(name)
      )
        gaps.push(
          `${entry.script} is passed ${name}, and no fixture supplies a value for it -- add one to FIXTURE_ENVIRONMENT in scripts/assert-image-capabilities.mjs`,
        );
    }
  }
  for (const script of Object.keys(helperExpectations)) {
    if (!derivedScripts.has(script)) {
      gaps.push(
        `HELPER_EXPECTATIONS carries ${script}, and ${SUPPORT_DIR} no longer pipes it into the image -- drop it from scripts/assert-image-capabilities.mjs`,
      );
    }
  }
  return gaps;
}

/** The first line of a stream that parses as a doctor verdict document. */
export function readVerdict(stdout) {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && "version" in parsed)
        return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Whether an exit code is evidence the checks ran.
 *
 * 0 and 78 are verdicts the checks reached; 69 is one it could not, which is
 * what a missing in-image dependency produces and is therefore a failure here
 * rather than a pass. 64 is a refused input, which an image with no doctor
 * at all also answers, so it proves nothing either way.
 */
export function batteryRan(status) {
  return status === 0 || status === 78;
}

const run = (argv, options = {}) => {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    ...options,
  });
  // A program that could not be started at all is reported through `error` with
  // a null status and no streams, which every branch here would otherwise read
  // as an exit code and an empty answer from a container that never ran.
  if (result.error !== undefined) {
    return {
      status: 127,
      stdout: "",
      stderr: `${argv[0]} could not be run: ${result.error.message}`,
    };
  }
  return {
    status: result.status ?? 127,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

/** Every result field a recipe returns, so a caller reports them uniformly. */
function verdict(ok, detail) {
  return { ok, detail };
}

function exerciseDoctorHelp(context, argv) {
  const result = context.docker(["run", "--rm", context.image, ...argv]);
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0)
    return verdict(false, `exited ${result.status}, expected 0`);
  if (!/doctor/.test(output))
    return verdict(false, "printed a usage that never names the doctor");
  return verdict(true, "printed the doctor's own usage");
}

function exerciseDoctorProbe(context, argv) {
  const withJson = argv.includes("--json") ? argv : [...argv, "--json"];
  const result = context.docker([
    "run",
    "--rm",
    "--network",
    context.network,
    ...context.environmentFlags([
      "SMB_SERVER",
      "SMB_SHARE",
      "SMB_PATH",
      "SMB_USER",
      "SMB_DOMAIN",
      "SMB_PASS",
      "SMB_DIALECT",
      "SMB_MARKER",
      "SMB_TOKEN",
    ]),
    context.image,
    ...withJson,
  ]);
  if (!batteryRan(result.status))
    return verdict(
      false,
      `exited ${result.status}; a battery that ran exits 0 or 78, and 64 is a refused input an image with no doctor answers the same way`,
    );
  const document = readVerdict(result.stdout);
  if (document === null) return verdict(false, "printed no readable verdict");
  if (document.version !== context.verdictVersion)
    return verdict(
      false,
      `verdict version ${document.version}, and the shipped launchers read version ${context.verdictVersion} and stop on any other`,
    );
  const smbclient = (document.checks ?? []).find(
    (check) => check.id === "smbclient_available",
  );
  if (smbclient === undefined || smbclient.status !== "ok")
    return verdict(
      false,
      `the battery reported smbclient_available as ${smbclient?.status ?? "absent"}; the stub peer is up, so this is the image rather than the fixture`,
    );
  return verdict(
    true,
    `verdict version ${document.version}, smbclient_available ok, overall ${document.overall}`,
  );
}

function exerciseDoctorMount(context, argv) {
  const withJson = argv.includes("--json") ? argv : [...argv, "--json"];
  // Taken from the vector rather than fixed, so a call site that moves the
  // checks to another path is mounted where it now looks.
  const target = argv.find((token) => token.startsWith("/")) ?? RENDEZVOUS;
  context.plantMarker();
  const result = context.docker([
    "run",
    "--rm",
    ...context.environmentFlags(["SMB_MARKER", "SMB_TOKEN"]),
    "--volume",
    `${context.rendezvous}:${target}`,
    context.image,
    ...withJson,
  ]);
  if (result.status !== 0)
    return verdict(
      false,
      `exited ${result.status} over a writable mount the account the image runs as owns; 69 is a dependency it could not reach and 78 a check it ran and failed`,
    );
  const document = readVerdict(result.stdout);
  if (document === null) return verdict(false, "printed no readable verdict");
  if (document.version !== context.verdictVersion)
    return verdict(
      false,
      `verdict version ${document.version}, and the shipped launchers read version ${context.verdictVersion} and stop on any other`,
    );
  if (document.overall !== "ok")
    return verdict(false, `overall ${document.overall}, expected ok`);
  const ids = (document.checks ?? []).map((check) => check.id).join(", ");
  return verdict(true, `overall ok over ${ids}`);
}

async function exerciseServe(context, argv) {
  const port = 3111;
  const started = context.docker([
    "run",
    "--detach",
    "--publish",
    `127.0.0.1:${port}:3000`,
    context.image,
    ...argv,
  ]);
  if (started.status !== 0)
    return verdict(false, `the container did not start: ${started.stderr}`);
  const container = started.stdout.trim();
  try {
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      // Bounded by a plain setTimeout rather than AbortSignal.timeout, whose
      // timer is unref'd: a ref'd handle is what keeps the loop alive for the
      // whole of each poll, so a request that settles neither way fails this
      // vector instead of draining the loop and ending the run at exit 13 with
      // this await unsettled.
      const bound = new AbortController();
      const stopWaiting = setTimeout(() => bound.abort(), 5000);
      try {
        const answer = await fetch(`http://127.0.0.1:${port}/`, {
          signal: bound.signal,
        });
        if (answer.ok)
          return verdict(
            true,
            `answered HTTP ${answer.status} on attempt ${attempt}`,
          );
      } catch {
        // Not up yet; the attempt bound is what limits how long that stands.
      } finally {
        clearTimeout(stopWaiting);
      }
      await new Promise((wake) => setTimeout(wake, 1000));
    }
    const logs = context.docker(["logs", container]);
    return verdict(
      false,
      `never answered on 127.0.0.1:${port}: ${logs.stdout}${logs.stderr}`,
    );
  } finally {
    context.docker(["rm", "--force", container]);
  }
}

function exerciseHelper(context, helper, expectation) {
  const result = context.docker(
    [
      "run",
      "--rm",
      "--interactive",
      "--network",
      context.network,
      ...context.environmentFlags(helper.env),
      ...helper.mounts.flatMap((target) => [
        "--volume",
        `${context.rendezvous}:${target}`,
      ]),
      "--entrypoint",
      "sh",
      context.image,
      "-c",
      "tr -d '\\r' | sh",
    ],
    { input: context.helperSource(helper.script) },
  );
  const output = `${result.stdout}${result.stderr}`;
  const missing = expectation.reaches.filter((text) => !output.includes(text));
  if (missing.length > 0)
    return verdict(
      false,
      `exited ${result.status} without reaching ${missing.join(", ")}: ${output.trim()}`,
    );
  const refused = expectation.refuses.filter((text) => output.includes(text));
  if (refused.length > 0)
    return verdict(
      false,
      `took the ${refused.join(", ")} arm: ${output.trim()}`,
    );
  if (expectation.pattern !== undefined && !expectation.pattern.test(output))
    return verdict(
      false,
      `output does not match ${expectation.pattern}: ${output.trim()}`,
    );
  return verdict(true, `reached ${expectation.reaches.join(", ")}`);
}

/** Print the digest the run resolved, rather than the reference it asked for. */
function reportResolvedImage(image, docker) {
  const inspected = docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}} {{json .RepoDigests}}",
    image,
  ]);
  if (inspected.status !== 0) {
    console.error(
      `${image}: not present locally -- ${inspected.stderr.trim()}`,
    );
    return false;
  }
  const line = inspected.stdout.trim();
  const gap = line.indexOf(" ");
  let digests = [];
  try {
    digests = JSON.parse(line.slice(gap + 1));
  } catch {
    digests = [];
  }
  console.log(`image reference: ${image}`);
  console.log(
    `image id:        ${line.slice(0, gap === -1 ? undefined : gap)}`,
  );
  console.log(
    `repo digests:    ${digests.join(", ") || "none (never pushed)"}`,
  );
  return true;
}

/**
 * Bring up the fixtures, run every derived dependency, tear the fixtures down.
 *
 * The stub peer runs `node` rather than a shell tool so the fixture cannot fail
 * for the same reason the image is under test for: every image here runs node,
 * and nothing else the stub needs is in question.
 */
async function exerciseAll(image, derived) {
  const suffix = randomBytes(4).toString("hex");
  const network = `psilink-image-gate-${suffix}`;
  const stub = `psilink-smb-stub-${suffix}`;
  const rendezvous = mkdtempSync(join(tmpdir(), "psilink-image-gate-"));
  chmodSync(rendezvous, 0o777);
  const token = randomBytes(16).toString("hex");
  // Held in this process's environment and named on the command line, the
  // shape every call site uses so a credential is not an argv value anything
  // reading the process table can see.
  const environment = {
    ...process.env,
    ...FIXTURE_ENVIRONMENT,
    SMB_SERVER: stub,
    SMB_TOKEN: token,
    TOKEN: token,
  };

  const docker = (argv, options = {}) =>
    run(["docker", ...argv], { env: environment, ...options });
  const context = {
    image,
    network,
    rendezvous,
    verdictVersion: derived.verdictVersion,
    docker,
    environmentFlags: (names) => names.flatMap((name) => ["--env", name]),
    plantMarker: () =>
      writeFileSync(join(rendezvous, MARKER_NAME), `${token}\n`),
    helperSource: (script) => derived.sources[script],
  };

  const results = [];
  try {
    const created = docker(["network", "create", network]);
    if (created.status !== 0)
      throw new Error(`the fixture network did not come up: ${created.stderr}`);
    const listener = docker([
      "run",
      "--detach",
      "--name",
      stub,
      "--network",
      network,
      "--user",
      "0",
      "--entrypoint",
      "node",
      image,
      "-e",
      'require("net").createServer((s) => s.destroy()).listen(445, "0.0.0.0");',
    ]);
    if (listener.status !== 0)
      throw new Error(`the stub peer did not come up: ${listener.stderr}`);

    for (const entry of derived.cli) {
      const recipe = CLI_RECIPES[recipeKey(entry.argv)];
      results.push({
        what: entry.argv.join(" "),
        sites: entry.sites,
        ...(await recipe(context, entry.argv)),
      });
    }
    for (const helper of derived.helpers) {
      results.push({
        what: helper.script,
        sites: helper.sites,
        ...exerciseHelper(context, helper, HELPER_EXPECTATIONS[helper.script]),
      });
    }
  } finally {
    docker(["rm", "--force", stub]);
    docker(["network", "rm", network]);
    rmSync(rendezvous, { recursive: true, force: true });
  }
  return results;
}

/** Replace the fixture credential wherever a container echoed it back. */
function redact(text) {
  return text.split(FIXTURE_ENVIRONMENT.SMB_PASS).join("<fixture-credential>");
}

function usage() {
  console.error(
    "usage: node scripts/assert-image-capabilities.mjs <image-reference>\n" +
      "       node scripts/assert-image-capabilities.mjs --coverage\n\n" +
      "--coverage checks that every dependency derived from the support scripts\n" +
      "has a recipe here, and needs no Docker daemon.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [target] = process.argv.slice(2);
  if (target === undefined || target === "--help") {
    usage();
    process.exit(target === undefined ? 64 : 0);
  }

  const root = repositoryRoot();
  const derived = deriveImageDependencies(root);
  const gaps = coverageGaps(derived);
  if (gaps.length > 0) {
    for (const gap of gaps) console.error(gap);
    process.exit(1);
  }
  console.log(
    `${derived.cli.length} psilink argument vectors and ${derived.helpers.length} helper scripts are derived from ${SUPPORT_DIR}, and each has a recipe.`,
  );

  if (target !== "--coverage") {
    if (!reportResolvedImage(target, (argv) => run(["docker", ...argv])))
      process.exit(1);
    let results;
    try {
      results = await exerciseAll(target, derived);
    } catch (err) {
      // A fixture that did not come up is reported as itself: no dependency was
      // exercised, so nothing here is a verdict about the image.
      console.error(redact(err.message));
      process.exit(1);
    }
    let failed = 0;
    for (const result of results) {
      console.log(
        `${result.ok ? "ok  " : "FAIL"}  ${result.what}  (${result.sites.join(", ")})\n        ${redact(result.detail)}`,
      );
      if (!result.ok) failed += 1;
    }
    if (failed > 0) {
      console.error(
        `\n${failed} of ${results.length} dependencies the support scripts have on the image went unanswered by ${target}.`,
      );
      process.exit(1);
    }
    console.log(
      `\nall ${results.length} dependencies the support scripts have on the image were exercised against it.`,
    );
  }
}
