import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The root package.json's `allowScripts` map is npm's own install-script policy
// field (npm 11.17 and later, maintained with `npm approve-scripts`), read from
// the prefix package.json on every install: a `false` verdict blocks that
// package's install script, and a package with no verdict draws a warning npm
// says a future release will turn into a refusal. Two ways the map rots with no
// diagnostic at all. An entry naming a package the tree no longer installs
// matches nothing, so it reads as a live verdict while governing nothing. An
// entry whose spec form npm cannot honor is either dropped from the policy with
// one warning or kept and matched against nothing, so the verdict it appears to
// state is not in force.
//
// What the properties below hold is that every verdict in the committed map is
// in force and that every install script the committed lockfile records has one.
// They are not npm's own unreviewed set: npm gates on a tree -- the ideal one
// under `--strict-allow-scripts`, the actual one for the post-install advisory --
// and reads each extracted package.json from disk, so it also synthesises
// `node-gyp rebuild` for a package whose tarball carries a `binding.gyp` while
// its lockfile entry carries no `hasInstallScript` flag. That one is invisible
// here, and equally invisible to npm's own pre-extract preflight. Reasoning and
// the posture: docs/spec/DEPENDENCY_PINS.md.
//
// Every property turns on which package a lockfile entry IS, so the identity
// rules npm matches by (@npmcli/arborist/lib/script-allowed.js) are modeled here
// and pinned by the fixture cases at the bottom of the file, each of which
// states behavior measured against npm 11.17 rather than against this model.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const readRootJson = (name) =>
  JSON.parse(readFileSync(resolve(repoRoot, name), "utf8"));

const VERSION =
  "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?";
const BUILD = "(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?";

// npm compares a single-version key against the version it parsed out of the
// tarball URL as strings, and that one is semver-canonical, so only a key
// spelled canonically can ever match: a leading `v` or `=`, a leading zero, or
// build metadata is kept in the policy and matches nothing.
const CANONICAL_VERSION = new RegExp(`^${VERSION}$`);

// What semver itself accepts and then normalizes away: npm runs a `||`
// disjunction through semver, and reads a tarball filename's version through it
// too, so a leading `v` and build metadata are accepted in both places and
// dropped from what the comparison sees.
const SEMVER_VERSION = new RegExp(`^v?${VERSION}${BUILD}$`);
const canonical = (version) => version.replace(/^v/, "").replace(/\+.*$/, "");

/** Split a policy key into its package name and version spec, scope-aware. */
function splitKey(key) {
  const separator = key.indexOf("@", key.startsWith("@") ? 1 : 0);
  return separator === -1
    ? { name: key, spec: "" }
    : { name: key.slice(0, separator), spec: key.slice(separator + 1) };
}

/**
 * How npm reads a name-keyed policy entry, or `null` when it reads it as no
 * verdict at all: a bare name or `*` covers every version, and the only other
 * forms that reach a comparison are one exact version and exact versions joined
 * by `||`.
 */
function registryKeyMatcher(key) {
  const { name, spec } = splitKey(key);
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "*") {
    return { name, matchesVersion: () => true };
  }
  if (trimmed.includes("||")) {
    const versions = trimmed.split("||").map((part) => part.trim());
    if (!versions.every((version) => SEMVER_VERSION.test(version))) {
      return null;
    }
    const comparable = versions.map(canonical);
    return {
      name,
      matchesVersion: (version) =>
        version !== null && comparable.includes(version),
    };
  }
  if (!CANONICAL_VERSION.test(trimmed)) {
    return null;
  }
  return { name, matchesVersion: (version) => version === trimmed };
}

// Key forms npm matches against the source an entry resolves to rather than
// against any name: a `file:` or bare path, a git URL, a remote tarball URL. A
// form npm also reads that way but that is not written like one of these -- a
// bare `owner/repo` git shorthand, a bare tarball filename -- reads as a name
// key here, which reports it as covering nothing rather than taking it as
// coverage.
const RESOLVED_SPEC_KEY =
  /^(?:file:|git[+:@]|ssh:\/\/|https?:\/\/|~?\/|\.\.?\/)/;
const GIT_SPEC = /^(?:git[+:@]|ssh:\/\/)/;

/** A git spec's location, split from the committish it pins. */
function splitCommittish(spec) {
  const location = spec.replace(/^git\+/, "");
  const hash = location.indexOf("#");
  return hash === -1
    ? { location, committish: "" }
    : {
        location: location.slice(0, hash),
        committish: location.slice(hash + 1),
      };
}

