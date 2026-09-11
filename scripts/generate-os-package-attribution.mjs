#!/usr/bin/env node
// The OS-layer attribution list for each image this repository builds: every
// package the image's own package manager records, with its version and the
// license string that manager declares.
//
// NOTICE covers the npm tree by construction and `npm sbom` reaches no OS
// package, so the lists this writes beside NOTICE are where a reviewer reads
// the image's OS layer. Each is generated from a built image rather than from a
// Dockerfile: the base image's own packages ship as surely as the ones an
// install instruction names, and no instruction names them.
//
// Two sources, one output. `--query-output` reads the package manager's raw
// stdout, which is what the tests beside this file feed it from captured files;
// `--image` runs the query itself against a tag, which is what
// image_smoke.yaml does against the image that job just built. `--check`
// compares the result against the committed list and names every package that
// differs.
//
// The queries below were run against both built images at both architectures.
// They query the image by tag because neither Dockerfile names its final stage:
// a `--target` query would measure a stage that predates the runtime stage's
// own installs, which on the default image is where `samba-client` arrives. The
// rpm query runs under the FIPS variant's fips-only OpenSSL configuration
// unchanged -- rpm reads its database in C, and the configuration reaches only
// what dnf's Python hashes with.
//
// rpm exits 0 when its format string names a tag that does not exist, printing
// nothing at all, so a run that parses no row fails here rather than reporting
// an empty package set.
//
// A license string is recorded exactly as declared. A disjunction is a
// licensing call rather than a measurement and nothing here resolves one, and
// the two distributions mix notations -- legacy Fedora shorthand beside SPDX
// expressions -- which is the other reason no string is rewritten. A package
// that records no license fails the run naming the package, rather than landing
// in the list with an empty cell; rpm renders an absent tag as the literal
// "(none)", which is the same absence in a different shape.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository this file sits in. */
export function repositoryRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** The columns every list holds, in order. */
export const COLUMNS = ["package", "version", "license"];

/**
 * How rpm renders a header tag the package does not set. A license field
 * holding it records no license, exactly as an empty field does.
 */
export const RPM_ABSENT_TAG = "(none)";

/**
 * Each image, its package-manager query, and the list it is written to.
 *
 * `architectures` is the two-architecture comparison the lists rest on, made
 * once against images built without a layer cache. A stale cached layer moved
 * one package's version between architectures on a first attempt, so a re-run
 * of that comparison builds with `--no-cache` or it measures the cache.
 */
export const IMAGES = {
  default: {
    subject: "the default image",
    dockerfile: "Dockerfile",
    listFile: "NOTICE-os-packages-default.tsv",
    query: "apk list --installed",
    parse: parseApkListInstalled,
    architectures: [
      "linux/amd64 and linux/arm64 were built and queried on 2026-09-11 and",
      "agree on every package's name, version and license, so one list holds",
      "for both. The drift check on .github/workflows/image_smoke.yaml",
      "compares linux/amd64 only, that job building no other architecture.",
    ],
  },
  fips: {
    subject: "the FIPS variant image",
    dockerfile: "Dockerfile.fips",
    listFile: "NOTICE-os-packages-fips.tsv",
    query:
      'rpm -qa --qf "%{NAME}\\t%|EPOCH?{%{EPOCH}}:{0}|\\t%{VERSION}\\t%{RELEASE}\\t%{ARCH}\\t%{LICENSE}\\n"',
    parse: parseRpmQueryOutput,
    architectures: [
      "linux/amd64 and linux/arm64 were built and queried on 2026-09-11 and",
      "agree on every package's name, version and license, so one list holds",
      "for both. The drift check on .github/workflows/image_smoke.yaml",
      "compares linux/amd64 only, that job building no other architecture.",
    ],
  },
};

/** The configuration for one image, refusing a name no image answers to. */
export function imageConfig(variant) {
  if (typeof variant !== "string" || !Object.hasOwn(IMAGES, variant)) {
    throw new Error(
      `no image is named ${variant}; the images are ${Object.keys(IMAGES).join(" and ")}`,
    );
  }
  return IMAGES[variant];
}

