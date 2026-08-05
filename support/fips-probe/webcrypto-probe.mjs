#!/usr/bin/env node
// Question 3 of the FIPS provider spike: does crypto.subtle in this image's Node
// engage a configured OpenSSL FIPS provider for AES-256-GCM?
//
// The hard part is not making the call succeed -- it is telling "the call
// succeeded" apart from "the call ran inside the provider". Three controls do
// that, and the verdict below is computed from them rather than read off S2:
//
//   S3 attribution -- operations no FIPS provider serves (an MD5 digest, an RSA
//     keygen below the FIPS minimum modulus) must FAIL in the same process that
//     just did the AES call. Each is first run at baseline, so a control that
//     cannot succeed even with no configuration counts for nothing.
//   S4 causal -- the provider is broken (its config MAC corrupted, then its
//     module truncated) and the same AES call re-run. If the call survives a
//     broken provider it was never dispatching through it.
//
// The only ENGAGED verdict is S2 succeeding, every informative build-independent
// S3 control failing, and every effective S4 break stopping the call. Anything
// else is UNSETTLED or NOT ENGAGED, and the verdict says which and why.
//
// This runs the same WebCrypto call shape the product uses -- it does not import
// the product's own module -- so it is a proxy for the AEAD path, not an
// end-to-end run of it.
//
// Driver mode (no arguments) writes the configurations, spawns each scenario as
// a child Node process and prints the transcript. Child mode (--child <label>)
// performs the operations and prints one CHILD_JSON line.

import { spawnSync } from "node:child_process";
import { createHash, getFips, setFips } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const CHILD_JSON_PREFIX = "CHILD_JSON:";

// The parameter shape packages/core/src/connection/encryptedMessageConnection.ts
// puts on the wire, read from that module in this tree: a raw-imported 256-bit
// AES-GCM key and a 12-byte IV carrying the frame sequence number.
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const AES_PLAINTEXT = "psilink fips probe frame";

const PREFIX = process.env.PROBE_PREFIX ?? "/opt/fips-probe/openssl";
const PROVIDER_TAG = process.env.PROBE_OPENSSL_TAG ?? "unknown";
const MODULES_DIR = join(PREFIX, "lib", "ossl-modules");
const FIPS_MODULE = join(MODULES_DIR, "fips.so");
const FIPS_MODULE_CNF = join(PREFIX, "ssl", "fipsmodule.cnf");
const TMP = process.env.PROBE_TMP ?? "/probe/tmp/webcrypto";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function describeError(err, depth = 0) {
  if (err === null || err === undefined) return { value: String(err) };
  if (typeof err !== "object") return { value: String(err) };
  const described = { name: err.name, message: err.message };
  for (const key of [
    "code",
    "library",
    "function",
    "reason",
    "errno",
    "syscall",
  ]) {
    if (err[key] !== undefined) described[key] = err[key];
  }
  if (Array.isArray(err.opensslErrorStack)) {
    described.openssl_error_stack = err.opensslErrorStack;
  }
  if (err.cause !== undefined && depth < 4) {
    described.cause = describeError(err.cause, depth + 1);
  }
  return described;
}

function errorLine(error) {
  if (!error) return "";
  const parts = [error.name, error.message].filter(Boolean);
  const line = parts.join(": ") || error.value || "(no message)";
  const stack = error.openssl_error_stack;
  return stack && stack.length > 0
    ? `${line} [openssl: ${stack.join(" | ")}]`
    : line;
}

// A mapping of fips.so in this process is direct evidence the module was loaded
// into it, so it is read after the crypto call as well as before: provider
// loading can be lazy.
function fipsModuleMappings() {
  try {
    const lines = readFileSync("/proc/self/maps", "utf8")
      .split("\n")
      .filter((line) => line.includes("fips.so"));
    return { readable: true, mapped: lines.length > 0, lines };
  } catch (err) {
    return {
      readable: false,
      mapped: false,
      lines: [],
      error: describeError(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Child mode: the measured operations
// ---------------------------------------------------------------------------

async function attempt(fn) {
  try {
    return { ok: true, detail: await fn() };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function aesGcmRoundTrip() {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(AES_KEY_BYTES).fill(0x2a),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  const iv = new Uint8Array(AES_IV_BYTES);
  new DataView(iv.buffer).setBigUint64(4, 1n, false);
  const plaintext = new TextEncoder().encode(AES_PLAINTEXT);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const decrypted = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext),
  );
  const matched =
    decrypted.length === plaintext.length &&
    decrypted.every((byte, index) => byte === plaintext[index]);
  if (!matched)
    throw new Error("AES-256-GCM round trip returned other plaintext");
  // Key, IV and plaintext are fixed, so this value is comparable across
  // scenarios and across provider builds.
  return {
    ciphertext_bytes: ciphertext.length,
    ciphertext_head_hex: toHex(ciphertext.slice(0, 8)),
  };
}

async function x25519DeriveBits() {
  const ours = await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ]);
  const theirs = await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "X25519", public: theirs.publicKey },
    ours.privateKey,
    256,
  );
  return { derived_bytes: bits.byteLength };
}