/**
 * A git key covers a git source at the same location whose resolved committish
 * starts with the key's -- npm compares a short SHA against the lockfile's
 * 40-character one in that direction only. The location comparison is textual:
 * npm canonicalizes a hosted shorthand through hosted-git-info first, which this
 * does not, so only a key written as the lockfile records the URL reads as
 * coverage.
 */
function gitKeyMatcher(key) {
  const wanted = splitCommittish(key);
  return (spec) => {
    if (!GIT_SPEC.test(spec)) return false;
    const found = splitCommittish(spec);
    return (
      found.location === wanted.location &&
      found.committish.startsWith(wanted.committish)
    );
  };
}

/**
 * The two strings npm compares a path key against: npa's `saveSpec` (the path as
 * written, `file:`-prefixed) and its `fetchSpec` (the same path made absolute
 * against the working directory the install runs in). A lockfile's `file:` entry
 * is absolutized against the project root before the comparison, so only an
 * absolute key matches one; a relative key is in force against nothing.
 */
function pathKeyMatcher(key) {
  const path = (key.startsWith("file:") ? key.slice("file:".length) : key)
    .replace(/^\.\//, "")
    .trim();
  const forms = [`file:${path}`, resolve(repoRoot, path)];
  return (spec) => forms.includes(spec);
}

/** How npm matches a key against the source an entry resolves to. */
function resolvedSpecKeyMatcher(key) {
  if (GIT_SPEC.test(key)) return gitKeyMatcher(key);
  // A remote tarball URL is npa's own saveSpec and fetchSpec both, so npm
  // compares it to the entry's resolved URL as written.
  if (/^https?:\/\//.test(key)) return (spec) => spec === key;
  return pathKeyMatcher(key);
}

/** The name and version predicate, or spec predicate, npm reads out of a key. */
function policyEntries(allowScripts) {
  return Object.entries(allowScripts ?? {}).map(([key, verdict]) =>
    RESOLVED_SPEC_KEY.test(key)
      ? { key, verdict, matchesSpec: resolvedSpecKeyMatcher(key) }
      : { key, verdict, ...(registryKeyMatcher(key) ?? { name: null }) },
  );
}

const NM = "node_modules/";

/**
 * The name and version a registry tarball URL carries, or `null` when it carries
 * none. npm reads both out of this URL and neither out of the entry's own
 * `name` and `version` fields: those come from the tarball's package.json, which
 * its publisher controls and could use to claim another package's verdict. An
 * aliased dependency ("h3-v2": "npm:h3@2") makes the install directory
 * untrustworthy the same way, since it carries a name the registry never
 * published.
 *
 * A registry tarball lives at <host>/<name>/-/<name>-<version>.tgz, with the
 * registry itself possibly mounted below the host's root, so the filename is
 * delimited by the LAST `/-/`; the name is the path segment before that
 * delimiter, prefixed with the segment ahead of it when that one is an `@scope`.
 * Requiring a segment before the delimiter at all is what stops a hostile URL of
 * the form https://host/-/trusted-1.0.0.tgz from claiming a registered name.
 */
function registryTarballIdentity(url) {
  if (!/^https?:\/\//.test(url)) return null;
  let pathname;
  try {
    ({ pathname } = new URL(url));
  } catch {
    return null;
  }
  const segments = pathname.slice(1).split("/-/");
  const filename = segments.pop();
  const owner = segments.pop();
  if (owner === undefined) return null;
  if (filename.includes("/") || !filename.endsWith(".tgz")) return null;
  const ownerSegments = owner.split(/\/|%2f/i);
  const project = ownerSegments.pop();
  const scope = ownerSegments.pop();
  if (!filename.startsWith(`${project}-`)) return null;
  const version = filename.slice(project.length + 1, -".tgz".length);
  if (!SEMVER_VERSION.test(version)) return null;
  return {
    name: scope?.startsWith("@") ? `${scope}/${project}` : project,
    version: canonical(version),
  };
}

/**
 * Whether a dependency spec resolves to the registry, which is what decides
 * whether any name-keyed verdict can apply to what it installs. Everything
 * carrying a scheme, a path shape, or a tarball filename is a source npm matches
 * by resolved spec instead; `npm:` is the exception, an alias for a registered
 * package. A spec this cannot read counts as non-registry, which reports the
 * package it installs as uncovered rather than accepting a name key for it.
 */
function isRegistrySpec(spec) {
  if (spec.startsWith("npm:")) return true;
  return !(
    /^[a-z][a-z\d+.-]*:/i.test(spec) ||
    /^(?:\.{0,2}\/|~\/|\.{1,2}$)/.test(spec) ||
    spec.includes("/") ||
    /\.tgz$|\.tar\.gz$/.test(spec)
  );
}

/**
 * Every dependency spec the lockfile records, by the name its consumer wrote --
 * the edges npm reads a package's source and fallback name from. Collected by
 * name across the whole lockfile rather than per resolution, so an entry can
 * inherit a spec written for another copy of the same name: that can only widen
 * the set of specs an entry is judged by, which costs a report, never coverage.
 */
function dependencySpecsByName(entries) {
  const specs = new Map();
  for (const [, entry] of entries) {
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, spec] of Object.entries(entry[field] ?? {})) {
        specs.set(name, [...(specs.get(name) ?? []), spec]);
      }
    }
  }
  return specs;
}

