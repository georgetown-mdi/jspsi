import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The root package.json's `allowScripts` map is npm's own install-script policy
// field (npm 11.16 and later, maintained with `npm approve-scripts`): a `false`
// verdict blocks that package's install script, and under the root .npmrc's
// `strict-allow-scripts` a package with no verdict fails the install outright,
// so the map's completeness is what keeps every install from grounding. Two ways
// the map rots with no diagnostic at all. An entry naming a package the tree no
// longer installs matches nothing, so it displays as a live verdict while governing
// nothing. An entry spelled in a form npm cannot honor is either dropped from
// the policy or kept and matched against nothing.
//
// What these properties hold is narrower than npm's own unreviewed set, by
// design: npm decides from a live tree, reading each package's source
// from its dependency edges and each extracted package.json from disk, while
// this reads the committed lockfile. Where the lockfile cannot answer, the check
// refuses the input rather than guessing at it -- an `overrides` form it does
// not model, a key shape it does not model, a source it cannot name. The
// residual it does not cover is enumerated in docs/spec/DEPENDENCY_PINS.md.

const here = dirname(fileURLToPath(import.meta.url));
const readRootJson = (name) =>
  JSON.parse(readFileSync(resolve(here, "..", name), "utf8"));

const VERSION =
  "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?";
const BUILD = "(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?";

// npm compares a single-version key against the version it parsed out of the
// tarball URL as text, and that one is semver-canonical, so only a canonically
// spelled key can ever match: a leading `v` or `=`, a leading zero, or build
// metadata is kept in the policy and matches nothing. A `||` disjunction it runs
// through semver instead, which accepts a leading `v` and build metadata and
// normalizes both away.
const CANONICAL_VERSION = new RegExp(`^${VERSION}$`);
const SEMVER_VERSION = new RegExp(`^v?${VERSION}${BUILD}$`);
const canonical = (version) => version.replace(/^v/, "").replace(/\+.*$/, "");

// A key npm-package-arg treats as a registry name. A key with a scheme or a
// path shape npm treats as a source spec instead and matches against what an
// entry resolved to, which this check does not model.
const PACKAGE_NAME_KEY = /^(?:@[^/@\s]+\/)?[^./@\s][^/@\s]*$/;

const UNHONORED =
  'npm honors a bare name, name@*, one exact version spelled canonically, or exact versions joined by "||". Any other spec form it drops from the policy or keeps and matches against nothing, so the verdict is not in force';
const UNMODELED_KEY =
  'this check reads only a package-name key. A "file:" path, a tarball URL and a git spec are matched by npm against the source an entry resolves to, through a canonicalization this does not model -- model that form here before recording such a verdict';
const UNMODELED_OVERRIDE_KEY =
  'this check reads only a flat "<name>": "<spec>" override, which rewrites every edge on that name. A nested per-parent object, a "." self key and a "name@range" key each rewrite some edges and not others, and the lockfile records neither the override nor which edge it rewrote -- model that form here before declaring one';
const UNMODELED_OVERRIDE_SPEC =
  'this check reads only a semver version or range, which npm resolves from the registry, and a source spec carrying a scheme, a path shape, or npm\'s "owner/repo" shorthand, for which npm honors no name-keyed verdict at all. A dist-tag, an "npm:" alias and a "$name" reference to a root dependency each name a source this does not model -- model that form here before declaring one';

/** Split a policy key into its package name and version spec, scope-aware. */
function splitKey(key) {
  const separator = key.indexOf("@", key.startsWith("@") ? 1 : 0);
  return separator === -1
    ? { name: key, spec: "" }
    : { name: key.slice(0, separator), spec: key.slice(separator + 1) };
}

/**
 * What each policy key states: the name and versions it covers, or the reason
 * npm holds it in force against nothing.
 */
