#!/usr/bin/env node
// Vectors-against-generator check, run by static_checks.yaml on every PR.
//
// Every known-answer vectors file under packages/core/test/vectors/ has a
// generator beside it, and the suites assert the code reproduces the checked-in
// JSON. Nothing asserted the other direction: that the checked-in JSON is what
// the generator produces. A failing conformance assertion could therefore be
// silenced by editing the vectors file instead of fixing the code, and no run
// would notice. This regenerates each file and fails on a difference, naming the
// file and the generator.
//
// Every entry in that directory is classified here, in one of three ways, and an
// entry matching none of them fails the check -- coverage cannot rot behind a
// file nobody added a rule for:
//
//   1. GENERATED_VECTORS -- a vectors file and the generator that writes it.
//      Regenerated and compared on every run.
//   2. VERIFIERS -- a script that checks a vectors file rather than writing one.
//      Running it here would prove nothing about the file's provenance, and
//      verify-native-wire-vectors.mjs needs the vendored native addon selected
//      for the runtime, so each entry names where it IS run instead.
//   3. UNGENERATED_VECTORS -- a vectors file with no generator, listed with the
//      reason it has none. Listed rather than passing by absence: the report
//      names them on every run, pass or fail, so the hole stays visible.
//
// Two shapes of generator, both declared per entry and both cross-checked
// against what the run actually does (see the write probe below): one prints the
// document to stdout, one writes its own file in place. The in-place ones read
// the committed file first and preserve its hand-authored fields, so what this
// compares for those is the DERIVED half -- which is the half a silenced
// assertion would have to move.
//
// Properties the implementation is built around:
//
//   1. NON-MUTATING. The bytes and timestamps of every file touched are read
//      before the run and put back on ordinary return or throw, by the teardown
//      scripts/lib/regenerationChecks.mjs runs. That teardown does not run on a
//      signal, so the same module arms SIGINT/SIGTERM handlers that restore in
//      the gaps between per-file runs, and after a run returns -- but each
//      generator runs synchronously via execFileSync, so a signal that arrives
//      while it is running is not dispatched to this process's JS handler until
//      the child exits; a process-group kill that takes the parent mid-run
//      leaves that file's probe mtime, and any in-place write the generator
//      already made, exactly as the run left them, for git to restore. A check
//      that left a regenerated vectors file behind on an ordinary exit would be
//      indistinguishable from the edit it exists to catch.
//   2. FAILS CLOSED on a comparison it did not really make. Three probes:
//      - The WRITE probe. Each target's mtime is set to a fixed past instant
//        before its generator runs, so whether the generator wrote the file is a
//        fact rather than an assumption. A `file` generator that leaves the
//        mtime untouched, and a `stdout` generator that moves it, each fail --
//        the declared shape and the observed one have to agree.
//      - The EXCUSED-VALUE probe. Where a generator's output has values it
//        does not reproduce (below), those values are masked on both sides
//        before the comparison. Each mask must fire the same non-zero number of
//        times on both, counted per key so an entry excusing two of them cannot
//        hide an inert mask behind one that matches; a mask that has quietly
//        stopped matching fails instead of excusing the whole file.
//      - The BUILT-CORE probe. The generators marked `needsCoreDist` below
//        import packages/core/dist, so a dist older than its sources makes the
//        comparison meaningless; that fails here, naming them, rather than
//        passing on yesterday's library.
//
// Unreproducible output, stated rather than skipped: generate-signed-receipt-
// vectors and generate-signing-cert-vectors sign by shelling out to `openssl`,
// and two of the values that land in their files do not come back the same:
//
//   - `signature`. ECDSA draws a fresh nonce per signature, so the value is not
//     a known answer; it moves on every run, on one host or across hosts.
//   - `signatureProducer`. Each generator records `openssl version` as the
//     provenance of the signatures beside it, so the value is whatever the
//     GENERATING host's openssl was. It reproduces only on a host with that
//     same build, which neither a contributor's machine nor the runner image
//     owes the machine the files were last regenerated on.
//
// Measured by regenerating both files against an openssl reporting a different
// version and diffing the whole file: those values are the ONLY bytes that move
// -- every fingerprint, binder, coordinate, and canonical layout in both files
// reproduces exactly -- so they are masked by name rather than the files being
// dropped from the check. What the signature mask gives up is covered elsewhere,
// also measured: flipping one character of every masked signature fails
// signedReceipt.test.ts, signedReceiptVerification.test.ts, and
// signingIdentity.test.ts, which verify them (apps/web/test/browser/
// signedReceipt.test.ts loads them in real Chromium as well). What the producer
// mask gives up is a record of history rather than a fact this check could pin:
// it names the openssl that signed the CHECKED-IN bytes, which a regeneration
// here does not reproduce and does not need to.
//
// What this check cannot see:
//   - Whether a vectors file is CORRECT. It asserts only that the checked-in
//     bytes are the generator's bytes. A generator and a file that are wrong
//     together pass.
//   - A hand-edited INPUT in an in-place generator's file (a vector's name,
//     description, inputs, or pinned randomness). Those are preserved by
//     design so a deliberate re-pin is reviewable as a diff; only the derived
//     half is recomputed and compared.
//   - What another version of a dependency would produce. It compares against
//     what the LOCALLY INSTALLED packages and the LOCALLY BUILT core dist
//     produce, so it is only as good as the lockfile pin and the build -- the
//     same limit `npm run check:routetree` has.
//   - Formatting drift from a prettier upgrade. The committed files are
//     prettier-formatted (the documented refresh is "run the generator, then
//     `npm run format`"), so the generator's output is formatted through this
//     repo's prettier before comparing; a prettier release that reflows JSON
//     moves the bytes on both sides at once here, and shows up as a formatcheck
//     failure rather than here.
//   - Concurrency. Another process writing these files at the same time races
//     it, and can leave either copy in place.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CORE_BUILD_COMMAND,
  describeCoreDistStaleness,
} from "./lib/coreDistFreshness.mjs";
import {
  firstDifference,
  withRestoreOnSignal,
} from "./lib/regenerationChecks.mjs";