/**
 * The spec each link entry records for its target, keyed by that target. npm
 * holds the link node's own resolved spec -- the path from the link's directory
 * to the target -- and it is the only key form that keeps the link from running
 * the target's install script.
 */
function linkSpecsByTarget(entries) {
  const specs = new Map();
  for (const [path, entry] of entries) {
    if (entry.link !== true || typeof entry.resolved !== "string") continue;
    const upward = "../".repeat(path.split("/").length - 1);
    specs.set(entry.resolved, [
      ...(specs.get(entry.resolved) ?? []),
      `file:${upward}${entry.resolved}`,
    ]);
  }
  return specs;
}

/**
 * Whether a lockfile path is one of the root package's workspaces, which npm
 * skips along with its link: their lifecycle scripts are the owner's to run, and
 * neither the advisory nor `--strict-allow-scripts` reports them. Only the `*`
 * wildcard is modeled; a pattern this cannot read matches nothing, which reports
 * the workspace as an uncovered package rather than skipping it silently.
 */
function workspacePathMatcher(patterns) {
  const expressions = (patterns ?? [])
    .filter((pattern) => /^[\w.-]+(?:\/[\w.*-]+)*$/.test(pattern))
    .map(
      (pattern) =>
        new RegExp(
          `^${pattern.replace(/\./g, "\\.").replace(/\*/g, "[^/]+")}$`,
        ),
    );
  return (path) => expressions.some((expression) => expression.test(path));
}

/** The specs npm matches one entry's source by. */
function resolvedSourceSpecs(path, resolved, linkSpecs) {
  if (resolved === null) return linkSpecs.get(path) ?? [];
  if (!resolved.startsWith("file:")) return [resolved];
  return [`file:${resolve(repoRoot, resolved.slice("file:".length))}`];
}

/**
 * The name and version npm matches an entry by, or nulls where it matches the
 * entry by resolved spec alone: a source no name key reaches (a `file:` tarball
 * or directory, a git URL, a remote URL -- decided by the specs its consumers
 * wrote, not by the shape of the URL it resolved to), or a registry source whose
 * URL carries no identity, where npm falls back to the consumer's own spec for
 * the name and leaves the version unknown.
 */
function trustedIdentity(directoryName, resolved, incomingSpecs) {
  const unnamed = { name: null, version: null, identitySource: null };
  if (incomingSpecs.length === 0 || !incomingSpecs.every(isRegistrySpec)) {
    return unnamed;
  }
  const fromUrl = resolved === null ? null : registryTarballIdentity(resolved);
  if (fromUrl !== null) return { ...fromUrl, identitySource: "resolvedUrl" };
  const alias = /^npm:((?:@[^/@]+\/)?[^@]+)/.exec(incomingSpecs[0]);
  return {
    name: alias === null ? directoryName : alias[1],
    version: null,
    identitySource: "dependencySpec",
  };
}

/** The identity npm matches one lockfile entry by. */
function packageIdentity(path, entry, { linkSpecs, edgeSpecs }) {
  const resolved = typeof entry.resolved === "string" ? entry.resolved : null;
  // The name after the LAST "node_modules/" segment: npm nests a package whose
  // version conflicts with another consumer's at
  // node_modules/<parent>/node_modules/<name>, and reading the first segment
  // would take that entry's name as "<parent>/node_modules/<name>", which
  // matches no policy key. An entry outside node_modules is a link target, which
  // carries no incoming dependency edge of its own and so no name at all.
  const inNodeModules = path.includes(NM);
  const directoryName = inNodeModules
    ? path.slice(path.lastIndexOf(NM) + NM.length)
    : path;
  return {
    path,
    resolved,
    resolvedSpecs: resolvedSourceSpecs(path, resolved, linkSpecs),
    ...trustedIdentity(
      directoryName,
      resolved,
      inNodeModules ? (edgeSpecs.get(directoryName) ?? []) : [],
    ),
    lockfileVersion: entry.version,
    hasInstallScript: entry.hasInstallScript === true,
  };
}