function policyEntries(allowScripts) {
  return Object.entries(allowScripts ?? {}).map(([key, verdict]) => {
    const { name, spec } = splitKey(key);
    if (!PACKAGE_NAME_KEY.test(name)) {
      return { key, verdict, unhonored: UNMODELED_KEY };
    }
    const trimmed = spec.trim();
    if (trimmed === "" || trimmed === "*") {
      return { key, verdict, name, matchesVersion: () => true };
    }
    if (trimmed.includes("||")) {
      const versions = trimmed.split("||").map((part) => part.trim());
      if (!versions.every((version) => SEMVER_VERSION.test(version))) {
        return { key, verdict, unhonored: UNHONORED };
      }
      const covered = versions.map(canonical);
      return {
        key,
        verdict,
        name,
        matchesVersion: (version) => covered.includes(version),
      };
    }
    if (!CANONICAL_VERSION.test(trimmed)) {
      return { key, verdict, unhonored: UNHONORED };
    }
    return {
      key,
      verdict,
      name,
      matchesVersion: (version) => version === trimmed,
    };
  });
}

// The source class npm reads a verdict against comes from the root `overrides`,
// not from the lockfile: an override rewrites the dependency edges npm reads
// each package's source from, and the lockfile records neither the override nor
// the rewritten spec -- every dependent entry keeps the range it declared.
//
// A comparator-set semver range -- comparators optionally joined by `||` --
// leaves the identity model below untouched, because the lockfile records the
// tarball npm resolved the override to and npm decides the verdict at that
// version: measured on npm 11.17, an override moving a transitive
// @parcel/watcher from 2.5.4 to 2.5.6 leaves a verdict keyed at 2.5.4 covering
// nothing (the install fails ESTRICTALLOWSCRIPTS naming 2.5.6) and one keyed at
// 2.5.6 in force. That grammar is narrower than what npm resolves from the
// registry -- a hyphen range (`1.0.0 - 2.0.0`) and a `v`-prefixed version
// (`v2.0.1`) are spellings npm honors and this refuses -- which costs a red
// check naming the form to model, never a verdict read off an unmodeled spec.
//
// A source spec takes every name-keyed verdict out of force. Measured on npm
// 11.17, a transitive dependency overridden to a `file:` tarball or to a remote
// tarball URL spelled in the registry's own <name>/-/<name>-<version>.tgz shape
// fails the install under a name-keyed `true` and under a name-keyed `false`
// alike, reported exactly as with no verdict at all -- while the lockfile entry
// npm writes has that URL in `resolved`, which the identity below would
// otherwise read a name and version out of. A git source is the same class in
// npm's model and is treated as one here unmeasured, for want of a reachable git
// host to measure it against; the assumption costs a refusal, never a verdict.
const PARTIAL_VERSION = `(?:\\d+|[xX*])(?:\\.(?:\\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?${BUILD}`;
const COMPARATOR = `(?:[<>]=?|[~^=])?\\s*${PARTIAL_VERSION}`;
const COMPARATOR_SET = `${COMPARATOR}(?:\\s+${COMPARATOR})*`;
const REGISTRY_OVERRIDE_SPEC = new RegExp(
  `^${COMPARATOR_SET}(?:\\s*\\|\\|\\s*${COMPARATOR_SET})*$`,
);

// A scheme, a path shape, or the bare `owner/repo` npm treats as a git host
// shorthand. npm-package-arg treats `owner/repo` as either a hosted git spec or a
// directory depending on what is on disk, and both readings are non-registry, so
// the class does not turn on which one it picks. The one scheme it excludes is
// `npm:`, an alias that resolves from the registry under another name: which
// name npm then matches a verdict against is unmeasured, so the refusal below
// takes it rather than this rule.
const SOURCE_OVERRIDE_SPEC =
  /^(?!npm:)(?:[A-Za-z][A-Za-z0-9+.-]*:|~?\.{0,2}\/)|^[^@\s/]+\/\S+$/;

/**
 * What each root override states about a package name: the source class npm
 * resolves it from, or the reason this check cannot read one from it.
 */
function overrideEntries(overrides) {
  return Object.entries(overrides ?? {}).map(([key, spec]) => {
    if (typeof spec !== "string" || !PACKAGE_NAME_KEY.test(key)) {
      return { key, unmodeled: UNMODELED_OVERRIDE_KEY };
    }
    const trimmed = spec.trim();
    if (SOURCE_OVERRIDE_SPEC.test(trimmed)) {
      return { key, name: key, source: trimmed };
    }
    if (REGISTRY_OVERRIDE_SPEC.test(trimmed)) {
      return { key, name: key, source: null };
    }
    return { key, unmodeled: UNMODELED_OVERRIDE_SPEC };
  });
}