/** The vectors directory this check covers, relative to the repository root. */
export const VECTORS_DIRECTORY = "packages/core/test/vectors";

// The values masked before a comparison, as the JSON key holding each and the
// shape that key's value takes. The shape is half the excuse: a value that stops
// matching it takes the EXCUSED-VALUE probe down rather than passing masked.
// Everything else in those files is deterministic and host-independent.
const EXCUSED_OPENSSL_KEYS = [
  { key: "signature", value: "[A-Za-z0-9_-]+" },
  { key: "signatureProducer", value: 'OpenSSL [^"]*' },
];

const EXCUSE_OPENSSL =
  "ECDSA signing draws a fresh nonce per signature, so the `signature` values are not known answers, and `signatureProducer` records the openssl that signed the checked-in bytes rather than the one this run has. Both are masked; the signatures' validity is asserted by the suites that verify them.";

/** Every vectors file with a generator, and how that generator emits it. */
export const GENERATED_VECTORS = [
  {
    vectors: "aead-envelope-vectors.json",
    generator: "generate-aead-envelope-vectors.mjs",
    writes: "file",
  },
  {
    vectors: "exchange-record-vectors.json",
    generator: "generate-exchange-record-vectors.mjs",
    writes: "file",
    needsCoreDist: true,
  },
  {
    vectors: "index-table-vectors.json",
    generator: "generate-index-table-vectors.mjs",
    writes: "stdout",
    needsCoreDist: true,
  },
  {
    vectors: "kex-vectors.json",
    generator: "generate-kex-vectors.mjs",
    writes: "stdout",
  },
  {
    vectors: "psi-engine-wire-vectors.json",
    generator: "generate-psi-engine-wire-vectors.mjs",
    writes: "file",
  },
  {
    vectors: "psi-intersection-vectors.json",
    generator: "generate-psi-intersection-vectors.mjs",
    writes: "file",
    needsCoreDist: true,
  },
  {
    vectors: "signed-receipt-vectors.json",
    generator: "generate-signed-receipt-vectors.mjs",
    writes: "file",
    needsCoreDist: true,
    excusedKeys: EXCUSED_OPENSSL_KEYS,
    excuse: EXCUSE_OPENSSL,
  },
  {
    vectors: "signing-cert-vectors.json",
    generator: "generate-signing-cert-vectors.mjs",
    writes: "file",
    needsCoreDist: true,
    excusedKeys: EXCUSED_OPENSSL_KEYS,
    excuse: EXCUSE_OPENSSL,
  },
  {
    vectors: "terms-envelope-vectors.json",
    generator: "generate-terms-envelope-vectors.mjs",
    writes: "stdout",
    needsCoreDist: true,
  },
  {
    vectors: "transform-regex-divergent-vectors.json",
    generator: "generate-transform-regex-divergent-vectors.mjs",
    writes: "stdout",
  },
  {
    vectors: "transform-regex-vectors.json",
    generator: "generate-transform-regex-vectors.mjs",
    writes: "stdout",
  },
  {
    vectors: "webrtc-interop-vectors.json",
    generator: "generate-webrtc-interop-vectors.mjs",
    writes: "stdout",
  },
];