async function rsaKeygenBelowFipsMinimum() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 1024,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    false,
    ["sign", "verify"],
  );
  return { modulus_length: 1024, private_key_type: pair.privateKey.type };
}

function md5Digest() {
  return { hex: createHash("md5").update(AES_PLAINTEXT).digest("hex") };
}

function currentFipsFlag() {
  try {
    return { ok: true, value: getFips() };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

async function runChild(label, { callSetFips }) {
  const record = {
    scenario: label,
    set_fips_called: Boolean(callSetFips),
    node: {
      version: process.version,
      openssl: process.versions.openssl,
      shared_openssl: process.config.variables.node_shared_openssl ?? null,
      openssl_is_fips: process.config.variables.openssl_is_fips ?? null,
      exec_argv: process.execArgv,
    },
    env: {
      OPENSSL_CONF: process.env.OPENSSL_CONF ?? null,
      OPENSSL_MODULES: process.env.OPENSSL_MODULES ?? null,
    },
    get_fips_at_start: currentFipsFlag(),
    maps_before_crypto: fipsModuleMappings(),
    operations: {},
  };

  if (callSetFips) {
    record.set_fips_result = await attempt(async () => {
      setFips(true);
      return { get_fips_after: getFips() };
    });
  }

  record.operations.aes256gcm_round_trip = await attempt(aesGcmRoundTrip);
  record.maps_after_aes = fipsModuleMappings();
  record.get_fips_after_aes = currentFipsFlag();
  record.operations.x25519_derive_bits = await attempt(x25519DeriveBits);
  record.operations.rsa1024_keygen = await attempt(rsaKeygenBelowFipsMinimum);
  record.operations.md5_digest = await attempt(async () => md5Digest());
  record.maps_at_exit = fipsModuleMappings();

  process.stdout.write(`${CHILD_JSON_PREFIX}${JSON.stringify(record)}\n`);
}

// ---------------------------------------------------------------------------
// Driver mode: configurations
// ---------------------------------------------------------------------------

const say = (...args) => console.log(...args);

function heading(text) {
  say("");
  say("==============================================================");
  say(text);
  say("==============================================================");
}

function indent(text) {
  return String(text)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function fipsSectionName(text) {
  const match = /^\s*\[\s*([^\]\s]+)\s*\]/m.exec(text);
  return match ? match[1] : "fips_sect";
}

function writePath(name, contents) {
  const path = join(TMP, name);
  writeFileSync(path, contents);
  return path;
}

// A provider configuration activating fips and base and NOT default, with
// fips=yes as the default property. Both top-level key names are written: which
// one a Node-bundled OpenSSL reads is measured separately below, and writing
// both keeps a scenario from failing on that question rather than on its own.
function providerConfig(name, { includePath, sectionName }) {
  return writePath(
    `${name}.cnf`,
    [
      "config_diagnostics = 1",
      "openssl_conf = probe_init",
      "nodejs_conf = probe_init",
      "",
      `.include ${includePath}`,
      "",
      "[probe_init]",
      "providers = probe_providers",
      "alg_section = probe_algorithms",
      "",
      "[probe_algorithms]",
      "default_properties = fips=yes",
      "",
      "[probe_providers]",
      `fips = ${sectionName}`,
      "base = probe_base",
      "",
      "[probe_base]",
      "activate = 1",
      "",
    ].join("\n"),
  );
}

function withModuleKey(text, modulePath) {
  return text.replace(/^(\s*\[[^\]]*\]\s*)$/m, `$1\nmodule = ${modulePath}`);
}

function withCorruptedMac(text) {
  return text.replace(
    /^(\s*module-mac\s*=\s*)([0-9A-Fa-f]{2})/m,
    (whole, head, firstByte) =>
      `${head}${firstByte.toUpperCase() === "00" ? "11" : "00"}`,
  );
}

// The four ways a provider configuration could reach the bundled OpenSSL. Each
// is tried; the transcript records which ones loaded the module.
const RECIPES = [
  {
    slug: "openssl-conf-env",
    name: "OPENSSL_CONF + OPENSSL_MODULES environment variables",
  },
  {
    slug: "openssl-config-flag",
    name: "node --openssl-config=<file> + OPENSSL_MODULES",
  },
  {
    slug: "shared-config-flag",
    name: "node --openssl-shared-config + OPENSSL_CONF + OPENSSL_MODULES",
  },
  {
    slug: "module-key",
    name: "OPENSSL_CONF naming the module path in the provider section (no OPENSSL_MODULES)",
  },
];

function invocationFor(recipeSlug, variant) {
  const name = `${variant.label}-${recipeSlug}`;
  switch (recipeSlug) {
    case "openssl-conf-env": {
      const conf = providerConfig(name, variant);
      return {
        nodeArgs: [],
        env: { OPENSSL_CONF: conf, OPENSSL_MODULES: variant.modulesDir },
        confPath: conf,
      };
    }
    case "openssl-config-flag": {
      const conf = providerConfig(name, variant);
      return {
        nodeArgs: [`--openssl-config=${conf}`],
        env: { OPENSSL_MODULES: variant.modulesDir },
        confPath: conf,
      };
    }
    case "shared-config-flag": {
      const conf = providerConfig(name, variant);
      return {
        nodeArgs: ["--openssl-shared-config"],
        env: { OPENSSL_CONF: conf, OPENSSL_MODULES: variant.modulesDir },
        confPath: conf,
      };
    }
    case "module-key": {
      const conf = providerConfig(name, {
        includePath: variant.includeWithModulePath,
        sectionName: variant.sectionName,
      });
      return { nodeArgs: [], env: { OPENSSL_CONF: conf }, confPath: conf };
    }
    default:
      throw new Error(`unknown recipe ${recipeSlug}`);
  }
}

// ---------------------------------------------------------------------------
// Driver mode: running children
// ---------------------------------------------------------------------------

function childEnvironment(overrides) {
  const env = { ...process.env };
  delete env.OPENSSL_CONF;
  delete env.OPENSSL_MODULES;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function spawnNode({ nodeArgs = [], scriptArgs, env = {} }) {
  const argv = [...nodeArgs, ...scriptArgs];
  const result = spawnSync(process.execPath, argv, {
    env: childEnvironment(env),
    encoding: "utf8",
    timeout: 180_000,
  });
  return {
    command: `node ${argv.join(" ")}`,
    env,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawn_error: result.error ? describeError(result.error) : null,
  };
}

function parseChildRecord(run) {
  const line = run.stdout
    .split("\n")
    .find((candidate) => candidate.startsWith(CHILD_JSON_PREFIX));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(CHILD_JSON_PREFIX.length));
  } catch {
    return null;
  }
}