/** Override forms npm applies and this check cannot read a source class from. */
function unmodeledOverrides(overrides) {
  return overrideEntries(overrides)
    .filter((entry) => entry.unmodeled !== undefined)
    .map((entry) => `"${entry.key}": ${entry.unmodeled}`);
}

/** The names an override points at a source no name-keyed verdict reaches. */
function namesOverriddenToSource(overrides) {
  return new Map(
    overrideEntries(overrides)
      .filter((entry) => typeof entry.source === "string")
      .map((entry) => [entry.name, entry.source]),
  );
}

const NM = "node_modules/";

/** The name an entry is installed under, which is the edge an override keys on. */
const installedAs = (path) => path.slice(path.lastIndexOf(NM) + NM.length);

/**
 * The name and version a registry tarball URL holds, or `null` when it holds
 * none. npm reads both out of this URL and neither out of the entry's own `name`
 * and `version` fields: those come from the tarball's package.json, which its
 * publisher controls and could use to claim another package's verdict. An
 * aliased dependency ("h3-v2": "npm:h3@2") makes the install directory
 * untrustworthy the same way, since it has a name the registry never
 * published -- and this lockfile installs several.
 *
 * A registry tarball lives at <host>/<name>/-/<name>-<version>.tgz, with the
 * registry possibly mounted below the host's root, so the filename is delimited
 * by the LAST `/-/`; the name is the segment before that delimiter, prefixed
 * with the one ahead of it when that is an `@scope`. Requiring a segment before
 * the delimiter at all is what stops a hostile https://host/-/trusted-1.0.0.tgz
 * from claiming a registered name. npm takes the filename off the RAW url and
 * requires the path's own last segment to equal it, so a URL with a query
 * string or fragment -- which private registries emit -- yields no identity
 * rather than one read out of the path.
 */