/** Scripts in the directory that check a vectors file rather than write one. */
export const VERIFIERS = [
  {
    script: "verify-native-wire-vectors.mjs",
    reason:
      "replays psi-engine-wire-vectors.json through the vendored NATIVE addon selected for the runtime, proving native/WASM interop rather than the file's provenance (which generate-psi-engine-wire-vectors.mjs above supplies). Run against the musl build by native_alpine.yaml; packages/core/test/psiEngineWireVectorsNative.test.ts reimplements the same comparison in-process rather than running this script.",
  },
];

/** Vectors files with no generator, and why they have none. */
export const UNGENERATED_VECTORS = [
  {
    vectors: "canonical-vectors.json",
    reason:
      "a hand-authored RFC 8785 conformance corpus transcribed from docs/spec/CANONICAL_ENCODING.md. Generating it from this repo's canonicalizer would make it a self-test; replayed by packages/core/test/canonical.test.ts and apps/web/test/browser/canonical.test.ts.",
  },
  {
    vectors: "psi-prebuild-manifest.json",
    reason:
      "the hand-maintained expected side of packages/core/test/psiPrebuildManifest.test.ts, which re-derives the same facts from the committed lib/*.tgz. Deriving it from that tarball here would pin the tarball against itself.",
  },
];

/** The masking token an excused value is replaced with before comparison. */
export const EXCUSED_PLACEHOLDER = "<excused-value>";

// The write probe's fixed past instant. Any value the filesystem can hold that
// no real write would land on; the epoch's first second reads unambiguously in a
// stat if a run is killed between setting it and restoring.
const PROBE_MTIME = new Date(1000);

/** The value shape assumed for an excused key given as a bare name. */
const DEFAULT_EXCUSED_VALUE = "[A-Za-z0-9_-]+";

/** The JSON key an excused-key entry names, in either accepted shape. */
const excusedKeyName = (excused) =>
  typeof excused === "string" ? excused : excused.key;

/**
 * Replace the value of every excused `"<key>": "<value>"` line with
 * {@link EXCUSED_PLACEHOLDER}, returning the masked text, how many values were
 * replaced, and that count broken down by key. An entry is a bare key name,
 * whose value is matched as base64url, or `{key, value}` naming the shape that
 * key's value takes. Textual rather than parse-and-reserialize so everything
 * else -- key order, spacing, the whole formatted shape -- still compares byte
 * for byte.
 */