/**
 * The lockfile entries npm's install-script gate considers: not the project root
 * or a workspace, not a link (its target stands in for it), and not a bundled
 * dependency (npm runs no bundled install script and lets no policy entry allow
 * one, so a verdict naming it governs nothing). A local directory dependency's
 * target is considered even though it sits outside node_modules -- npm reports
 * that one unreviewed and fails `--strict-allow-scripts` on it.
 */
function installedPackages(lock) {
  const entries = Object.entries(lock.packages ?? {});
  const isWorkspace = workspacePathMatcher(lock.packages?.[""]?.workspaces);
  const context = {
    linkSpecs: linkSpecsByTarget(entries),
    edgeSpecs: dependencySpecsByName(entries),
  };
  return entries
    .filter(
      ([path, entry]) =>
        path !== "" &&
        !isWorkspace(path) &&
        entry.link !== true &&
        entry.inBundle !== true,
    )
    .map(([path, entry]) => packageIdentity(path, entry, context));
}

/** Whether npm reads a key against a source's spec rather than against a name. */
const bySpec = (entry) => entry.matchesSpec !== undefined;

const matches = (entry, pkg) =>
  bySpec(entry)
    ? pkg.resolvedSpecs.some((spec) => entry.matchesSpec(spec))
    : pkg.name !== null &&
      entry.name === pkg.name &&
      entry.matchesVersion?.(pkg.version) === true;

/** npm's verdict for one package: a deny beats an allow, `null` if unreviewed. */
function verdictFor(policy, pkg) {
  const applicable = policy.filter((entry) => matches(entry, pkg));
  if (applicable.some((entry) => entry.verdict === false)) return false;
  if (applicable.some((entry) => entry.verdict === true)) return true;
  return null;
}

/** Policy keys npm reads as no verdict at all, stated but not enforced. */
function unhonoredPolicyKeys(policy) {
  return policy
    .filter((entry) => !bySpec(entry) && entry.name === null)
    .map(
      (entry) =>
        `"${entry.key}": npm honors a bare name, name@*, one exact version, or exact versions joined by "||". It drops any other spec form from the policy with one warning (a semver range, a dist-tag) or keeps it and matches it against nothing (a v-prefixed, =-prefixed, leading-zero or build-metadata version, with no diagnostic at all) -- either way the verdict is not in force`,
    );
}

/** Policy keys matching no installed package: verdicts governing nothing. */
function deadPolicyKeys(policy, installed) {
  return policy
    .filter(
      (entry) =>
        !(!bySpec(entry) && entry.name === null) &&
        !installed.some((pkg) => matches(entry, pkg)),
    )
    .map((entry) =>
      bySpec(entry)
        ? `"${entry.key}": no source in package-lock.json resolves to it -- delete the entry, or restate it as the spec the lockfile records`
        : `"${entry.key}": no package in package-lock.json matches it -- delete the entry, or pin it to a name and version the lockfile installs`,
    );
}

/** Install scripts npm would run or report with no verdict covering them. */
function unreviewedInstallScripts(policy, installed) {
  return installed
    .filter((pkg) => pkg.hasInstallScript && verdictFor(policy, pkg) === null)
    .map((pkg) =>
      pkg.name === null
        ? `${pkg.path} runs an install script from a source npm matches by resolved spec rather than by name, so no name-keyed entry can cover it -- record the verdict against ${pkg.resolvedSpecs.map((spec) => `"${spec}"`).join(" or ") || "the spec its consumer writes"}, exactly as written and only where that spec is stable across checkouts, or take the source out of the tree`
        : `${pkg.name}@${pkg.version ?? pkg.lockfileVersion} (${pkg.path}) runs an install script with no allowScripts verdict -- review what the script does, then record true to allow it or false to block it`,
    );
}

const lock = readRootJson("package-lock.json");
const policy = policyEntries(readRootJson("package.json").allowScripts);
const installed = installedPackages(lock);

describe("allowScripts install-script policy", () => {
  it("states every verdict in a spec form npm honors", () => {
    expect(unhonoredPolicyKeys(policy)).toEqual([]);
  });

  it("names only packages the committed lockfile installs", () => {
    expect(deadPolicyKeys(policy, installed)).toEqual([]);
  });

  it("records a verdict for every package with an install script", () => {
    expect(unreviewedInstallScripts(policy, installed)).toEqual([]);
  });

  it("identifies every package it names from a resolved URL, not a spec", () => {
    // A name and version read from the resolved URL are the pair npm matches on.
    // Where the URL yields neither, npm falls back to the consumer's dependency
    // spec for the name and to no version at all, so a package resting on that
    // fallback is one this check could name wrongly and could not pin a version
    // for. None does while every entry resolves to a URL carrying both; an entry
    // that stopped (a lockfile written with omit-lockfile-registry-resolved, a
    // registry whose tarball filenames disagree with their paths) has to be
    // identified some other way.
    const namedByFallback = installed
      .filter((pkg) => pkg.identitySource === "dependencySpec")
      .map((pkg) => pkg.path);
    expect(namedByFallback).toEqual([]);
  });
});