function registryTarballIdentity(url) {
  if (!/^https?:\/\//.test(url)) return null;
  const filename = basename(url);
  if (!filename.endsWith(".tgz")) return null;
  let pathname;
  try {
    ({ pathname } = new URL(url));
  } catch {
    return null;
  }
  const segments = pathname.slice(1).split("/-/");
  if (segments.length < 2 || segments.pop() !== filename) return null;
  const ownerSegments = segments.pop().split(/\/|%2f/i);
  const project = ownerSegments.pop();
  const scope = ownerSegments.pop();
  if (project === "" || !filename.startsWith(`${project}-`)) return null;
  const version = filename.slice(project.length + 1, -".tgz".length);
  if (!SEMVER_VERSION.test(version)) return null;
  return {
    name: scope?.startsWith("@") ? `${scope}/${project}` : project,
    version: canonical(version),
  };
}

/**
 * The identity npm matches one lockfile entry by, read from the source it
 * resolved to and from the root overrides that rewrote the edge it hangs on.
 * `name` is `null` where that source yields npm no identity -- a `file:` tarball
 * or directory, a git URL, a tarball URL it cannot parse, or any source an
 * override names -- so no name-keyed verdict applies to the entry. An override
 * is keyed both to the name the entry is installed under and to the name its
 * URL holds, since either can be the one the rewritten edge names.
 */
function packageIdentity(path, entry, overriddenToSource = new Map()) {
  const resolved = typeof entry.resolved === "string" ? entry.resolved : null;
  const identity = resolved === null ? null : registryTarballIdentity(resolved);
  const overrideSource =
    overriddenToSource.get(installedAs(path)) ??
    (identity === null ? undefined : overriddenToSource.get(identity.name));
  const named = overrideSource === undefined ? identity : null;
  return {
    path,
    resolved,
    name: named?.name ?? null,
    version: named?.version ?? null,
    overrideSource: overrideSource ?? null,
    hasInstallScript: entry.hasInstallScript === true,
  };
}

/**
 * The lockfile entries npm's install-script gate considers: not the root or a
 * workspace (neither has a node_modules/ path), not a workspace link (whose
 * lifecycle its owner runs), and not a bundled dependency, whose install script
 * npm never runs and no policy entry can allow.
 */
function installedPackages(lock, overrides) {
  const overriddenToSource = namesOverriddenToSource(overrides);
  return Object.entries(lock.packages ?? {})
    .filter(
      ([path, entry]) =>
        path.includes(NM) && entry.link !== true && entry.inBundle !== true,
    )
    .map(([path, entry]) => packageIdentity(path, entry, overriddenToSource));
}

const matches = (entry, pkg) =>
  pkg.name !== null &&
  entry.name === pkg.name &&
  entry.matchesVersion(pkg.version);

/** npm's verdict for one package: a deny beats an allow, `null` if unreviewed. */
function verdictFor(policy, pkg) {
  const applicable = policy.filter(
    (entry) => entry.name !== undefined && matches(entry, pkg),
  );
  if (applicable.some((entry) => entry.verdict === false)) return false;
  if (applicable.some((entry) => entry.verdict === true)) return true;
  return null;
}

/** Keys npm holds in force against nothing, for their spelling or their shape. */
function unhonoredPolicyKeys(policy) {
  return policy
    .filter((entry) => entry.unhonored !== undefined)
    .map((entry) => `"${entry.key}": ${entry.unhonored}`);
}

/** Keys matching no installed package: verdicts governing nothing. */
function deadPolicyKeys(policy, installed) {
  return policy
    .filter(
      (entry) =>
        entry.unhonored === undefined &&
        !installed.some((pkg) => matches(entry, pkg)),
    )
    .map(
      (entry) =>
        `"${entry.key}": no package in package-lock.json matches it -- delete the entry, or pin it to a version the lockfile installs`,
    );
}

/** Install scripts the lockfile records with no verdict covering them. */
function unreviewedInstallScripts(policy, installed) {
  return installed
    .filter((pkg) => pkg.hasInstallScript && verdictFor(policy, pkg) === null)
    .map((pkg) => {
      if (pkg.overrideSource !== null) {
        return `${pkg.path} runs an install script and the root overrides point it at "${pkg.overrideSource}", which npm matches by that spec rather than by any name -- no name-keyed entry can cover it, so drop the override, or record the verdict against the resolved spec and model that key form here`;
      }
      return pkg.name === null
        ? `${pkg.path} runs an install script and resolves to "${pkg.resolved}", which npm matches by that spec rather than by any name -- no name-keyed entry can cover it, so record the verdict against the resolved spec and model that key form here`
        : `${pkg.name}@${pkg.version} (${pkg.path}) runs an install script with no allowScripts verdict -- review what the script does, then record true to allow it or false to block it`;
    });
}

const manifest = readRootJson("package.json");
const policy = policyEntries(manifest.allowScripts);
const installed = installedPackages(
  readRootJson("package-lock.json"),
  manifest.overrides,
);

describe("allowScripts install-script policy", () => {
  it("states every verdict in a form npm holds in force", () => {
    expect(unhonoredPolicyKeys(policy)).toEqual([]);
  });

  it("names only packages the committed lockfile installs", () => {
    expect(deadPolicyKeys(policy, installed)).toEqual([]);
  });

  it("records a verdict for every package with an install script", () => {
    expect(unreviewedInstallScripts(policy, installed)).toEqual([]);
  });

  it("names every package it considers, bar the vendored file: tarball", () => {
    // The install directory has an alias name npm refuses to match, and the
    // dependency edge npm falls back to instead is not visible from a lockfile,
    // so a package this cannot name from its resolved URL is one whose verdict
    // it cannot decide. Only the vendored tarball is in that position, and it
    // stays out of the policy by running no install script; anything else
    // landing there needs its source form modeled before it can be governed.
    const unnamed = installed
      .filter((pkg) => pkg.name === null)
      .map((pkg) => ({
        path: pkg.path,
        vendoredTarball: pkg.resolved?.startsWith("file:") === true,
        hasInstallScript: pkg.hasInstallScript,
      }));
    expect(unnamed).toEqual([
      {
        path: "node_modules/@openmined/psi.js",
        vendoredTarball: true,
        hasInstallScript: false,
      },
    ]);
  });

  it("reads every root override in a form it models", () => {
    expect(unmodeledOverrides(manifest.overrides)).toEqual([]);
  });
});

describe("the identity npm matches a lockfile entry by", () => {
  const identityOf = (path, entry) => {
    const { name, version } = packageIdentity(path, entry);
    return { name, version };
  };

  it("takes an aliased package's name from its resolved URL, not its directory", () => {
    expect(
      identityOf(
        "node_modules/@tanstack/start-server-core/node_modules/h3-v2",
        {
          name: "h3",
          version: "2.0.1-rc.20",
          resolved: "https://registry.npmjs.org/h3/-/h3-2.0.1-rc.20.tgz",
        },
      ),
    ).toEqual({ name: "h3", version: "2.0.1-rc.20" });
  });

  it("keeps a scoped package's scope, which the tarball filename drops", () => {
    expect(
      identityOf("node_modules/@parcel/watcher", {
        version: "2.5.6",
        resolved:
          "https://registry.npmjs.org/@parcel/watcher/-/watcher-2.5.6.tgz",
      }),
    ).toEqual({ name: "@parcel/watcher", version: "2.5.6" });
  });

  it("reads a registry mounted below its host's root", () => {
    expect(
      identityOf("node_modules/@scope/pkg", {
        version: "1.0.0",
        resolved:
          "https://artifacts.example.test/nexus/repository/npm-proxy/@scope/pkg/-/pkg-1.0.0.tgz",
      }),
    ).toEqual({ name: "@scope/pkg", version: "1.0.0" });
  });

  it("refuses a name to a URL with no package path before its /-/", () => {
    expect(
      identityOf("node_modules/h3", {
        version: "2.0.1",
        resolved: "https://downloads.example.test/-/h3-2.0.1.tgz",
      }),
    ).toEqual({ name: null, version: null });
  });

  it("refuses a name to a URL npm's own basename read cannot parse", () => {
    expect(
      identityOf("node_modules/h3", {
        version: "2.0.1",
        resolved: "https://registry.example.test/h3/-/h3-2.0.1.tgz?token=abc",
      }),
    ).toEqual({ name: null, version: null });
  });

  it("prefers the URL's version to the entry's own field", () => {
    expect(
      identityOf("node_modules/pkg", {
        version: "2.0.0",
        resolved: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
      }),
    ).toEqual({ name: "pkg", version: "1.0.0" });
  });

  it("leaves a non-registry source nameless, matched by its resolved spec", () => {
    expect(
      identityOf("node_modules/@openmined/psi.js", {
        version: "2.0.6-seclink.3",
        resolved: "file:lib/openmined-psi.js-2.0.6-seclink.3.tgz",
      }),
    ).toEqual({ name: null, version: null });
  });
});

describe("the verdict npm reaches for a lockfile entry", () => {
  // `h3` installed twice, once under its own name and once as the alias
  // `h3-v2`, which is the shape this repo's lockfile has.
  const aliasedH3 = {
    packages: {
      "node_modules/h3": {
        version: "1.15.11",
        resolved: "https://registry.npmjs.org/h3/-/h3-1.15.11.tgz",
        hasInstallScript: true,
      },
      "node_modules/@tanstack/start-server-core/node_modules/h3-v2": {
        name: "h3",
        version: "2.0.1-rc.20",
        resolved: "https://registry.npmjs.org/h3/-/h3-2.0.1-rc.20.tgz",
        hasInstallScript: true,
      },
    },
  };

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
    const registered = policyEntries({ "h3@1.15.11 || 2.0.1-rc.20": false });
    const packages = installedPackages(aliasedH3);
    expect(unreviewedInstallScripts(registered, packages)).toEqual([]);
    expect(deadPolicyKeys(registered, packages)).toEqual([]);
  });

  it("covers a nested duplicate only at the version it installs", () => {
    const packages = installedPackages({
      packages: {
        "node_modules/fsevents": {
          version: "2.3.3",
          resolved: "https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz",
          hasInstallScript: true,
        },
        "node_modules/playwright/node_modules/fsevents": {
          version: "2.3.2",
          resolved: "https://registry.npmjs.org/fsevents/-/fsevents-2.3.2.tgz",
          hasInstallScript: true,
        },
      },
    });
    const unreviewed = unreviewedInstallScripts(
      policyEntries({ "fsevents@2.3.3": false }),
      packages,
    );
    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0]).toContain(
      "fsevents@2.3.2 (node_modules/playwright/node_modules/fsevents)",
    );
  });

  it("takes no name-keyed verdict for a non-registry source", () => {
    const unreviewed = unreviewedInstallScripts(
      policyEntries({ "@openmined/psi.js": true }),
      installedPackages({
        packages: {
          "node_modules/@openmined/psi.js": {
            version: "2.0.6-seclink.3",
            resolved: "file:lib/openmined-psi.js-2.0.6-seclink.3.tgz",
            hasInstallScript: true,
          },
        },
      }),
    );
    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0]).toContain(
      "record the verdict against the resolved spec",
    );
  });

  it("considers neither a bundled dependency nor a workspace link", () => {
    const packages = installedPackages({
      packages: {
        "apps/cli": {
          name: "psilink",
          version: "0.1.0",
          hasInstallScript: true,
        },
        "node_modules/psilink": { resolved: "apps/cli", link: true },
        "node_modules/@parcel/watcher-wasm/node_modules/napi-wasm": {
          version: "1.1.0",
          inBundle: true,
          hasInstallScript: true,
        },
      },
    });
    expect(unreviewedInstallScripts(policyEntries({}), packages)).toEqual([]);
  });
});