export function maskExcusedValues(text, keys = []) {
  let masked = text;
  const byKey = [];
  for (const excused of keys) {
    const key = excusedKeyName(excused);
    const value =
      typeof excused === "string"
        ? DEFAULT_EXCUSED_VALUE
        : (excused.value ?? DEFAULT_EXCUSED_VALUE);
    const pattern = new RegExp(`^(\\s*"${key}": ")${value}(",?)$`, "gm");
    let count = 0;
    masked = masked.replace(pattern, (_match, head, tail) => {
      count += 1;
      return `${head}${EXCUSED_PLACEHOLDER}${tail}`;
    });
    byKey.push({ key, count });
  }
  return {
    text: masked,
    count: byKey.reduce((total, entry) => total + entry.count, 0),
    byKey,
  };
}

/**
 * Directory entries the manifests do not account for and manifest entries the
 * directory does not hold, as `{unclassified, missing}`. This is what keeps the
 * coverage from rotting: a vectors file or a script added beside the others
 * fails until it is classified.
 */
export function classifyDirectory(
  names,
  {
    generated = GENERATED_VECTORS,
    verifiers = VERIFIERS,
    ungenerated = UNGENERATED_VECTORS,
  } = {},
) {
  const classified = new Set([
    ...generated.flatMap((entry) => [entry.vectors, entry.generator]),
    ...verifiers.map((entry) => entry.script),
    ...ungenerated.map((entry) => entry.vectors),
  ]);
  const present = new Set(names);
  return {
    unclassified: names.filter((name) => !classified.has(name)).sort(),
    missing: [...classified].filter((name) => !present.has(name)).sort(),
  };
}