function reportRun(run) {
  say(`    $ ${run.command}`);
  for (const [key, value] of Object.entries(run.env)) {
    say(`      env ${key}=${value}`);
  }
  say(`    [exit status ${run.status}, signal ${run.signal}]`);
  if (run.spawn_error) say(`    spawn error: ${errorLine(run.spawn_error)}`);
  if (run.stderr.trim() !== "") {
    say("    stderr:");
    say(indent(indent(run.stderr.trimEnd())));
  }
}

function runScenario(label, invocation) {
  const run = spawnNode({
    nodeArgs: invocation.nodeArgs,
    scriptArgs: [SELF, "--child", label, ...(invocation.childArgs ?? [])],
    env: invocation.env,
  });
  const record = parseChildRecord(run);
  if (invocation.confPath) {
    say(`    configuration ${invocation.confPath}:`);
    say(indent(indent(readFileSync(invocation.confPath, "utf8").trimEnd())));
  }
  reportRun(run);
  if (record) {
    say("    measured:");
    say(indent(indent(JSON.stringify(record, null, 2))));
  } else if (run.stdout.trim() !== "") {
    say("    stdout (no parsable record):");
    say(indent(indent(run.stdout.trimEnd())));
  } else {
    say("    stdout: (empty; the process produced no record)");
  }
  return { label, run, record };
}

function operationOutcome(scenario, operation) {
  const result = scenario.record?.operations?.[operation];
  if (!result) return { ran: false, ok: false, error: null };
  return { ran: true, ok: result.ok === true, error: result.error ?? null };
}

function moduleMapped(scenario) {
  const record = scenario.record;
  if (!record) return false;
  return Boolean(record.maps_after_aes?.mapped || record.maps_at_exit?.mapped);
}

function fipsFlag(scenario) {
  const flag = scenario.record?.get_fips_after_aes;
  return flag && flag.ok ? flag.value : null;
}

// How a process that produced no record ended, for a scenario whose Node never
// reached the operations -- a provider that fails to load can abort startup
// rather than throwing where the call site can catch it.
function processNote(scenario) {
  const { status, signal, stderr } = scenario.run;
  const firstLines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, 2)
    .join(" / ");
  return `the process ended with exit status ${status} and signal ${signal} without producing a record${
    firstLines === "" ? "" : `: ${firstLines}`
  }`;
}