describe("the verdict npm reaches under a root override", () => {
  // One dependent whose declared range the lockfile records unrewritten, beside
  // the entry npm installed for it, which is the only trace an override leaves.
  const overriddenTree = (entry) => ({
    packages: {
      "node_modules/minimatch": {
        version: "9.0.9",
        resolved: "https://registry.npmjs.org/minimatch/-/minimatch-9.0.9.tgz",
        dependencies: { "brace-expansion": "^2.0.2" },
      },
      "node_modules/brace-expansion": entry,
    },
  });

  const registryInstall = {
    version: "5.0.8",
    resolved:
      "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.8.tgz",
    hasInstallScript: true,
  };

  it("holds a verdict at the version a registry override resolves to", () => {
    const packages = installedPackages(overriddenTree(registryInstall), {
      "brace-expansion": "^5.0.8",
    });
    const registered = policyEntries({ "brace-expansion@5.0.8": true });
    expect(unreviewedInstallScripts(registered, packages)).toEqual([]);
    expect(deadPolicyKeys(registered, packages)).toEqual([]);
  });

  it("reads a verdict at the range the dependent declared as dead", () => {
    const packages = installedPackages(overriddenTree(registryInstall), {
      "brace-expansion": "^5.0.8",
    });
    const stale = policyEntries({ "brace-expansion@2.1.2": true });
    expect(deadPolicyKeys(stale, packages)).toHaveLength(1);
    expect(unreviewedInstallScripts(stale, packages)).toHaveLength(1);
  });

  it("takes every name-keyed verdict out of force for an overridden source", () => {
    // The entry resolves to a registry-shaped URL in each case, which is the
    // form the identity model reads a name and version out of: what decides the
    // source is the override's spec, not the lockfile's record of the install.
    for (const source of [
      "file:vendor/brace-expansion.tgz",
      "git+ssh://git@host.test/owner/repo.git#0123456",
      "https://host.test/brace-expansion/-/brace-expansion-5.0.8.tgz",
      "owner/repo",
    ]) {
      const packages = installedPackages(overriddenTree(registryInstall), {
        "brace-expansion": source,
      });
      const named = policyEntries({ "brace-expansion": true });
      const unreviewed = unreviewedInstallScripts(named, packages);
      expect(unreviewed).toHaveLength(1);
      expect(unreviewed[0]).toContain(`point it at "${source}"`);
      expect(deadPolicyKeys(named, packages)).toHaveLength(1);
    }
  });

  it("refuses the name a foreign URL has under an overridden directory", () => {
    const source = "https://host.test/other/-/other-1.0.0.tgz";
    const packages = installedPackages(
      overriddenTree({
        version: "1.0.0",
        resolved: source,
        hasInstallScript: true,
      }),
      { "brace-expansion": source },
    );
    expect(
      unreviewedInstallScripts(policyEntries({ other: true }), packages),
    ).toHaveLength(1);
    expect(
      deadPolicyKeys(policyEntries({ other: true }), packages),
    ).toHaveLength(1);
  });

  it("needs no verdict for an overridden package running no install script", () => {
    const source = "file:vendor/brace-expansion.tgz";
    const packages = installedPackages(
      overriddenTree({ version: "5.0.8", resolved: source }),
      { "brace-expansion": source },
    );
    expect(unreviewedInstallScripts(policyEntries({}), packages)).toEqual([]);
    expect(deadPolicyKeys(policyEntries({}), packages)).toEqual([]);
  });

  it("leaves a package no override names decided by its own source", () => {
    const packages = installedPackages(overriddenTree(registryInstall), {
      "some-other-package": "file:vendor/other.tgz",
    });
    const registered = policyEntries({ "brace-expansion@5.0.8": true });
    expect(unreviewedInstallScripts(registered, packages)).toEqual([]);
    expect(deadPolicyKeys(registered, packages)).toEqual([]);
  });
});