// `name-version arch {origin} (license) [installed]`, where the version is the
// trailing `<pkgver>-r<pkgrel>` and a package name holds hyphens of its own
// (alpine-baselayout-data). The license is read to the last `)` before the
// marker, so a parenthesis inside it stays in the string.
const APK_LINE = /^(\S+)\s+(\S+)\s+\{(\S+)\}\s+\((.*)\)\s+\[installed\]$/;
const APK_NAME_VERSION = /^(.+)-([^-]+-r\d+)$/;

/**
 * Rows from `apk list --installed`.
 *
 * The alternative source is `/lib/apk/db/installed`, whose `P:`/`V:`/`L:`
 * fields agree with this output on every package of both built images. This
 * parses the listing because that is the query the image queries document, and
 * because the listing is the shape a CI step pipes in.
 */
export function parseApkListInstalled(text) {
  const rows = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "") continue;
    const fields = APK_LINE.exec(line);
    if (fields === null) {
      throw new Error(
        `apk line ${index + 1} is not a package listing: ${line}`,
      );
    }
    const split = APK_NAME_VERSION.exec(fields[1]);
    if (split === null) {
      throw new Error(
        `apk line ${index + 1} names ${fields[1]}, which ends in no <version>-r<release>`,
      );
    }
    rows.push({ name: split[1], version: split[2], license: fields[4] });
  }
  return rows;
}

/** How many fields the rpm format string emits, and what each one holds. */
const RPM_FIELDS = ["NAME", "EPOCH", "VERSION", "RELEASE", "ARCH", "LICENSE"];

/**
 * Rows from the rpm query, whose version is rendered `epoch:version-release`.
 *
 * The epoch is always written, including the `0` the format string substitutes
 * for a package that sets none, so two packages differing only in epoch are two
 * different versions here. The architecture field is read and dropped: it is
 * the one column the two architectures of an image disagree on, and a list
 * holding it would be an architecture's list rather than an image's.
 */
export function parseRpmQueryOutput(text) {
  const rows = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const fields = line.split("\t");
    if (fields.length !== RPM_FIELDS.length) {
      throw new Error(
        `rpm line ${index + 1} holds ${fields.length} tab-separated fields where the query emits ${RPM_FIELDS.length} (${RPM_FIELDS.join(", ")}): ${line}`,
      );
    }
    const [name, epoch, version, release, , license] = fields;
    rows.push({
      name,
      version: `${epoch}:${version}-${release}`,
      license,
    });
  }
  return rows;
}

/**
 * Every row in the order and the shape a list holds them, or a failure naming
 * what cannot be written.
 *
 * Sorted by name, compared by code unit so the order does not turn on a
 * locale; rows are unique by construction, so no tie-break is needed. A
 * package the manager records no license for fails here, naming the
 * package: an empty cell in an attribution list reads as a package with no
 * license rather than as a measurement that did not answer.
 */
export function normalizeRows(rows) {
  const normalized = [];
  const seen = new Set();
  for (const row of rows) {
    const name = row.name.trim();
    const version = row.version.trim();
    const license = row.license.trim();
    if (name === "" || version === "") {
      throw new Error(
        `a package row names ${name === "" ? "no package" : name} at version "${version}"`,
      );
    }
    if (license === "" || license === RPM_ABSENT_TAG) {
      throw new Error(
        `${name} ${version} records no license (the package manager reports ${license === "" ? "an empty field" : RPM_ABSENT_TAG}); a list states the declared string or the run fails`,
      );
    }
    for (const [column, value] of [
      ["package", name],
      ["version", version],
      ["license", license],
    ]) {
      if (/[\t\n]/.test(value)) {
        throw new Error(
          `${name} ${version} holds a tab or a newline in its ${column} field, which a tab-separated list cannot hold: ${JSON.stringify(value)}`,
        );
      }
    }
    if (seen.has(name)) {
      throw new Error(
        `${name} is installed more than once, and a list keyed by package name cannot state both`,
      );
    }
    seen.add(name);
    normalized.push({ name, version, license });
  }
  normalized.sort((left, right) => compareByCodeUnit(left.name, right.name));
  return normalized;
}