function scenarioSummary(scenario) {
  const aes = operationOutcome(scenario, "aes256gcm_round_trip");
  return [
    `AES-256-GCM round trip: ${aes.ran ? (aes.ok ? "SUCCEEDED" : "FAILED") : "DID NOT RUN"}`,
    aes.error ? ` (${errorLine(aes.error)})` : "",
    aes.ran ? "" : ` (${processNote(scenario)})`,
    `; fips.so mapped: ${moduleMapped(scenario) ? "yes" : "no"}`,
    `; crypto.getFips(): ${fipsFlag(scenario) ?? "unavailable"}`,
  ].join("");
}

// ---------------------------------------------------------------------------
// Driver mode: the verdict
// ---------------------------------------------------------------------------

// Controls that must fail inside the provider. Each is informative only if it
// succeeded at baseline: an operation this Node cannot do at all says nothing
// about what the provider carries.
//
// buildIndependent marks a control no FIPS provider serves whatever its build --
// MD5 is never an approved algorithm, and a 1024-bit modulus is below the FIPS
// minimum. Only those decide attribution: if one of them still works under the
// fips-only configuration, the default provider is still reachable.
//
// X25519 is deliberately NOT build-independent. The 3.0.x provider carries
// X25519 key exchange and the 3.5.x provider does not, so under 3.0.x its
// success is the provider serving it, not a leak. Gating the verdict on it
// reports UNSETTLED on exactly the build where the answer is attributable, so it
// is recorded as an observation and cross-checked against the algorithm listing.
const ATTRIBUTION_CONTROLS = [
  {
    operation: "md5_digest",
    name: "MD5 digest through node:crypto (never an approved algorithm)",
    buildIndependent: true,
  },
  {
    operation: "rsa1024_keygen",
    name: "RSA-1024 keygen through crypto.subtle (below the FIPS minimum modulus)",
    buildIndependent: true,
  },
  {
    operation: "x25519_derive_bits",
    name: "X25519 deriveBits through crypto.subtle",
    buildIndependent: false,
  },
];