// One root entry, its dependency specs, and the entries they install: the shape
// every case below needs, since which package an entry IS turns on the specs its
// consumers wrote for it.
const lockfileWith = (dependencies, packages, workspaces) => ({
  packages: {
    "": { dependencies, ...(workspaces ? { workspaces } : {}) },
    ...packages,
  },
});

const registryTarball = (name, version) =>
  `https://registry.npmjs.org/${name}/-/${name.replace(/^@[^/]+\//, "")}-${version}.tgz`;

const identityOf = (lock, path) =>
  installedPackages(lock).find((pkg) => pkg.path === path);

describe("the spec form npm reads a policy key in", () => {
  // Measured on npm 11.17 against a local registry, installing a package whose
  // install script writes a marker file: each key below either blocked the
  // script or left it running with the package reported unreviewed.
  const localdep = lockfileWith(
    { localdep: "1.0.0" },
    {
      "node_modules/localdep": {
        version: "1.0.0",
        resolved: registryTarball("localdep", "1.0.0"),
        hasInstallScript: true,
      },
    },
  );
  const under = (allowScripts) => {
    const entries = policyEntries(allowScripts);
    return {
      unhonored: unhonoredPolicyKeys(entries),
      unreviewed: unreviewedInstallScripts(
        entries,
        installedPackages(localdep),
      ),
    };
  };

  it("matches one exact version as text, so build metadata covers nothing", () => {
    const { unhonored, unreviewed } = under({ "localdep@1.0.0+build": false });
    expect(unhonored).toHaveLength(1);
    expect(unreviewed).toHaveLength(1);
  });

  it("matches a || disjunction by semver, which ignores build metadata", () => {
    expect(under({ "localdep@1.0.0+build || 9.9.9": false })).toMatchObject({
      unhonored: [],
      unreviewed: [],
    });
  });

  it("takes a v-prefixed version inside a disjunction but not alone", () => {
    expect(under({ "localdep@v1.0.0": false }).unreviewed).toHaveLength(1);
    expect(under({ "localdep@v1.0.0 || 9.9.9": false }).unreviewed).toEqual([]);
  });

  it("keeps an =-prefixed or leading-zero version and matches neither", () => {
    const { unhonored } = under({
      "localdep@=1.0.0": false,
      "localdep@1.0.01": false,
    });
    expect(unhonored).toHaveLength(2);
    // npm warns about neither, so the remediation must not promise a warning.
    expect(unhonored[0]).toContain("with no diagnostic at all");
  });

  it("drops a semver range or a dist-tag with one warning", () => {
    expect(
      under({ "localdep@^1.0.0": false, "localdep@latest": false }).unhonored,
    ).toHaveLength(2);
  });

  it("covers every installed version from a bare name or name@*", () => {
    expect(under({ localdep: false }).unreviewed).toEqual([]);
    expect(under({ "localdep@*": false }).unreviewed).toEqual([]);
  });
});