describe("the overrides form this check models", () => {
  it("reads a registry range and a source spec", () => {
    for (const spec of [
      "5.0.8",
      "^5.0.8",
      "~5.0",
      ">=5.0.8 <6.0.0",
      "5.0.8 || 6.0.0",
      "1.x",
      "*",
      "file:vendor/pkg.tgz",
      "./vendor/pkg",
      "https://host.test/pkg/-/pkg-1.0.0.tgz",
      "git+ssh://git@host.test/owner/repo.git#0123456",
      "github:owner/repo",
      "owner/repo",
    ]) {
      expect(unmodeledOverrides({ pkg: spec })).toEqual([]);
    }
  });

  it("refuses a form rewriting some edges on a name and not others", () => {
    for (const overrides of [
      { pkg: { nested: "1.0.0" } },
      { "pkg@^2": "3.0.0" },
      { ".": "1.0.0" },
      { "file:vendor/pkg.tgz": "1.0.0" },
    ]) {
      expect(unmodeledOverrides(overrides)).toHaveLength(1);
      expect(unmodeledOverrides(overrides)[0]).toContain(
        "model that form here before declaring one",
      );
    }
  });

  it("refuses a spec whose source it cannot name", () => {
    for (const spec of ["latest", "npm:other@^1", "$pkg", ""]) {
      expect(unmodeledOverrides({ pkg: spec })).toHaveLength(1);
    }
  });

  it("reads no overrides from a manifest declaring none", () => {
    expect(unmodeledOverrides(undefined)).toEqual([]);
    expect(namesOverriddenToSource(undefined).size).toBe(0);
  });
});