function computeVerdict({ baseline, chosen, fipsOnly, breaks, mechanisms }) {
  const evidence = [];

  const baselineAes = operationOutcome(baseline, "aes256gcm_round_trip");
  if (!baselineAes.ok) {
    return {
      verdict: "UNSETTLED",
      reason:
        "the baseline AES-256-GCM round trip did not succeed, so nothing measured under a configuration is interpretable",
      evidence,
    };
  }

  if (!chosen) {
    // Which of the two failures this is matters to the reader: a configuration
    // channel that never reaches OpenSSL is a different finding from one that
    // reaches it and then cannot load the module.
    const reaching = mechanisms.filter((entry) => entry.reached_openssl);
    return {
      verdict: "NOT ENGAGED",
      reason: `no configuration recipe loaded the FIPS provider into the process: no run mapped fips.so and none reported crypto.getFips() enabled, so crypto.subtle cannot have been dispatching into a FIPS provider. ${
        reaching.length > 0
          ? `A configuration path does reach this OpenSSL (${reaching
              .map((entry) => entry.name)
              .join(
                "; ",
              )}), so what failed is the module load, not the configuration channel`
          : "No configuration path was observed to reach this OpenSSL at all, so the configuration channel is what failed"
      }`,
      evidence,
    };
  }
  evidence.push(`the provider was reached through: ${chosen.recipe.name}`);

  const fipsOnlyAes = operationOutcome(fipsOnly, "aes256gcm_round_trip");
  if (!fipsOnlyAes.ok) {
    return {
      verdict: "NOT ENGAGED",
      reason: `AES-256-GCM through crypto.subtle did not complete under the fips-only configuration (${
        fipsOnlyAes.error ? errorLine(fipsOnlyAes.error) : processNote(fipsOnly)
      }), so the product's AEAD call is not being served by the configured provider`,
      evidence,
    };
  }

  const informative = [];
  const stillReachable = [];
  const servedByProvider = [];
  for (const control of ATTRIBUTION_CONTROLS) {
    const atBaseline = operationOutcome(baseline, control.operation);
    const underFips = operationOutcome(fipsOnly, control.operation);
    if (!atBaseline.ok) continue;
    informative.push(control);
    if (!underFips.ok) continue;
    if (control.buildIndependent) stillReachable.push(control);
    else servedByProvider.push(control);
  }
  const decisive = informative.filter((control) => control.buildIndependent);
  if (decisive.length === 0) {
    return {
      verdict: "UNSETTLED",
      reason:
        "no build-independent attribution control was usable: neither the MD5 digest nor the below-minimum RSA keygen succeeded even at baseline, so their failure under the fips-only configuration carries no information about the provider",
      evidence,
    };
  }
  if (stillReachable.length > 0) {
    return {
      verdict: "UNSETTLED",
      reason: `an operation no FIPS provider serves remained available under the fips-only configuration (${stillReachable
        .map((control) => control.name)
        .join(
          ", ",
        )}), so the default provider is still reachable in that process and the AES-256-GCM success cannot be attributed to the FIPS provider`,
      evidence,
    };
  }
  evidence.push(
    `attribution controls that succeed at baseline and fail under the fips-only configuration: ${decisive
      .map((control) => control.name)
      .join(", ")}`,
  );
  if (servedByProvider.length > 0) {
    evidence.push(
      `build-dependent operations that survived, which the algorithm listing should show this provider carrying: ${servedByProvider
        .map((control) => control.name)
        .join(", ")}`,
    );
  }

  const effective = breaks.filter((entry) => entry.effective);
  if (effective.length === 0) {
    return {
      verdict: "UNSETTLED",
      reason: `no causal control took effect (${breaks
        .map((entry) => `${entry.label}: ${entry.why}`)
        .join(
          "; ",
        )}), so nothing shows whether the AES-256-GCM path depends on the provider at all`,
      evidence,
    };
  }
  const survived = effective.filter(
    (entry) => operationOutcome(entry.scenario, "aes256gcm_round_trip").ok,
  );
  if (survived.length > 0) {
    return {
      verdict: "NOT ENGAGED",
      reason: `AES-256-GCM through crypto.subtle still succeeded with the provider broken (${survived
        .map((entry) => entry.label)
        .join(
          ", ",
        )}), so the call is not dispatching through the FIPS provider whatever the fips-only run showed`,
      evidence,
    };
  }
  evidence.push(
    `causal controls that took effect and stopped the call: ${effective
      .map((entry) => entry.label)
      .join(", ")}`,
  );

  return {
    verdict: "ENGAGED",
    reason:
      "AES-256-GCM through crypto.subtle succeeded under a fips-only configuration, every operation no FIPS provider serves failed in that same process, and breaking the provider stopped the call",
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Driver mode: main
// ---------------------------------------------------------------------------

function runDriver() {
  mkdirSync(TMP, { recursive: true });

  const moduleCnfText = readFileSync(FIPS_MODULE_CNF, "utf8");
  const sectionName = fipsSectionName(moduleCnfText);

  heading("crypto.subtle FIPS engagement probe");
  say(`provider build (OpenSSL release tag): ${PROVIDER_TAG}`);
  say(`provider module:                     ${FIPS_MODULE}`);
  say(`provider module config:              ${FIPS_MODULE_CNF}`);
  say(`provider config section:             [${sectionName}]`);
  say(`Node running the probe:              ${process.version}`);
  say(`OpenSSL that Node links:             ${process.versions.openssl}`);
  say(
    `Node built against a shared OpenSSL:  ${process.config.variables.node_shared_openssl ?? "(not reported)"}`,
  );
  say(
    `Node built with an OpenSSL FIPS build: ${process.config.variables.openssl_is_fips ?? "(not reported)"}`,
  );
  say("");
  say(
    "This exercises the same WebCrypto call shape the product's AEAD uses -- a raw",
  );
  say(
    `${AES_KEY_BYTES * 8}-bit AES-GCM key and a ${AES_IV_BYTES}-byte IV, the parameters read from`,
  );
  say(
    "packages/core/src/connection/encryptedMessageConnection.ts in this tree -- but it",
  );
  say(
    "does not import that module. It is a proxy for the AEAD path, not an end-to-end",
  );
  say("run of it.");

  heading("Environment facts, with no configuration applied");
  const enableFips = spawnNode({
    nodeArgs: ["--enable-fips"],
    scriptArgs: ["-p", "require('node:crypto').getFips()"],
  });
  say("node --enable-fips on the stock binary:");
  reportRun(enableFips);
  if (enableFips.stdout.trim() !== "")
    say(`    stdout: ${enableFips.stdout.trim()}`);

  const setFipsRun = spawnNode({
    scriptArgs: [
      "-e",
      "const c = require('node:crypto'); c.setFips(true); console.log('getFips=' + c.getFips());",
    ],
  });
  say("");
  say("crypto.setFips(true) on the stock binary:");
  reportRun(setFipsRun);
  if (setFipsRun.stdout.trim() !== "")
    say(`    stdout: ${setFipsRun.stdout.trim()}`);

  heading("Does the bundled OpenSSL read a configuration file at all");
  say(
    "Each probe below hands Node a configuration that CANNOT load. A run that fails",
  );
  say(
    "is one where that configuration path reached OpenSSL. A run that succeeds is one",
  );
  say(
    "where the path was either not read at all or its error tolerated -- the two are",
  );
  say("not distinguished here, so only the failures are evidence.");

  const absentInclude = writePath(
    "unreadable-include.cnf",
    [
      "config_diagnostics = 1",
      `.include ${join(TMP, "definitely-absent.cnf")}`,
      "",
    ].join("\n"),
  );
  const badProviderBody = [
    "providers = bad_providers",
    "",
    "[bad_providers]",
    "probe_absent = probe_absent_sect",
    "",
    "[probe_absent_sect]",
    `module = ${join(TMP, "definitely-absent.so")}`,
    "activate = 1",
    "",
  ];
  const badProviderOpenssl = writePath(
    "bad-provider-openssl-conf.cnf",
    ["openssl_conf = bad_init", "", "[bad_init]", ...badProviderBody].join(
      "\n",
    ),
  );
  const badProviderNodejs = writePath(
    "bad-provider-nodejs-conf.cnf",
    ["nodejs_conf = bad_init", "", "[bad_init]", ...badProviderBody].join("\n"),
  );
  const emptyModulesDir = join(TMP, "empty-modules");
  mkdirSync(emptyModulesDir, { recursive: true });

  const touchCrypto = [
    "-e",
    "console.log(require('node:crypto').randomBytes(4).toString('hex'));",
  ];
  const mechanismProbes = [
    {
      name: "OPENSSL_CONF pointing at a file with an unreadable .include",
      run: () =>
        spawnNode({
          scriptArgs: touchCrypto,
          env: { OPENSSL_CONF: absentInclude },
        }),
    },
    {
      name: "--openssl-config pointing at a file with an unreadable .include",
      run: () =>
        spawnNode({
          nodeArgs: [`--openssl-config=${absentInclude}`],
          scriptArgs: touchCrypto,
        }),
    },
    {
      name: "OPENSSL_CONF with an unloadable provider under the openssl_conf key",
      run: () =>
        spawnNode({
          scriptArgs: touchCrypto,
          env: { OPENSSL_CONF: badProviderOpenssl },
        }),
    },
    {
      name: "OPENSSL_CONF with an unloadable provider under the nodejs_conf key",
      run: () =>
        spawnNode({
          scriptArgs: touchCrypto,
          env: { OPENSSL_CONF: badProviderNodejs },
        }),
    },
    {
      name: "--openssl-shared-config with an unloadable provider under the openssl_conf key",
      run: () =>
        spawnNode({
          nodeArgs: ["--openssl-shared-config"],
          scriptArgs: touchCrypto,
          env: { OPENSSL_CONF: badProviderOpenssl },
        }),
    },
    {
      name: "OPENSSL_MODULES pointing at a directory holding no fips.so",
      run: () =>
        spawnNode({
          scriptArgs: touchCrypto,
          env: {
            OPENSSL_CONF: providerConfig("modules-probe", {
              includePath: FIPS_MODULE_CNF,
              sectionName,
            }),
            OPENSSL_MODULES: emptyModulesDir,
          },
        }),
    },
  ];
  const mechanismResults = [];
  for (const probe of mechanismProbes) {
    const run = probe.run();
    const applied = run.status !== 0;
    say("");
    say(`${probe.name}:`);
    reportRun(run);
    if (run.stdout.trim() !== "") say(`    stdout: ${run.stdout.trim()}`);
    say(
      `    verdict: ${applied ? "this path REACHED OpenSSL (the run failed on it)" : "no effect observed (the run succeeded regardless)"}`,
    );
    mechanismResults.push({
      name: probe.name,
      reached_openssl: applied,
      status: run.status,
    });
  }

  heading("Which configuration loads the FIPS provider into Node");
  const goodVariant = {
    label: "good",
    sectionName,
    includePath: writePath("fipsmodule-good.cnf", moduleCnfText),
    includeWithModulePath: writePath(
      "fipsmodule-good-module-key.cnf",
      withModuleKey(moduleCnfText, FIPS_MODULE),
    ),
    modulesDir: MODULES_DIR,
  };

  const engagement = [];
  for (const recipe of RECIPES) {
    say("");
    say(`recipe: ${recipe.name}`);
    const scenario = runScenario(
      `engage-${recipe.slug}`,
      invocationFor(recipe.slug, goodVariant),
    );
    const mapped = moduleMapped(scenario);
    const flag = fipsFlag(scenario);
    say(`    verdict: ${scenarioSummary(scenario)}`);
    engagement.push({ recipe, scenario, score: mapped ? 2 : flag ? 1 : 0 });
  }
  const chosen = engagement
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)[0];
  say("");
  if (chosen) {
    say(
      `Chosen configuration for the scenarios below: ${chosen.recipe.name} (fips.so mapped: ${
        moduleMapped(chosen.scenario) ? "yes" : "no"
      }, crypto.getFips(): ${fipsFlag(chosen.scenario) ?? "unavailable"}).`,
    );
  } else {
    say(
      "No configuration loaded the FIPS provider into Node. The scenarios below still",
    );
    say(
      "run under the first recipe so the failure is recorded with its exact errors.",
    );
  }

  const activeRecipe = chosen ? chosen.recipe : RECIPES[0];

  heading("S1 baseline: default configuration, no provider configured");
  const baseline = runScenario("S1-baseline", { nodeArgs: [], env: {} });
  say(`    verdict: ${scenarioSummary(baseline)}`);

  say("");
  say(
    "Same, but calling crypto.setFips(true) first. This is not one of the graded",
  );
  say(
    "scenarios: it records what Node's own FIPS switch does with no provider",
  );
  say(
    "configured, so a raised getFips() is not mistaken for an engaged provider.",
  );
  const setFipsScenario = runScenario("S1b-setFips-default-config", {
    nodeArgs: [],
    env: {},
    childArgs: ["--set-fips"],
  });
  say(`    verdict: ${scenarioSummary(setFipsScenario)}`);

  heading("S2 and S3: fips-only configuration, one process");
  say(
    "S2 is the AES-256-GCM round trip; S3 is the attribution controls beside it.",
  );
  const fipsOnly = runScenario(
    "S2-S3-fips-only",
    invocationFor(activeRecipe.slug, goodVariant),
  );
  say(`    S2 verdict: ${scenarioSummary(fipsOnly)}`);
  for (const control of ATTRIBUTION_CONTROLS) {
    const atBaseline = operationOutcome(baseline, control.operation);
    const underFips = operationOutcome(fipsOnly, control.operation);
    say(
      `    S3 control ${control.name}: baseline ${atBaseline.ok ? "SUCCEEDED" : "FAILED"}, fips-only ${
        underFips.ok ? "SUCCEEDED" : "FAILED"
      }${underFips.error ? ` (${errorLine(underFips.error)})` : ""}`,
    );
  }
  const md5Baseline = operationOutcome(baseline, "md5_digest");
  const md5FipsOnly = operationOutcome(fipsOnly, "md5_digest");
  say(
    `    corroborating (node:crypto, not crypto.subtle) MD5 digest: baseline ${
      md5Baseline.ok ? "SUCCEEDED" : "FAILED"
    }, fips-only ${md5FipsOnly.ok ? "SUCCEEDED" : "FAILED"}`,
  );

  heading("S4 causal controls: break the provider, re-run the same call");
  const corruptedMacText = withCorruptedMac(moduleCnfText);
  const macWasCorrupted = corruptedMacText !== moduleCnfText;
  const brokenMacVariant = {
    label: "broken-mac",
    sectionName,
    includePath: writePath("fipsmodule-broken-mac.cnf", corruptedMacText),
    includeWithModulePath: writePath(
      "fipsmodule-broken-mac-module-key.cnf",
      withModuleKey(corruptedMacText, FIPS_MODULE),
    ),
    modulesDir: MODULES_DIR,
  };

  const truncatedModulesDir = join(TMP, "truncated-modules");
  mkdirSync(truncatedModulesDir, { recursive: true });
  // fips.so can be missing outright -- a build that installed no module, or a
  // prefix that never had one. That is itself a measurement (nothing can load
  // it, so nothing can be engaged), not a harness fault, so record it and skip
  // the truncation instead of dying on the read and leaving the transcript with
  // a stack trace and no verdict.
  let realModuleBytes = null;
  try {
    realModuleBytes = readFileSync(FIPS_MODULE);
  } catch (error) {
    say(
      `fips.so could not be read at ${FIPS_MODULE} (${error.code ?? error.message}), so S4b has nothing to truncate`,
    );
  }
  const truncatedModulePath = join(truncatedModulesDir, "fips.so");
  if (realModuleBytes) {
    writeFileSync(truncatedModulePath, realModuleBytes.subarray(0, 4096));
  }
  const brokenModuleVariant = {
    label: "broken-module",
    sectionName,
    includePath: goodVariant.includePath,
    includeWithModulePath: writePath(
      "fipsmodule-truncated-module-key.cnf",
      withModuleKey(moduleCnfText, truncatedModulePath),
    ),
    modulesDir: truncatedModulesDir,
  };

  say(
    `module-mac corrupted in the copied fipsmodule.cnf: ${macWasCorrupted ? "yes" : "NO -- no module-mac line matched"}`,
  );
  say(
    realModuleBytes
      ? `fips.so truncated to 4096 of ${realModuleBytes.length} bytes at ${truncatedModulePath}`
      : `no fips.so to truncate at ${FIPS_MODULE}`,
  );

  say("");
  say("S4a: the provider config's module-mac corrupted");
  const brokenMac = runScenario(
    "S4a-broken-mac",
    invocationFor(activeRecipe.slug, brokenMacVariant),
  );
  say(`    verdict: ${scenarioSummary(brokenMac)}`);

  say("");
  say("S4b: the provider module truncated");
  const brokenModule = runScenario(
    "S4b-broken-module",
    invocationFor(activeRecipe.slug, brokenModuleVariant),
  );
  say(`    verdict: ${scenarioSummary(brokenModule)}`);

  // A break counts only if the provider really stopped loading under it:
  // otherwise a surviving AES call says nothing about where it dispatched.
  const breaks = [
    {
      label: "S4a (corrupted module-mac)",
      scenario: brokenMac,
      effective: macWasCorrupted && !moduleMapped(brokenMac),
      why: macWasCorrupted
        ? moduleMapped(brokenMac)
          ? "fips.so was still mapped, so the corruption did not stop the load"
          : "fips.so was not mapped"
        : "no module-mac line was found to corrupt",
    },
    {
      label: "S4b (truncated fips.so)",
      scenario: brokenModule,
      effective: realModuleBytes !== null && !moduleMapped(brokenModule),
      why:
        realModuleBytes === null
          ? "there was no fips.so to truncate"
          : moduleMapped(brokenModule)
            ? "fips.so was still mapped, so the truncated module was not the one consulted"
            : "fips.so was not mapped",
    },
  ];
  for (const entry of breaks) {
    say(
      `    ${entry.label}: break ${entry.effective ? "TOOK EFFECT" : "DID NOT TAKE EFFECT"} -- ${entry.why}`,
    );
  }

  heading("Verdict");
  const verdict = computeVerdict({
    baseline,
    chosen,
    fipsOnly,
    breaks,
    mechanisms: mechanismResults,
  });
  for (const line of verdict.evidence) say(`- ${line}`);
  say("");
  say(`QUESTION 3 VERDICT: ${verdict.verdict}`);
  say(`REASON: ${verdict.reason}`);

  const summary = {
    provider_build_tag: PROVIDER_TAG,
    fips_module: FIPS_MODULE,
    node_version: process.version,
    node_openssl_version: process.versions.openssl,
    node_shared_openssl: process.config.variables.node_shared_openssl ?? null,
    cross_load:
      PROVIDER_TAG.replace(/^openssl-/, "")
        .split(".")
        .slice(0, 2)
        .join(".") !==
      String(process.versions.openssl).split(".").slice(0, 2).join("."),
    configuration_mechanisms: mechanismResults,
    engagement: engagement.map((entry) => ({
      recipe: entry.recipe.name,
      fips_module_mapped: moduleMapped(entry.scenario),
      get_fips: fipsFlag(entry.scenario),
      aes_ok: operationOutcome(entry.scenario, "aes256gcm_round_trip").ok,
      exit_status: entry.scenario.run.status,
    })),
    chosen_configuration: chosen ? chosen.recipe.name : null,
    scenarios: Object.fromEntries(
      [baseline, setFipsScenario, fipsOnly, brokenMac, brokenModule].map(
        (scenario) => [
          scenario.label,
          {
            exit_status: scenario.run.status,
            fips_module_mapped: moduleMapped(scenario),
            get_fips: fipsFlag(scenario),
            operations: Object.fromEntries(
              [
                "aes256gcm_round_trip",
                "x25519_derive_bits",
                "rsa1024_keygen",
                "md5_digest",
              ].map((operation) => {
                const outcome = operationOutcome(scenario, operation);
                return [
                  operation,
                  {
                    ran: outcome.ran,
                    ok: outcome.ok,
                    error: errorLine(outcome.error) || null,
                  },
                ];
              }),
            ),
          },
        ],
      ),
    ),
    causal_controls: breaks.map((entry) => ({
      label: entry.label,
      took_effect: entry.effective,
      why: entry.why,
      aes_ok: operationOutcome(entry.scenario, "aes256gcm_round_trip").ok,
    })),
    verdict: verdict.verdict,
    reason: verdict.reason,
  };
  say("");
  say(`PROBE_JSON: ${JSON.stringify(summary)}`);
}

// ---------------------------------------------------------------------------

const childFlagIndex = process.argv.indexOf("--child");
if (childFlagIndex !== -1) {
  await runChild(process.argv[childFlagIndex + 1] ?? "unlabelled", {
    callSetFips: process.argv.includes("--set-fips"),
  });
} else {
  runDriver();
}