describe("the identity npm matches a lockfile entry by", () => {
  it("takes an aliased package's name from its resolved URL, not its directory", () => {
    const lock = lockfileWith(
      { "h3-v2": "npm:h3@2.0.1-rc.20" },
      {
        "node_modules/@tanstack/start-server-core/node_modules/h3-v2": {
          name: "h3",
          version: "2.0.1-rc.20",
          resolved: registryTarball("h3", "2.0.1-rc.20"),
        },
      },
    );
    expect(
      identityOf(
        lock,
        "node_modules/@tanstack/start-server-core/node_modules/h3-v2",
      ),
    ).toMatchObject({ name: "h3", version: "2.0.1-rc.20" });
  });

  it("keeps a scoped package's scope, which the tarball filename drops", () => {
    const lock = lockfileWith(
      { "@parcel/watcher": "^2.5.6" },
      {
        "node_modules/@parcel/watcher": {
          version: "2.5.6",
          resolved: registryTarball("@parcel/watcher", "2.5.6"),
        },
      },
    );
    expect(identityOf(lock, "node_modules/@parcel/watcher")).toMatchObject({
      name: "@parcel/watcher",
    });
  });

  it("reads a name from a registry mounted below its host's root", () => {
    const lock = lockfileWith(
      { "@scope/pkg": "1.0.0" },
      {
        "node_modules/@scope/pkg": {
          version: "1.0.0",
          resolved:
            "https://artifacts.example.test/nexus/repository/npm-proxy/@scope/pkg/-/pkg-1.0.0.tgz",
        },
      },
    );
    expect(identityOf(lock, "node_modules/@scope/pkg")).toMatchObject({
      name: "@scope/pkg",
      version: "1.0.0",
    });
  });

  it("refuses the name a URL with no package path before its /-/ claims", () => {
    // Requiring a segment before the delimiter is what stops a hostile URL from
    // lifting a registered package's verdict. Driving npm's own matcher over
    // this entry: the key "trusted" and the key "trusted@1.0.0" both leave it
    // unreviewed, and only the name its consumer wrote covers it.
    const lock = lockfileWith(
      { pkg: "^1.0.0" },
      {
        "node_modules/pkg": {
          version: "1.0.0",
          resolved: "https://evil.test/-/trusted-1.0.0.tgz",
          hasInstallScript: true,
        },
      },
    );
    expect(identityOf(lock, "node_modules/pkg")).toMatchObject({
      name: "pkg",
      version: null,
      identitySource: "dependencySpec",
    });
    expect(
      unreviewedInstallScripts(
        policyEntries({ trusted: false, "trusted@1.0.0": false }),
        installedPackages(lock),
      ),
    ).toHaveLength(1);
  });

  it("takes the version from the resolved URL, not the version field", () => {
    // Measured: with the lockfile's own version field edited to 2.0.0 while the
    // resolved URL still names 1.0.0, npm blocked the script under
    // "localdep@1.0.0" and ran it under "localdep@2.0.0", reporting the package
    // as localdep@1.0.0.
    const lock = lockfileWith(
      { localdep: "*" },
      {
        "node_modules/localdep": {
          version: "2.0.0",
          resolved: registryTarball("localdep", "1.0.0"),
          hasInstallScript: true,
        },
      },
    );
    expect(identityOf(lock, "node_modules/localdep")).toMatchObject({
      version: "1.0.0",
    });
    expect(
      unreviewedInstallScripts(
        policyEntries({ "localdep@2.0.0": false }),
        installedPackages(lock),
      ),
    ).toHaveLength(1);
    expect(
      unreviewedInstallScripts(
        policyEntries({ "localdep@1.0.0": false }),
        installedPackages(lock),
      ),
    ).toEqual([]);
  });

  it("names a package with no resolved URL but pins no version for it", () => {
    // Measured under omit-lockfile-registry-resolved: npm blocked the script
    // under "localdep" and ran it under "localdep@1.0.0", the version the
    // lockfile entry itself records.
    const lock = lockfileWith(
      { localdep: "1.0.0" },
      {
        "node_modules/localdep": { version: "1.0.0", hasInstallScript: true },
      },
    );
    expect(identityOf(lock, "node_modules/localdep")).toMatchObject({
      name: "localdep",
      version: null,
      identitySource: "dependencySpec",
    });
    expect(
      unreviewedInstallScripts(
        policyEntries({ "localdep@1.0.0": false }),
        installedPackages(lock),
      ),
    ).toHaveLength(1);
    expect(
      unreviewedInstallScripts(
        policyEntries({ localdep: false }),
        installedPackages(lock),
      ),
    ).toEqual([]);
  });

  it("names an aliased package from the alias spec with no resolved URL", () => {
    // Driving npm's own matcher over this entry: only the bare registered name
    // covers it -- not the alias, and not the registered name at a version.
    const lock = lockfileWith(
      { "h3-v2": "npm:h3@2.0.1-rc.20" },
      {
        "node_modules/h3-v2": {
          name: "h3",
          version: "2.0.1-rc.20",
          hasInstallScript: true,
        },
      },
    );
    expect(identityOf(lock, "node_modules/h3-v2")).toMatchObject({
      name: "h3",
      identitySource: "dependencySpec",
    });
    expect(
      unreviewedInstallScripts(
        policyEntries({ h3: false }),
        installedPackages(lock),
      ),
    ).toEqual([]);
    expect(
      unreviewedInstallScripts(
        policyEntries({ "h3-v2": false, "h3@2.0.1-rc.20": false }),
        installedPackages(lock),
      ),
    ).toHaveLength(1);
  });

  it("refuses a name-keyed verdict to a URL its consumer wrote as the spec", () => {
    // Measured: a dependency written as a registry-shaped tarball URL installs a
    // lockfile entry indistinguishable from a registry install, but npm ran the
    // script under both "localdep" and "localdep@1.0.0" and blocked it only
    // under the URL. The spec its consumer wrote is the whole difference.
    const remote = lockfileWith(
      { localdep: "http://127.0.0.1:8977/localdep/-/localdep-1.0.0.tgz" },
      {
        "node_modules/localdep": {
          version: "1.0.0",
          resolved: "http://127.0.0.1:8977/localdep/-/localdep-1.0.0.tgz",
          hasInstallScript: true,
        },
      },
    );
    expect(identityOf(remote, "node_modules/localdep")).toMatchObject({
      name: null,
    });
    expect(
      unreviewedInstallScripts(
        policyEntries({ localdep: false, "localdep@1.0.0": false }),
        installedPackages(remote),
      ),
    ).toHaveLength(1);
    expect(
      unreviewedInstallScripts(
        policyEntries({
          "http://127.0.0.1:8977/localdep/-/localdep-1.0.0.tgz": false,
        }),
        installedPackages(remote),
      ),
    ).toEqual([]);
  });
});