describe("the spec form npm reads a policy key in", () => {
  const unhonored = (key) =>
    unhonoredPolicyKeys(policyEntries({ [key]: true }));

  it("honors a bare name, an exact version, and an exact disjunction", () => {
    for (const key of [
      "esbuild",
      "esbuild@*",
      "esbuild@0.28.1",
      "fsevents@2.3.2 || 2.3.3",
    ]) {
      expect(unhonored(key)).toEqual([]);
    }
  });

  it("refuses a range or a dist-tag, which npm drops from the policy", () => {
    expect(unhonored("esbuild@^0.28.1")).toHaveLength(1);
    expect(unhonored("esbuild@latest")).toHaveLength(1);
  });

  it("refuses a version npm keeps but compares against nothing", () => {
    // Measured on npm 11.17: a single version spelled with a leading `v` or
    // `=`, a leading zero, or build metadata draws no diagnostic and matches no
    // package, because the comparison against the URL-parsed version is textual.
    for (const key of [
      "esbuild@v0.28.1",
      "esbuild@=0.28.1",
      "esbuild@0.28.01",
      "esbuild@0.28.1+build",
    ]) {
      expect(unhonored(key)).toHaveLength(1);
    }
  });

  it("accepts inside a disjunction what semver normalizes away", () => {
    // The same spellings run through semver there, which accepts a leading `v`
    // and build metadata while still rejecting `=` and a leading zero.
    expect(unhonored("esbuild@v0.28.1 || 9.9.9")).toEqual([]);
    expect(unhonored("esbuild@=0.28.1 || 9.9.9")).toHaveLength(1);
  });

  it("refuses a key shape npm matches against a source, not a name", () => {
    for (const key of [
      "file:lib/pkg.tgz",
      "github:owner/repo#0123456",
      "https://host/pkg/-/pkg-1.0.0.tgz",
    ]) {
      expect(unhonored(key)[0]).toContain("model that form here");
    }
  });
});