function compareByCodeUnit(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * The base image digest a Dockerfile pins.
 *
 * Every digest-pinned `FROM` in one file must name the same image -- the
 * default image's two stages do, and the FIPS variant's later stages build on
 * a named earlier one -- because a list states one base pin.
 */
export function basePin(dockerfileText, dockerfile) {
  const pins = new Set();
  for (const line of dockerfileText.split("\n")) {
    const pinned = /^FROM\s+(\S+@sha256:[0-9a-f]{64})/.exec(line.trim());
    if (pinned !== null) pins.add(pinned[1]);
  }
  if (pins.size !== 1) {
    throw new Error(
      `${dockerfile} pins ${pins.size} base images by digest (${[...pins].join(", ") || "none"}), and a list states one`,
    );
  }
  return [...pins][0];
}

/** The list text for an image: a commented header, then one row per package. */
export function renderList(variant, rows, pin) {
  const image = imageConfig(variant);
  const lines = [
    `# psilink OS-layer package attribution: ${image.subject}`,
    "#",
    "# Every package installed in the built image, with the version and the",
    "# license string the image's own package manager declares. Generated by",
    "# scripts/generate-os-package-attribution.mjs, which is what to edit and",
    "# re-run; nothing reads a hand edit made here. It accompanies NOTICE,",
    "# which covers this repository's npm tree and no OS package.",
    "#",
    `# image: ${image.subject}, built from ${image.dockerfile}`,
    `# base pin: ${pin}`,
    `# query: ${image.query}`,
    "# architectures:",
    ...image.architectures.map((line) => `#   ${line}`),
    "# license field: the string the package manager declares, not an audit of",
    "#   the package's contents. A disjunctive expression is recorded as",
    "#   declared and resolved nowhere. See docs/spec/CONTAINER_IMAGES.md,",
    "#   Measured inventories.",
    "#",
    `# ${COLUMNS.join("\t")}`,
    ...rows.map((row) => `${row.name}\t${row.version}\t${row.license}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** The package rows a committed list holds, its commented header dropped. */
export function readListRows(text) {
  const rows = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length !== COLUMNS.length) {
      throw new Error(
        `list line ${index + 1} holds ${fields.length} tab-separated fields where a row holds ${COLUMNS.length} (${COLUMNS.join(", ")}): ${line}`,
      );
    }
    rows.push({ name: fields[0], version: fields[1], license: fields[2] });
  }
  return rows;
}

/** The base pin a committed list's header states, or null if it states none. */
export function readListBasePin(text) {
  for (const line of text.split("\n")) {
    const stated = /^#\s*base pin:\s*(\S+)\s*$/.exec(line);
    if (stated !== null) return stated[1];
  }
  return null;
}

/**
 * What moved between a committed list and one generated from a built image:
 * packages added, packages removed, and versions or licenses that changed.
 */
export function compareRows(committed, measured) {
  const before = new Map(committed.map((row) => [row.name, row]));
  const after = new Map(measured.map((row) => [row.name, row]));
  const added = measured.filter((row) => !before.has(row.name));
  const removed = committed.filter((row) => !after.has(row.name));
  const changed = [];
  for (const row of measured) {
    const was = before.get(row.name);
    if (was === undefined) continue;
    if (was.version !== row.version || was.license !== row.license)
      changed.push({ name: row.name, committed: was, measured: row });
  }
  return { added, removed, changed };
}

/** One line per difference, naming the package and what moved. */
export function describeDifferences({ added, removed, changed }) {
  return [
    ...added.map((row) => `added: ${row.name} ${row.version} (${row.license})`),
    ...removed.map(
      (row) => `removed: ${row.name} ${row.version} (${row.license})`,
    ),
    ...changed.flatMap((entry) => {
      const lines = [];
      if (entry.committed.version !== entry.measured.version)
        lines.push(
          `changed: ${entry.name} version ${entry.committed.version} -> ${entry.measured.version}`,
        );
      if (entry.committed.license !== entry.measured.license)
        lines.push(
          `changed: ${entry.name} license ${entry.committed.license} -> ${entry.measured.license}`,
        );
      return lines;
    }),
  ];
}

/** The `docker` arguments that run one image's query against a tag. */
export function dockerQueryArgv(variant, tag) {
  const image = imageConfig(variant);
  if (typeof tag !== "string" || tag.trim() === "")
    throw new Error("no image tag was given to query");
  return ["run", "--rm", "--entrypoint", "sh", tag, "-c", image.query];
}

function queryImage(variant, tag) {
  const argv = dockerQueryArgv(variant, tag);
  const result = spawnSync("docker", argv, {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  if (result.error !== undefined && result.error !== null)
    throw new Error(`docker could not be run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `docker ${argv.join(" ")} exited ${result.status}: ${(result.stderr ?? "").trim()}`,
    );
  }
  const stdout = result.stdout ?? "";
  if (stdout.trim() === "") {
    throw new Error(
      `the query against ${tag} reported no package, which a built image never holds; its stderr was: ${(result.stderr ?? "").trim() || "empty"}`,
    );
  }
  return stdout;
}

/** The list text for an image, from raw package-manager output. */
export function generateList(variant, queryOutput, root = repositoryRoot()) {
  const image = imageConfig(variant);
  const pin = basePin(
    readFileSync(resolve(root, image.dockerfile), "utf8"),
    image.dockerfile,
  );
  return renderList(variant, normalizeRows(image.parse(queryOutput)), pin);
}

function usage() {
  console.error(
    "usage: node scripts/generate-os-package-attribution.mjs <default|fips> --image <tag>\n" +
      "       node scripts/generate-os-package-attribution.mjs <default|fips> --query-output <path|->\n\n" +
      "Writes the image's list beside NOTICE. With --check it writes nothing and\n" +
      "fails when the generated list differs from the committed one, naming every\n" +
      "package that moved. --image needs a Docker daemon and an image built from\n" +
      "this checkout; --query-output takes the raw stdout of that image's own\n" +
      "package-manager query.",
  );
}

function parseArguments(argv) {
  const options = { variant: argv[0], check: false };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check") {
      options.check = true;
      continue;
    }
    if (flag === "--image" || flag === "--query-output") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      options[flag === "--image" ? "image" : "queryOutput"] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${flag}`);
  }
  if (options.variant === undefined || options.variant.startsWith("-"))
    throw new Error("the first argument names the image: default or fips");
  if ((options.image === undefined) === (options.queryOutput === undefined))
    throw new Error("give exactly one of --image and --query-output");
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage();
    process.exit(2);
  }

  const root = repositoryRoot();
  const source =
    options.image === undefined
      ? `--query-output ${options.queryOutput}`
      : `--image ${options.image}`;
  try {
    const image = imageConfig(options.variant);
    const queryOutput =
      options.image === undefined
        ? readFileSync(
            options.queryOutput === "-" ? 0 : options.queryOutput,
            "utf8",
          )
        : queryImage(options.variant, options.image);
    const generated = generateList(options.variant, queryOutput, root);
    const listPath = resolve(root, image.listFile);

    if (!options.check) {
      writeFileSync(listPath, generated);
      const rows = readListRows(generated);
      console.log(`${image.listFile}: ${rows.length} packages`);
    } else {
      const committed = readFileSync(listPath, "utf8");
      if (committed === generated) {
        console.log(
          `${image.listFile}: ${readListRows(committed).length} packages, and the image holds each at the version and license the list states`,
        );
      } else {
        const differences = describeDifferences(
          compareRows(readListRows(committed), readListRows(generated)),
        );
        const statedPin = readListBasePin(committed);
        const generatedPin = readListBasePin(generated);
        if (statedPin !== generatedPin)
          differences.push(
            `base pin: ${statedPin} -> ${generatedPin}, so ${image.dockerfile} names a base the list was not generated from`,
          );
        console.error(
          `${image.listFile} does not state what ${source} reports:`,
        );
        for (const difference of differences) console.error(`  ${difference}`);
        if (differences.length === 0)
          console.error(
            "  the rows agree, so the header differs; regenerate the list",
          );
        console.error(
          `\nRegenerate it with: node scripts/generate-os-package-attribution.mjs ${options.variant} ${source}`,
        );
        process.exit(1);
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