describe("the packages npm's install-script gate considers", () => {
  it("considers no bundled dependency, whose install script never runs", () => {
    const bundled = lockfileWith(
      { "@parcel/watcher-wasm": "^2.5.6" },
      {
        "node_modules/@parcel/watcher-wasm/node_modules/napi-wasm": {
          version: "1.1.0",
          inBundle: true,
          hasInstallScript: true,
        },
      },
    );
    expect(
      unreviewedInstallScripts(policyEntries({}), installedPackages(bundled)),
    ).toEqual([]);
    expect(
      deadPolicyKeys(
        policyEntries({ "napi-wasm": false }),
        installedPackages(bundled),
      ),
    ).toHaveLength(1);
  });

  it("considers neither a workspace nor its link, whose owner runs both", () => {
    // Measured: a workspace whose package.json declares an install script runs
    // it with no advisory, and `--strict-allow-scripts` does not fail on it.
    const workspace = lockfileWith(
      {},
      {
        "apps/cli": {
          name: "psilink",
          version: "0.1.0",
          hasInstallScript: true,
        },
        "node_modules/psilink": { resolved: "apps/cli", link: true },
      },
      ["apps/*"],
    );
    expect(
      unreviewedInstallScripts(policyEntries({}), installedPackages(workspace)),
    ).toEqual([]);
    expect(
      deadPolicyKeys(
        policyEntries({ psilink: false }),
        installedPackages(workspace),
      ),
    ).toHaveLength(1);
  });

  // `"localdir": "file:../localdir"`, whose target npm records as the lockfile
  // entry "../localdir" -- outside node_modules, with the install script's flag
  // on it and a link at node_modules/localdir pointing back.
  const localDirectory = installedPackages(
    lockfileWith(
      { localdir: "file:../localdir" },
      {
        "../localdir": { version: "2.0.0", hasInstallScript: true },
        "node_modules/localdir": { resolved: "../localdir", link: true },
      },
    ),
  );

  it("considers a local directory dependency, which npm reports unreviewed", () => {
    // Measured: npm ran that install script, reported the package unreviewed,
    // and failed --strict-allow-scripts on it, under both name keys below.
    const unreviewed = unreviewedInstallScripts(
      policyEntries({ localdir: false, "localdir@2.0.0": false }),
      localDirectory,
    );
    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0]).toContain("../localdir runs an install script");
  });

  it("covers a local directory dependency only from its link's own spec", () => {
    // Measured: only "file:../../localdir", the spec the link records, stopped
    // the script. "file:../localdir" and the absolute forms match the target and
    // silence npm's advisory while the link still runs the script, so they are
    // not coverage.
    expect(
      unreviewedInstallScripts(
        policyEntries({ "file:../../localdir": false }),
        localDirectory,
      ),
    ).toEqual([]);
    expect(
      deadPolicyKeys(
        policyEntries({ "file:../localdir": false }),
        localDirectory,
      ),
    ).toHaveLength(1);
  });
});