/** Run a generator with this Node, returning its stdout; throws on a non-zero exit. */
export function spawnGenerator({ root, generatorPath }) {
  return execFileSync(process.execPath, [generatorPath], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Format generated text the way the repo's prettier formats the committed file. */
export async function formatWithPrettier(text, filepath) {
  const prettier = await import("prettier");
  const config = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(text, { ...config, filepath });
}

function generatorOutput(error) {
  return [error.stdout, error.stderr, error.message]
    .filter((part) => typeof part === "string" && part.trim() !== "")
    .join("\n")
    .trim();
}

/**
 * Regenerate every classified vectors file and compare it with the checked-in
 * copy, as `{ok, results, ungenerated, verifiers, report}`. Every file touched
 * is back as it was when this returns.
 *
 * Result statuses: `reproduces` (ok), `absent`, `generator-absent`,
 * `bad-manifest`, `generator-failed`, `removed-the-file`, `did-not-write`,
 * `wrote-unexpectedly`, `excuse-inert`, `differs`.
 */
export async function checkVectorsGenerators({
  root,
  directory = VECTORS_DIRECTORY,
  generated = GENERATED_VECTORS,
  verifiers = VERIFIERS,
  ungenerated = UNGENERATED_VECTORS,
  runGenerator = spawnGenerator,
  format = formatWithPrettier,
  coreDistStaleness = describeCoreDistStaleness,
} = {}) {
  const dir = resolve(root, directory);
  const coverage = classifyDirectory(
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
    { generated, verifiers, ungenerated },
  );

  const results = [];
  const staleness = generated.some((entry) => entry.needsCoreDist)
    ? coreDistStaleness(resolve(root, "packages/core"))
    : null;

  if (staleness === null) {
    for (const entry of generated) {
      results.push(
        await compareOne({ dir, directory, root, entry, runGenerator, format }),
      );
    }
  }

  const ok =
    staleness === null &&
    coverage.unclassified.length === 0 &&
    coverage.missing.length === 0 &&
    results.every((result) => result.status === "reproduces");

  return {
    ok,
    coverage,
    staleness,
    results,
    ungenerated,
    verifiers,
    report: formatReport({
      ok,
      coverage,
      staleness,
      results,
      ungenerated,
      verifiers,
      generated,
      directory,
    }),
  };
}

async function compareOne({
  dir,
  directory,
  root,
  entry,
  runGenerator,
  format,
}) {
  const target = join(dir, entry.vectors);
  const generatorPath = join(dir, entry.generator);
  const named = { vectors: entry.vectors, generator: entry.generator };

  if (!existsSync(target)) {
    return {
      ...named,
      status: "absent",
      detail: `${entry.vectors} is not in ${dir}. Restore it with \`git checkout -- ${directory}/${entry.vectors}\`, or regenerate it.`,
    };
  }
  if (!existsSync(generatorPath)) {
    return {
      ...named,
      status: "generator-absent",
      detail: `${entry.generator} is not in ${dir}, so ${entry.vectors} cannot be regenerated.`,
    };
  }

  if (entry.writes !== "file" && entry.writes !== "stdout") {
    return {
      ...named,
      status: "bad-manifest",
      detail: `${entry.generator} is declared with writes: ${JSON.stringify(entry.writes)}, which is neither "file" nor "stdout". This check cannot tell where its output goes, so it fails rather than guess.`,
    };
  }

  const original = readFileSync(target);
  const originalStat = statSync(target);
  const restore = () => {
    if (!existsSync(target) || !readFileSync(target).equals(original)) {
      writeFileSync(target, original);
    }
    utimesSync(target, originalStat.atime, originalStat.mtime);
  };

  return withRestoreOnSignal(restore, async () => {
    utimesSync(target, PROBE_MTIME, PROBE_MTIME);
    let stdout;
    try {
      stdout = runGenerator({ root, generatorPath, target });
    } catch (error) {
      return {
        ...named,
        status: "generator-failed",
        detail: `\`node ${directory}/${entry.generator}\` failed, so ${entry.vectors} could not be regenerated and its provenance is unknown:\n\n${generatorOutput(error)}`,
      };
    }

    if (!existsSync(target)) {
      return {
        ...named,
        status: "removed-the-file",
        detail: `${entry.generator} removed ${entry.vectors} instead of leaving a file to compare.`,
      };
    }
    const wrote = statSync(target).mtimeMs !== PROBE_MTIME.getTime();
    if (entry.writes === "file" && !wrote) {
      return {
        ...named,
        status: "did-not-write",
        detail: `${entry.generator} is declared to write ${entry.vectors} in place, but the run left the file untouched. This check means nothing unless the generator really regenerates the file, so it fails rather than pass a comparison it never made.`,
      };
    }
    if (entry.writes === "stdout" && wrote) {
      return {
        ...named,
        status: "wrote-unexpectedly",
        detail: `${entry.generator} is declared to print ${entry.vectors} to stdout, but the run wrote the file. Its stdout is no longer what the file is compared against -- update its \`writes\` in scripts/check-vectors-generators.mjs.`,
      };
    }
    const produced =
      entry.writes === "file" ? readFileSync(target, "utf8") : stdout;
    const formatted = await format(produced, target);
    const committed = original.toString("utf8");

    const excusedKeys = entry.excusedKeys ?? [];
    const maskedCommitted = maskExcusedValues(committed, excusedKeys);
    const maskedProduced = maskExcusedValues(formatted, excusedKeys);
    // Per key rather than over their total: an entry excusing more than one key
    // could otherwise have a mask matching nothing behind another that matches
    // plenty, and the totals would still agree.
    const inert = maskedCommitted.byKey
      .map((excused, index) => ({
        key: excused.key,
        committed: excused.count,
        produced: maskedProduced.byKey[index].count,
      }))
      .filter(
        (excused) =>
          excused.committed === 0 || excused.committed !== excused.produced,
      );
    if (inert.length > 0) {
      return {
        ...named,
        status: "excuse-inert",
        detail: `${inert.map((excused) => `\`${excused.key}\` matched ${excused.committed} time(s) in the committed ${entry.vectors} and ${excused.produced} in the regenerated one`).join("; ")}. The excuse must cover the same values on both sides or it is excusing something other than what it names -- so this fails rather than compare masked-out bytes. Reason the excuse exists: ${entry.excuse}`,
      };
    }

    const difference = firstDifference(
      maskedCommitted.text,
      maskedProduced.text,
    );
    if (difference === null) {
      return {
        ...named,
        status: "reproduces",
        excused: maskedCommitted.count,
      };
    }
    return {
      ...named,
      status: "differs",
      detail:
        `${directory}/${entry.vectors} is not what ${entry.generator} produces (first difference at line ${difference.line}):\n` +
        `    committed:   ${difference.committed}\n` +
        `    regenerated: ${difference.produced}\n` +
        `Either the generator is right and the file was edited by hand -- in which case fix the code the vectors pin, not the file -- or the change is deliberate, and the file is refreshed by running the generator and reviewing the diff:\n\n` +
        `  node ${directory}/${entry.generator}${entry.writes === "stdout" ? ` > ${directory}/${entry.vectors}` : ""}\n` +
        `  npm run format`,
    };
  });
}

function formatReport({
  ok,
  coverage,
  staleness,
  results,
  ungenerated,
  verifiers,
  generated,
  directory,
}) {
  const lines = [];
  lines.push(
    `${directory}: ${generated.length} generated, ${ungenerated.length} with no generator, ${verifiers.length} verifier(s).`,
  );

  lines.push("", "No generator (checked in by hand, not regenerated here):");
  for (const entry of ungenerated) {
    lines.push(`  ${entry.vectors} -- ${entry.reason}`);
  }

  lines.push("", "Verifier, not a generator:");
  for (const entry of verifiers) {
    lines.push(`  ${entry.script} -- ${entry.reason}`);
  }

  if (staleness !== null) {
    lines.push(
      "",
      staleness.kind === "missing"
        ? `packages/core has no built dist (${staleness.missing.join(", ")} missing).`
        : `packages/core's built dist is older than its sources (${staleness.source.path} is newer than ${staleness.dist.path}).`,
      `${generated
        .filter((entry) => entry.needsCoreDist)
        .map((entry) => entry.generator)
        .join(
          ", ",
        )} import that dist, so regenerating against it would compare the committed vectors with yesterday's library. Build first:\n\n  ${CORE_BUILD_COMMAND}`,
    );
  }

  if (coverage.unclassified.length > 0) {
    lines.push(
      "",
      `Unclassified in ${directory}: ${coverage.unclassified.join(", ")}.`,
      `Every file there is a generated vectors file, its generator, a verifier, or a vectors file with no generator. Add each of these to the matching list in scripts/check-vectors-generators.mjs so it cannot pass unchecked.`,
    );
  }
  if (coverage.missing.length > 0) {
    lines.push(
      "",
      `Classified but not in ${directory}: ${coverage.missing.join(", ")}.`,
      `Remove the stale entries from scripts/check-vectors-generators.mjs, or restore the files.`,
    );
  }

  const failures = results.filter((result) => result.status !== "reproduces");
  if (results.length > 0) {
    lines.push("", "Regenerated and compared:");
    for (const result of results) {
      const excused =
        result.excused > 0 ? ` (${result.excused} excused value(s))` : "";
      lines.push(
        result.status === "reproduces"
          ? `  ok    ${result.vectors} <- ${result.generator}${excused}`
          : `  FAIL  ${result.vectors} <- ${result.generator} [${result.status}]`,
      );
    }
  }
  for (const failure of failures) {
    lines.push(
      "",
      `${failure.vectors} <- ${failure.generator}: ${failure.detail}`,
    );
  }

  if (ok)
    lines.push(
      "",
      "Every generated vectors file is what its generator produces.",
    );
  return lines.join("\n");
}

// CLI entry: only runs when invoked directly, so the test can import the
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await checkVectorsGenerators({ root });
  if (!result.ok) {
    console.error(`Vectors generator check failed:\n\n${result.report}`);
    process.exit(1);
  }
  console.log(`Vectors generator check passed:\n\n${result.report}`);
}