describe("the verdict npm reaches for a lockfile entry", () => {
  // `h3` installed twice: once under its own name, once as the alias `h3-v2`,
  // which is the shape this repo's lockfile carries.
  const aliasedH3 = lockfileWith(
    { h3: "^1.15.11", "h3-v2": "npm:h3@2.0.1-rc.20" },
    {
      "node_modules/h3": {
        version: "1.15.11",
        resolved: registryTarball("h3", "1.15.11"),
        hasInstallScript: true,
      },
      "node_modules/@tanstack/start-server-core/node_modules/h3-v2": {
        name: "h3",
        version: "2.0.1-rc.20",
        resolved: registryTarball("h3", "2.0.1-rc.20"),
        hasInstallScript: true,
      },
    },
  );

  it("leaves an install script unreviewed under an alias-named verdict", () => {
    const unreviewed = unreviewedInstallScripts(
      policyEntries({ "h3-v2": false }),
      installedPackages(aliasedH3),
    );
    expect(unreviewed).toHaveLength(2);
    expect(unreviewed.join("\n")).toContain(
      "h3@2.0.1-rc.20 (node_modules/@tanstack/start-server-core/node_modules/h3-v2)",
    );
  });

  it("reads an alias-named verdict as governing nothing", () => {
    expect(
      deadPolicyKeys(
        policyEntries({ "h3-v2": false }),
        installedPackages(aliasedH3),
      ),
    ).toHaveLength(1);
  });

  it("covers both installs from one verdict on the registered name", () => {
    const registeredName = policyEntries({
      "h3@1.15.11 || 2.0.1-rc.20": false,
    });
    expect(
      unreviewedInstallScripts(registeredName, installedPackages(aliasedH3)),
    ).toEqual([]);
    expect(
      deadPolicyKeys(registeredName, installedPackages(aliasedH3)),
    ).toEqual([]);
  });

  it("covers a nested duplicate only at the version it installs", () => {
    const bothVersions = lockfileWith(
      { fsevents: "^2.3.3" },
      {
        "node_modules/fsevents": {
          version: "2.3.3",
          resolved: registryTarball("fsevents", "2.3.3"),
          hasInstallScript: true,
        },
        "node_modules/playwright/node_modules/fsevents": {
          version: "2.3.2",
          resolved: registryTarball("fsevents", "2.3.2"),
          hasInstallScript: true,
        },
      },
    );
    const unreviewed = unreviewedInstallScripts(
      policyEntries({ "fsevents@2.3.3": false }),
      installedPackages(bothVersions),
    );
    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0]).toContain(
      "fsevents@2.3.2 (node_modules/playwright/node_modules/fsevents)",
    );
  });

  const vendored = lockfileWith(
    { "@openmined/psi.js": "file:lib/openmined-psi.js-2.0.6-seclink.3.tgz" },
    {
      "node_modules/@openmined/psi.js": {
        version: "2.0.6-seclink.3",
        resolved: "file:lib/openmined-psi.js-2.0.6-seclink.3.tgz",
        hasInstallScript: true,
      },
    },
  );

  it("takes no name-keyed verdict for a file: source", () => {
    const unreviewed = unreviewedInstallScripts(
      policyEntries({ "@openmined/psi.js": true }),
      installedPackages(vendored),
    );
    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0]).toContain(
      "matches by resolved spec rather than by name",
    );
  });

  it("covers a file: source only from the absolute path npm resolves to", () => {
    // Measured: with the dependency written `file:localdep-1.0.0.tgz`, npm
    // blocked the script under the absolute "file:" key and ran it under the
    // relative one -- it absolutizes the entry's resolved spec but not the key's.
    const absolute = `file:${repoRoot}/lib/openmined-psi.js-2.0.6-seclink.3.tgz`;
    expect(
      unreviewedInstallScripts(
        policyEntries({ [absolute]: false }),
        installedPackages(vendored),
      ),
    ).toEqual([]);
    expect(
      deadPolicyKeys(
        policyEntries({
          "file:lib/openmined-psi.js-2.0.6-seclink.3.tgz": false,
        }),
        installedPackages(vendored),
      ),
    ).toHaveLength(1);
  });

  it("covers a git source from a committish its resolved SHA starts with", () => {
    const git = lockfileWith(
      { tool: "github:example/tool#0123456" },
      {
        "node_modules/tool": {
          version: "1.0.0",
          resolved:
            "git+ssh://git@github.com/example/tool.git#0123456789abcdef0123456789abcdef01234567",
          hasInstallScript: true,
        },
      },
    );
    expect(identityOf(git, "node_modules/tool")).toMatchObject({ name: null });
    expect(
      unreviewedInstallScripts(
        policyEntries({
          "git+ssh://git@github.com/example/tool.git#0123456": false,
        }),
        installedPackages(git),
      ),
    ).toEqual([]);
    expect(
      deadPolicyKeys(
        policyEntries({
          "git+ssh://git@github.com/example/tool.git#fedcba9": false,
        }),
        installedPackages(git),
      ),
    ).toHaveLength(1);
  });
});
