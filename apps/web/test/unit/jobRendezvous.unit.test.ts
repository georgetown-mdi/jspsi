import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  MAX_ENDPOINT_PATH_LENGTH,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  renderedDisplayCost,
  sanitizeForDisplay,
} from "@psilink/core";

import { MAX_INPUT_NAME_LENGTH } from "@jobs/workInputName";
import { SWEEP_CONTROL_LABEL } from "@psi/runDiagnosticsModel";
import { appendSanitizedRunWarning } from "@psi/runWarnings";

import {
  MAX_NAMED_RENDEZVOUS_ENTRIES,
  RENDEZVOUS_NOTICE_BUDGET,
  jobRendezvousDirs,
  notEmptyLead,
  rendezvousSplitFaults,
  rendezvousStartupWarnings,
  resolveJobRendezvousFolderName,
  resolveJobRendezvousOutboundDir,
  resolveJobRendezvousProvisioning,
  useJobRendezvousProvisioning,
} from "@jobs/jobRendezvous";

import type { RendezvousLeg } from "@jobs/jobRendezvous";

const dirs: Array<string> = [];

/** The random characters `fs.mkdtempSync` appends to the prefix it is handed. */
const MKDTEMP_SUFFIX_LENGTH = 6;

/** The prefix {@link tempDir} hands `mkdtempSync` for `label`. */
function tempDirPrefix(label: string): string {
  return `psilink-${label}-`;
}

/** What the directory {@link tempDir} creates for a mount spends of a path budget
 * before the mount has a name of its own. Stands in for a real one where the
 * question is only the length. */
const TEMP_DIR_SEGMENT = `${tempDirPrefix("rendezvous")}${"X".repeat(
  MKDTEMP_SUFFIX_LENGTH,
)}`;

/**
 * What the mount an "ordinary" budget case is driven at renders to, pinned rather
 * than left to whatever the host's temp root happens to make it.
 *
 * Ordinary means short enough that the notice about the mount still names it --
 * tens of characters past what {@link RENDEZVOUS_NOTICE_BUDGET}'s own copy
 * leaves, checked by the assumption test below rather than asserted here. A
 * mkdtemp directory and a short name measure this much under a `/tmp` root, so
 * the pin changes nothing where the root is already short and matches every
 * host's notice.
 */
const ORDINARY_MOUNT_COST = 36;

/** Whether a mount pinned to {@link ORDINARY_MOUNT_COST} still has a name of its
 * own under `root`, once the directory {@link tempDir} creates there is paid for. */
function fitsOrdinaryMount(root: string): boolean {
  return (
    renderedDisplayCost(path.join(root, TEMP_DIR_SEGMENT, "d")) <=
    ORDINARY_MOUNT_COST
  );
}

/** The short temp root every POSIX host has, whatever its own `os.tmpdir()` is. */
const POSIX_SHORT_TEMP_ROOT = "/tmp";

/**
 * The root the directories here are created under: `os.tmpdir()` where that is
 * short enough to build an ordinary mount under, and `/tmp` where it is not.
 *
 * The host's own root is not a safe default for a mount a notice must NAME: the
 * budget leaves only tens of characters once the notice's own copy is spent --
 * less than the gap between the `/tmp` a Linux host hands `os.tmpdir()` and the
 * `/var/folders/<hash>/T` a macOS one does. Rooted at the host's own temp dir,
 * an "ordinary" mount would fit on the one host and blow the budget on the
 * other, making a host difference look like a product regression.
 *
 * A host with no short root of its own -- Windows, whose temp dir is long and whose
 * drive root is not writable -- is served by pointing TMPDIR (TEMP there) at a short
 * writable directory, which `os.tmpdir()` then returns. {@link ordinaryMount} is
 * the check that says so.
 */
const TEST_TEMP_ROOT =
  fitsOrdinaryMount(os.tmpdir()) || process.platform === "win32"
    ? os.tmpdir()
    : POSIX_SHORT_TEMP_ROOT;

/** A fresh, existing, writable directory under {@link TEST_TEMP_ROOT}, so the
 * preflight's stat checks pass and only the overlap branch can add a warning. */
function tempDir(label: string, root: string = TEST_TEMP_ROOT): string {
  const dir = fs.mkdtempSync(path.join(root, tempDirPrefix(label)));
  dirs.push(dir);
  return dir;
}

/** Cyrillic small a: one character of a path that the display boundary escapes six
 * characters wide, so a fragment built from it costs six times what its own length
 * says. Written as an escape because the point of it is that a reader cannot tell it
 * from the Latin letter. */
const WIDE_ESCAPING_CHAR = "\u0430";

/** The launch's sweep intent as the preflight reads it: the console's "Clear
 * leftover exchange files" control left off, which is every case but the one the
 * sweep-aware recovery is about. */
const SWEEP_OFF = false;

/** The same intent with the sweep control turned on for this launch. */
const SWEEP_ON = true;

/** A nested (existing, writable) subdirectory of `parent`. */
function subDir(parent: string, name: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir);
  dirs.push(dir);
  return dir;
}

/** The split pair's refusal for an environment, as every gate that consumes the
 * provisioning reads it. */
function splitProblem(env: NodeJS.ProcessEnv): string | undefined {
  return resolveJobRendezvousProvisioning(env).problem;
}

/**
 * Fail `fs.realpathSync` with `EACCES` for `unreadable` and every path under it --
 * the shape a mount with an unreadable component on the way to it takes -- until
 * the returned restore is called.
 *
 * Injected rather than driven off a real directory mode: a suite running as root
 * traverses a `0000` directory anyway, so the case would silently stop being
 * exercised on exactly the hosts (containers) the console runs in.
 */
function blockRealpath(unreadable: string): () => void {
  const realpathSync = fs.realpathSync;
  const blocked = path.resolve(unreadable);
  const spy = vi
    .spyOn(fs, "realpathSync")
    .mockImplementation((target, options) => {
      const resolved = path.resolve(String(target));
      if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
        const error: NodeJS.ErrnoException = new Error(
          "EACCES: permission denied",
        );
        error.code = "EACCES";
        throw error;
      }
      return realpathSync(target, options);
    });
  return () => spy.mockRestore();
}

/** Run `body` with {@link blockRealpath} in force for `unreadable`. */
function withUnreadableRealpath<T>(unreadable: string, body: () => T): T {
  const restore = blockRealpath(unreadable);
  try {
    return body();
  } finally {
    restore();
  }
}

/**
 * Run `body` with `alias` reporting the filesystem identity of `target`: two real,
 * separately resolvable paths whose `(st_dev, st_ino)` pairs are one directory's,
 * which is what one host directory bind-mounted at two container paths looks like
 * from inside the container.
 *
 * Injected because the shape cannot be built in a unit test: a bind mount takes
 * privileges the suite does not have, and a hard link to a directory is refused
 * outright. `realpathSync` is left alone, so the two paths stay as unrelated to each
 * other as the resolution's path comparisons can see -- the identity is the only
 * thing that relates them.
 */
function withAliasedInode<T>(alias: string, target: string, body: () => T): T {
  const statSync = fs.statSync;
  const aliased = path.resolve(alias);
  const spy = vi
    .spyOn(fs, "statSync")
    .mockImplementation((entry: fs.PathLike, options?: fs.StatSyncOptions) =>
      statSync(
        path.resolve(String(entry)) === aliased ? target : entry,
        options,
      ),
    );
  try {
    return body();
  } finally {
    spy.mockRestore();
  }
}

/**
 * Run `body` with `fs.statSync` failing `EACCES` for `unreadable` alone -- a
 * directory the process can name and resolve but not stat, the shape a mount under
 * an unsearchable parent takes. Every other path stats normally, so the identity
 * walk still reads the rest of the chain.
 *
 * Injected for the reason {@link blockRealpath} is: a suite running as root stats
 * through a `0000` parent anyway, so a case driven off a real directory mode would
 * silently stop being exercised on exactly the hosts (containers) the console runs
 * in. `EACCES` rather than `ENOENT` is the whole point of the case -- a directory
 * that is not there aliases nothing, while one that could not be read is precisely
 * where the aliasing would sit.
 */
function withUnreadableStat<T>(unreadable: string, body: () => T): T {
  const statSync = fs.statSync;
  const blocked = path.resolve(unreadable);
  const spy = vi
    .spyOn(fs, "statSync")
    .mockImplementation((entry: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (path.resolve(String(entry)) === blocked) {
        const error: NodeJS.ErrnoException = new Error(
          "EACCES: permission denied",
        );
        error.code = "EACCES";
        throw error;
      }
      return statSync(entry, options);
    });
  try {
    return body();
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  (
    globalThis as { jobRendezvousProvisioning?: unknown }
  ).jobRendezvousProvisioning = undefined;
});

describe("the memoized rendezvous provisioning", () => {
  test("resolves a set directory to an absolute path and memoizes it", () => {
    const dir = tempDir("rendezvous");
    const first = useJobRendezvousProvisioning({ JOB_RENDEZVOUS_DIR: dir }).dir;
    expect(first).toBe(path.resolve(dir));
    // The second call ignores a changed env: the value is memoized on globalThis.
    expect(
      useJobRendezvousProvisioning({ JOB_RENDEZVOUS_DIR: "/elsewhere" }).dir,
    ).toBe(first);
  });

  test("defaults to JOB_DATA_ROOT when JOB_RENDEZVOUS_DIR is unset", () => {
    const dataRoot = tempDir("data");
    expect(useJobRendezvousProvisioning({ JOB_DATA_ROOT: dataRoot }).dir).toBe(
      path.resolve(dataRoot),
    );
  });

  test("an explicit JOB_RENDEZVOUS_DIR overrides the data-root fallback", () => {
    const rendezvous = tempDir("rendezvous");
    const dataRoot = tempDir("data");
    expect(
      useJobRendezvousProvisioning({
        JOB_RENDEZVOUS_DIR: rendezvous,
        JOB_DATA_ROOT: dataRoot,
      }).dir,
    ).toBe(path.resolve(rendezvous));
  });

  test("is undefined when both JOB_RENDEZVOUS_DIR and JOB_DATA_ROOT are unset", () => {
    expect(useJobRendezvousProvisioning({}).dir).toBeUndefined();
  });
});

/** The name and the locator together, as the rendezvous route composes them: the
 * shared folder's name where the console can name it, and the value the invitation
 * holds either way. */
function locatorFor(env: NodeJS.ProcessEnv): {
  folderName: string | undefined;
  locator: string | undefined;
} {
  const { folderName, locator } = resolveJobRendezvousProvisioning(env);
  return { folderName, locator };
}

describe("the shared folder's name the invitation is minted from", () => {
  test("a name the segment rule admits can never be what fails a mint", () => {
    // The folder-name bound rides the shared segment rule's 255-character cap;
    // the endpoint schema's path cap is what a mint enforces. The inequality is
    // the critical fact: were it to flip, an admitted name could fail the
    // mint it feeds.
    expect(MAX_INPUT_NAME_LENGTH).toBeLessThan(MAX_ENDPOINT_PATH_LENGTH);
  });

  test("a launcher-mounted console names the folder the launcher passed", () => {
    // The launcher binds whatever folder the operator picked at its own fixed
    // mount point, so the mount point names the launcher's layout and the folder's
    // own name arrives beside it.
    expect(
      locatorFor({
        JOB_RENDEZVOUS_DIR: "/rendezvous",
        JOB_DATA_ROOT: "/data",
        JOB_RENDEZVOUS_NAME: "agency-a-agency-b",
      }),
    ).toEqual({
      folderName: "agency-a-agency-b",
      locator: "agency-a-agency-b",
    });
  });

  test("a launcher-mounted single-folder console names it too", () => {
    // No separate rendezvous mount: the exchange rendezvouses out of the data
    // mount, whose last segment is the launcher's name for it and not the
    // operator's.
    expect(
      locatorFor({
        JOB_DATA_ROOT: "/data",
        JOB_RENDEZVOUS_NAME: "county-exchange",
      }),
    ).toEqual({ folderName: "county-exchange", locator: "county-exchange" });
  });

  test("an operator-authored mount is named by its own last segment", () => {
    expect(
      locatorFor({ JOB_RENDEZVOUS_DIR: "/srv/exchanges/psilink" }),
    ).toEqual({ folderName: "psilink", locator: "psilink" });
  });

  test("an operator-authored mount ignores a trailing separator", () => {
    expect(
      locatorFor({ JOB_RENDEZVOUS_DIR: "/srv/exchanges/psilink/" }),
    ).toEqual({ folderName: "psilink", locator: "psilink" });
  });

  test("an operator-authored mount reduces a Windows-authored path", () => {
    expect(resolveJobRendezvousFolderName({}, "C:\\drops\\psilink")).toBe(
      "psilink",
    );
  });

  test.each([
    ["empty", ""],
    ["blank", "   "],
    ["a bare dot", "."],
    ["a parent segment", ".."],
    ["a POSIX path", "/srv/exchanges/psilink"],
    ["a Windows path", "drops\\psilink"],
    ["a control character", "psi\u0007link"],
    ["longer than a filesystem name", "x".repeat(256)],
  ])(
    "a %s name leaves the console unable to name the folder",
    (_label, name) => {
      // By design, this does not fall back to the mount point: a caller that set
      // the variable has already said the mount point does not name the folder.
      expect(
        locatorFor({
          JOB_RENDEZVOUS_DIR: "/rendezvous",
          JOB_RENDEZVOUS_NAME: name,
        }),
      ).toEqual({ folderName: undefined, locator: "rendezvous" });
    },
  );

  test("a name at the length limit is still a name", () => {
    const name = "x".repeat(255);
    expect(
      locatorFor({
        JOB_RENDEZVOUS_DIR: "/rendezvous",
        JOB_RENDEZVOUS_NAME: name,
      }),
    ).toEqual({ folderName: name, locator: name });
  });

  test("a name is trimmed rather than rejected for surrounding space", () => {
    expect(
      locatorFor({
        JOB_RENDEZVOUS_DIR: "/rendezvous",
        JOB_RENDEZVOUS_NAME: "  study a  ",
      }),
    ).toEqual({ folderName: "study a", locator: "study a" });
  });

  test("a mount with no last segment leaves neither a name nor a locator", () => {
    expect(locatorFor({ JOB_RENDEZVOUS_DIR: "/" })).toEqual({
      folderName: undefined,
      locator: undefined,
    });
  });

  test("no rendezvous mount leaves neither a name nor a locator", () => {
    expect(locatorFor({})).toEqual({
      folderName: undefined,
      locator: undefined,
    });
  });

  test("the resolved name is memoized alongside the directory", () => {
    const dir = tempDir("rendezvous");
    expect(
      useJobRendezvousProvisioning({
        JOB_RENDEZVOUS_DIR: dir,
        JOB_RENDEZVOUS_NAME: "study-a",
      }).folderName,
    ).toBe("study-a");
    const memoized = useJobRendezvousProvisioning({
      JOB_RENDEZVOUS_NAME: "something-else",
    });
    expect(memoized.folderName).toBe("study-a");
    expect(memoized.dir).toBe(path.resolve(dir));
  });
});

describe("the split rendezvous a second mount provisions", () => {
  test("the outbound leg has no data-root fallback, so the variable is the whole signal", () => {
    // Set the variable and the console is split; leave it unset and it is not,
    // whatever else is mounted. That is the whole signal.
    expect(
      resolveJobRendezvousOutboundDir({ JOB_DATA_ROOT: "/data" }),
    ).toBeUndefined();
    expect(resolveJobRendezvousOutboundDir({})).toBeUndefined();
    expect(
      resolveJobRendezvousOutboundDir({
        JOB_RENDEZVOUS_OUTBOUND_DIR: "  /mnt/out  ",
      }),
    ).toBe(path.resolve("/mnt/out"));
    expect(
      resolveJobRendezvousOutboundDir({ JOB_RENDEZVOUS_OUTBOUND_DIR: "   " }),
    ).toBeUndefined();
  });

  test("a coherent pair has both legs, both names, and both locators", () => {
    const provisioning = resolveJobRendezvousProvisioning({
      JOB_RENDEZVOUS_DIR: "/mnt/from-partner",
      JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/to-partner",
    });
    expect(provisioning).toEqual({
      dir: path.resolve("/mnt/from-partner"),
      outboundDir: path.resolve("/mnt/to-partner"),
      folderName: "from-partner",
      outboundFolderName: "to-partner",
      locator: "from-partner",
      outboundLocator: "to-partner",
    });
  });

  test("a name variable overrides each leg's mount point independently", () => {
    const provisioning = resolveJobRendezvousProvisioning({
      JOB_RENDEZVOUS_DIR: "/sync-in",
      JOB_RENDEZVOUS_OUTBOUND_DIR: "/sync-out",
      JOB_RENDEZVOUS_NAME: "study-a-in",
      JOB_RENDEZVOUS_OUTBOUND_NAME: "study-a-out",
    });
    expect(provisioning.folderName).toBe("study-a-in");
    expect(provisioning.outboundFolderName).toBe("study-a-out");
    expect(provisioning.problem).toBeUndefined();
  });

  test("no outbound mount is no split, and raises no problem", () => {
    expect(
      resolveJobRendezvousProvisioning({ JOB_RENDEZVOUS_DIR: "/rendezvous" })
        .problem,
    ).toBeUndefined();
  });

  test("two legs that are one directory are refused, naming the variable to move", () => {
    const problem = resolveJobRendezvousProvisioning({
      JOB_RENDEZVOUS_DIR: "/mnt/share",
      JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/share",
    }).problem;
    expect(problem).toContain("JOB_RENDEZVOUS_OUTBOUND_DIR");
    expect(problem).toContain("read its own writes");
  });

  test("an outbound leg NESTED in the inbound one is refused too", () => {
    // Core's own distinctness refine is textual same-directory only, so nesting --
    // which would have this party read its own writes as the partner's just the
    // same -- is caught here, where the console's mounts are known.
    expect(
      resolveJobRendezvousProvisioning({
        JOB_RENDEZVOUS_DIR: "/mnt/share",
        JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/share/out",
      }).problem,
    ).toContain("one is inside the other");
    expect(
      resolveJobRendezvousProvisioning({
        JOB_RENDEZVOUS_DIR: "/mnt/share/in",
        JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/share",
      }).problem,
    ).toContain("one is inside the other");
  });

  test("an outbound leg whose basename starts with .. is refused", () => {
    // The containment test is segment-aware, so a folder the operator named
    // "..outgoing" is treated as the child of the inbound leg it is, not as a
    // sibling the prefix makes it look like.
    expect(
      resolveJobRendezvousProvisioning({
        JOB_RENDEZVOUS_DIR: "/mnt/share",
        JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/share/..outgoing",
      }).problem,
    ).toContain("one is inside the other");
  });

  test("an outbound leg symlinked ONTO the inbound one meets the same refusal", () => {
    // The refusal exists because the inbound leg is partner-written, and a symlink
    // reorients the partner's folder onto the operator's just as an authored path
    // does. Held to the LEXICAL pair's own message, so the two cases cannot drift
    // into different outcomes.
    const mounts = tempDir("mounts");
    const inbound = subDir(mounts, "from-partner");
    const outbound = path.join(mounts, "to-partner");
    fs.symlinkSync(inbound, outbound, "dir");
    const lexical = splitProblem({
      JOB_RENDEZVOUS_DIR: "/mnt/share",
      JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/share",
    });
    expect(lexical).toContain("read its own writes");
    expect(
      splitProblem({
        JOB_RENDEZVOUS_DIR: inbound,
        JOB_RENDEZVOUS_OUTBOUND_DIR: outbound,
      }),
    ).toBe(lexical);
  });

  test("an outbound leg symlinked INSIDE the inbound one meets it too", () => {
    const mounts = tempDir("mounts");
    const inbound = subDir(mounts, "from-partner");
    const nested = subDir(inbound, "outgoing");
    const outbound = path.join(mounts, "to-partner");
    fs.symlinkSync(nested, outbound, "dir");
    expect(
      splitProblem({
        JOB_RENDEZVOUS_DIR: inbound,
        JOB_RENDEZVOUS_OUTBOUND_DIR: outbound,
      }),
    ).toContain("one is inside the other");
  });

  test("a leg not created yet is still read through its symlinked parent", () => {
    // A component that does not exist cannot be the symlink joining the two legs,
    // but its parent can, so resolution anchors on the nearest existing ancestor
    // rather than giving up on a mount the operator has not created yet.
    const mounts = tempDir("mounts");
    const inbound = subDir(mounts, "from-partner");
    const linkedParent = path.join(mounts, "sync");
    fs.symlinkSync(inbound, linkedParent, "dir");
    expect(
      splitProblem({
        JOB_RENDEZVOUS_DIR: inbound,
        JOB_RENDEZVOUS_OUTBOUND_DIR: path.join(linkedParent, "to-partner"),
      }),
    ).toContain("read its own writes");
  });

  test("two distinct legs reached through a symlinked parent still run", () => {
    const mounts = tempDir("mounts");
    const real = subDir(mounts, "volume");
    subDir(real, "from-partner");
    subDir(real, "to-partner");
    const link = path.join(mounts, "sync");
    fs.symlinkSync(real, link, "dir");
    const provisioning = resolveJobRendezvousProvisioning({
      JOB_RENDEZVOUS_DIR: path.join(link, "from-partner"),
      JOB_RENDEZVOUS_OUTBOUND_DIR: path.join(link, "to-partner"),
    });
    expect(provisioning.problem).toBeUndefined();
    expect(provisioning.unresolvedLegWarning).toBeUndefined();
  });

  test("a leg whose real path cannot be read warns instead of refusing", () => {
    // The symlinked pair of the case above, with the outbound mount unreadable: the
    // resolution that would catch it cannot run, and a filesystem that cannot answer
    // must not become a refusal of its own. What the operator gets is the warning.
    const mounts = tempDir("mounts");
    const inbound = subDir(mounts, "from-partner");
    const outbound = path.join(mounts, "to-partner");
    fs.symlinkSync(inbound, outbound, "dir");
    const provisioning = withUnreadableRealpath(outbound, () =>
      resolveJobRendezvousProvisioning({
        JOB_RENDEZVOUS_DIR: inbound,
        JOB_RENDEZVOUS_OUTBOUND_DIR: outbound,
      }),
    );
    expect(provisioning.problem).toBeUndefined();
    expect(provisioning.unresolvedLegWarning).toContain(
      "JOB_RENDEZVOUS_OUTBOUND_DIR",
    );
    expect(provisioning.unresolvedLegWarning).not.toContain(
      "JOB_RENDEZVOUS_DIR",
    );
    expect(provisioning.unresolvedLegWarning).toContain(
      "outbound rendezvous directory was compared only as configured",
    );
    expect(provisioning.unresolvedLegWarning).toContain(
      "the inbound leg's real path still applied",
    );
    expect(provisioning.unresolvedLegWarning).toContain(
      "only a symlink on the outbound side would go uncaught",
    );
  });

  test("an unreadable leg is still held to the configured-path comparison", () => {
    // The lexical verdict does not depend on the resolution having run, so a pair
    // that is nested as configured is refused whether or not either leg resolves --
    // and the warning names both legs when neither did.
    const provisioning = withUnreadableRealpath(path.resolve("/mnt"), () =>
      resolveJobRendezvousProvisioning({
        JOB_RENDEZVOUS_DIR: "/mnt/share",
        JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/share/out",
      }),
    );
    expect(provisioning.problem).toContain("one is inside the other");
    expect(provisioning.unresolvedLegWarning).toContain(
      "JOB_RENDEZVOUS_DIR and JOB_RENDEZVOUS_OUTBOUND_DIR",
    );
    expect(provisioning.unresolvedLegWarning).toContain(
      "inbound and outbound rendezvous directories were compared as configured",
    );
  });

  test("two mounts ending in the same segment are refused at boot, not at mint", () => {
    // Core refuses a filedrop endpoint whose halves resolve alike, and the console
    // mints single-segment locators; without this the operator would meet core's
    // refusal at the mint with nothing to act on.
    const problem = resolveJobRendezvousProvisioning({
      JOB_RENDEZVOUS_DIR: "/mnt/in/psilink",
      JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/out/psilink",
    }).problem;
    expect(problem).toContain("JOB_RENDEZVOUS_OUTBOUND_NAME");
    expect(problem).toContain("same name");
  });

  test("the name override clears a derived-name collision", () => {
    expect(
      resolveJobRendezvousProvisioning({
        JOB_RENDEZVOUS_DIR: "/mnt/in/psilink",
        JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/out/psilink",
        JOB_RENDEZVOUS_OUTBOUND_NAME: "psilink-out",
      }).problem,
    ).toBeUndefined();
  });

  test("an unusable name variable withholds the name, not the locator", () => {
    // The name variable governs only what the sheet may PRINT as the folder's
    // name; the locator the invitation holds still falls back to the mount's own
    // last segment, exactly as it does on a single-mount console.
    const provisioning = resolveJobRendezvousProvisioning({
      JOB_RENDEZVOUS_DIR: "/rendezvous",
      JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/out",
      JOB_RENDEZVOUS_OUTBOUND_NAME: "not/a/segment",
    });
    expect(provisioning.outboundFolderName).toBeUndefined();
    expect(provisioning.outboundLocator).toBe("out");
    expect(provisioning.problem).toBeUndefined();
  });

  test("a leg with no locator at all is refused, naming both name variables", () => {
    // Driven through the predicate rather than the environment: the only mount that
    // reduces to no last segment is a filesystem root, which contains any other
    // mount and so trips the containment refusal first. The guard is what makes a
    // split with an unnameable leg unrepresentable rather than minted half-formed.
    const { problem } = rendezvousSplitFaults(
      { dir: "/mnt/in", outboundDir: "/mnt/out", locator: "in" },
      true,
    );
    expect(problem).toContain("cannot name both rendezvous folders");
    expect(problem).toContain("JOB_RENDEZVOUS_OUTBOUND_NAME");
  });

  test("an outbound mount with an inbound leg on the fallback is refused", () => {
    // The production shape of a half-provisioned split: JOB_DATA_ROOT is the job
    // API's own feature gate, so a console that runs at all has one, and the
    // inbound leg always resolves through its fallback. Were the fallback allowed
    // to stand in for the inbound leg, an operator who set only the outbound
    // variable would get a split whose partner-synced inbound folder is the data
    // root -- every job workdir's config, key, input, and results.
    const problem = resolveJobRendezvousProvisioning({
      JOB_DATA_ROOT: "/data/jobs",
      JOB_RENDEZVOUS_OUTBOUND_DIR: "/data/out",
    }).problem;
    expect(problem).toContain("JOB_RENDEZVOUS_DIR");
    expect(problem).toContain("JOB_RENDEZVOUS_OUTBOUND_DIR");
  });

  test("a mistyped inbound variable is the same refusal", () => {
    expect(
      resolveJobRendezvousProvisioning({
        JOB_DATA_ROOT: "/data/jobs",
        JOB_RENDEVOUS_DIR: "/mnt/in",
        JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/out",
      }).problem,
    ).toContain("JOB_RENDEZVOUS_DIR");
  });

  test("an outbound mount with no data root behind it is refused too", () => {
    expect(
      resolveJobRendezvousProvisioning({
        JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/out",
      }).problem,
    ).toContain("JOB_RENDEZVOUS_DIR");
  });

  test("both legs named explicitly provisions the split beside a data root", () => {
    expect(
      resolveJobRendezvousProvisioning({
        JOB_DATA_ROOT: "/data/jobs",
        JOB_RENDEZVOUS_DIR: "/mnt/in",
        JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/out",
      }),
    ).toEqual({
      dir: path.resolve("/mnt/in"),
      outboundDir: path.resolve("/mnt/out"),
      folderName: "in",
      outboundFolderName: "out",
      locator: "in",
      outboundLocator: "out",
    });
  });

  test("the inbound leg's data-root fallback still runs an unsplit console", () => {
    const provisioning = resolveJobRendezvousProvisioning({
      JOB_DATA_ROOT: "/data/jobs",
    });
    expect(provisioning.dir).toBe(path.resolve("/data/jobs"));
    expect(provisioning.problem).toBeUndefined();
  });

  test("both legs are enumerated for the containment surfaces", () => {
    expect(
      jobRendezvousDirs(
        resolveJobRendezvousProvisioning({
          JOB_RENDEZVOUS_DIR: "/mnt/in",
          JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/out",
        }),
      ),
    ).toEqual([path.resolve("/mnt/in"), path.resolve("/mnt/out")]);
    expect(
      jobRendezvousDirs(
        resolveJobRendezvousProvisioning({ JOB_RENDEZVOUS_DIR: "/mnt/share" }),
      ),
    ).toEqual([path.resolve("/mnt/share")]);
    expect(jobRendezvousDirs(resolveJobRendezvousProvisioning({}))).toEqual([]);
  });

  test("an incoherent pair still reports both mounts, so neither escapes containment", () => {
    // The mounts stay partner-synced folders whether or not an exchange can run
    // over them, so the credential-containment surfaces must still see both.
    const provisioning = resolveJobRendezvousProvisioning({
      JOB_RENDEZVOUS_DIR: "/mnt/share",
      JOB_RENDEZVOUS_OUTBOUND_DIR: "/mnt/share/out",
    });
    expect(provisioning.problem).toBeDefined();
    expect(jobRendezvousDirs(provisioning)).toHaveLength(2);
  });

  test("a half-provisioned split reports both mounts too", () => {
    const provisioning = resolveJobRendezvousProvisioning({
      JOB_DATA_ROOT: "/data/jobs",
      JOB_RENDEZVOUS_OUTBOUND_DIR: "/data/out",
    });
    expect(provisioning.problem).toBeDefined();
    expect(jobRendezvousDirs(provisioning)).toEqual([
      path.resolve("/data/jobs"),
      path.resolve("/data/out"),
    ]);
  });
});

describe("whether a rendezvous leg holds the data root", () => {
  test("the data-root fallback does: the single-folder console", () => {
    // The layout the identity-location advisory exists for -- one mount, so the
    // folder the partner syncs is the folder the signing key is written into.
    // Lexically established, not defaulted, so it holds no uncertainty flag.
    const provisioning = resolveJobRendezvousProvisioning({
      JOB_DATA_ROOT: "/data/jobs",
    });
    expect(provisioning.sharesDataRoot).toBe(true);
    expect(provisioning.sharesDataRootUncertain).toBeUndefined();
  });

  test("a rendezvous with a mount of its own does not", () => {
    expect(
      resolveJobRendezvousProvisioning({
        JOB_DATA_ROOT: "/data/jobs",
        JOB_RENDEZVOUS_DIR: "/mnt/share",
      }).sharesDataRoot,
    ).toBeUndefined();
  });

  test("a leg mounted ABOVE the data root does, whichever variable named it", () => {
    // The fact follows the containment, not the fallback: an operator who pointed
    // JOB_RENDEZVOUS_DIR at a folder holding the working directory syncs the key
    // exactly as the fallback does. Lexically established, so uncertain stays
    // absent.
    const provisioning = resolveJobRendezvousProvisioning({
      JOB_DATA_ROOT: "/mnt/share/work",
      JOB_RENDEZVOUS_DIR: "/mnt/share",
    });
    expect(provisioning.sharesDataRoot).toBe(true);
    expect(provisioning.sharesDataRootUncertain).toBeUndefined();
  });

  test("a leg mounted INSIDE the data root does not", () => {
    // Directional: the partner's sync reaches that subfolder, not the key sitting
    // in the folder above it. The overlap warning the job's own preflight raises
    // is the surface for what a write into it does reach.
    expect(
      resolveJobRendezvousProvisioning({
        JOB_DATA_ROOT: "/data/jobs",
        JOB_RENDEZVOUS_DIR: "/data/jobs/share",
      }).sharesDataRoot,
    ).toBeUndefined();
  });

  test("a leg symlinked onto the data root does", () => {
    const mounts = tempDir("mounts");
    const work = subDir(mounts, "work");
    const link = path.join(mounts, "share");
    fs.symlinkSync(work, link, "dir");
    // The real path resolves, so the match is lexical (over the resolved forms)
    // rather than a default; uncertain stays absent.
    const provisioning = resolveJobRendezvousProvisioning({
      JOB_DATA_ROOT: work,
      JOB_RENDEZVOUS_DIR: link,
    });
    expect(provisioning.sharesDataRoot).toBe(true);
    expect(provisioning.sharesDataRootUncertain).toBeUndefined();
  });

  test("EITHER leg of a split answers for the pair", () => {
    // Each leg is partner-synced independently, so an outbound leg pointed at the
    // working directory puts the key where the partner reads just as an inbound
    // one would. Lexically established, so uncertain stays absent.
    const provisioning = resolveJobRendezvousProvisioning({
      JOB_DATA_ROOT: "/data/jobs",
      JOB_RENDEZVOUS_DIR: "/mnt/from-partner",
      JOB_RENDEZVOUS_OUTBOUND_DIR: "/data/jobs",
    });
    expect(provisioning.sharesDataRoot).toBe(true);
    expect(provisioning.sharesDataRootUncertain).toBeUndefined();
  });

  test("a leg whose real path cannot be read counts as holding it, uncertainly", () => {
    // The symlink that would join the two is exactly what could not be resolved,
    // and this decides a warn-and-guide advisory, so what cannot be ruled out is
    // reported rather than dropped -- and reported as uncertain, since nothing
    // was actually matched.
    const mounts = tempDir("mounts");
    const work = subDir(mounts, "work");
    const share = subDir(mounts, "share");
    const provisioning = withUnreadableRealpath(share, () =>
      resolveJobRendezvousProvisioning({
        JOB_DATA_ROOT: work,
        JOB_RENDEZVOUS_DIR: share,
      }),
    );
    expect(provisioning.sharesDataRoot).toBe(true);
    expect(provisioning.sharesDataRootUncertain).toBe(true);
  });

  test("a leg bind-mounted onto the data root does, though no path relates them", () => {
    // One host directory bound in at two container paths: two paths, two real
    // paths, one directory -- and the partner's sync reaches the signing key
    // through either. Nothing but the (st_dev, st_ino) identity relates the two,
    // so a resolution deciding on paths alone would withhold the advisory on
    // exactly the layout it exists for.
    const mounts = tempDir("mounts");
    const work = subDir(mounts, "work");
    const share = subDir(mounts, "share");
    const env = { JOB_DATA_ROOT: work, JOB_RENDEZVOUS_DIR: share };
    // The identity actually matched (both stats were readable), so this is
    // established rather than defaulted: uncertain stays absent.
    const provisioning = withAliasedInode(share, work, () =>
      resolveJobRendezvousProvisioning(env),
    );
    expect(provisioning.sharesDataRoot).toBe(true);
    expect(provisioning.sharesDataRootUncertain).toBeUndefined();
    // Without the aliasing the same two mounts are separate folders, so it is
    // the identity that decides the case and not the directories it runs on.
    expect(
      resolveJobRendezvousProvisioning(env).sharesDataRoot,
    ).toBeUndefined();
  });

  test("a leg aliasing a folder that HOLDS the data root does too", () => {
    // The identity is compared up the data root's whole ancestor chain, because a
    // leg aliasing the folder the working directory sits in reaches the key just
    // as one aliasing the working directory does.
    const mounts = tempDir("mounts");
    const enclosing = subDir(mounts, "enclosing");
    const work = subDir(enclosing, "work");
    const share = subDir(mounts, "share");
    // Matched by identity against a readable ancestor, so established rather
    // than defaulted.
    const provisioning = withAliasedInode(share, enclosing, () =>
      resolveJobRendezvousProvisioning({
        JOB_DATA_ROOT: work,
        JOB_RENDEZVOUS_DIR: share,
      }),
    );
    expect(provisioning.sharesDataRoot).toBe(true);
    expect(provisioning.sharesDataRootUncertain).toBeUndefined();
  });

  test("a leg aliasing a folder INSIDE the data root does not", () => {
    // Directional through the aliased comparison as much as the lexical one: the
    // partner's sync reaches the subfolder the leg is bound to, not the key in
    // the folder above it.
    const mounts = tempDir("mounts");
    const work = subDir(mounts, "work");
    const inside = subDir(work, "inside");
    const share = subDir(mounts, "share");
    expect(
      withAliasedInode(share, inside, () =>
        resolveJobRendezvousProvisioning({
          JOB_DATA_ROOT: work,
          JOB_RENDEZVOUS_DIR: share,
        }),
      ).sharesDataRoot,
    ).toBeUndefined();
  });

  test("a leg the console cannot stat counts as holding it", () => {
    // The identity that would join the two is exactly what could not be read, and
    // the verdict decides a warn-and-guide advisory, so what cannot be ruled out
    // is reported rather than dropped. The paths here relate the two not at all,
    // so it is the unreadable identity deciding the verdict and nothing else.
    const mounts = tempDir("mounts");
    const work = subDir(mounts, "work");
    const share = subDir(mounts, "share");
    const env = { JOB_DATA_ROOT: work, JOB_RENDEZVOUS_DIR: share };
    // Nothing was actually matched -- the identity check could not read the
    // leg -- so the verdict is uncertain.
    const provisioning = withUnreadableStat(share, () =>
      resolveJobRendezvousProvisioning(env),
    );
    expect(provisioning.sharesDataRoot).toBe(true);
    expect(provisioning.sharesDataRootUncertain).toBe(true);
    expect(
      resolveJobRendezvousProvisioning(env).sharesDataRoot,
    ).toBeUndefined();
  });

  test("a data root ancestor the console cannot stat does too", () => {
    // The same direction from the other side of the comparison: a leg that stats
    // fine cannot be ruled out against a chain the walk could not finish reading,
    // and the ancestor that stopped it is one a leg could be bound onto.
    const mounts = tempDir("mounts");
    const enclosing = subDir(mounts, "enclosing");
    const work = subDir(enclosing, "work");
    const share = subDir(mounts, "share");
    const env = { JOB_DATA_ROOT: work, JOB_RENDEZVOUS_DIR: share };
    // Same direction: an ancestor the walk could not read leaves nothing
    // matched, so the verdict is uncertain rather than established.
    const provisioning = withUnreadableStat(enclosing, () =>
      resolveJobRendezvousProvisioning(env),
    );
    expect(provisioning.sharesDataRoot).toBe(true);
    expect(provisioning.sharesDataRootUncertain).toBe(true);
    expect(
      resolveJobRendezvousProvisioning(env).sharesDataRoot,
    ).toBeUndefined();
  });

  test("no data root leaves nothing to hold", () => {
    expect(
      resolveJobRendezvousProvisioning({ JOB_RENDEZVOUS_DIR: "/mnt/share" })
        .sharesDataRoot,
    ).toBeUndefined();
  });
});

describe("each leg's preflight names the mount it is about", () => {
  test("a split console's notices distinguish the two folders", () => {
    const dataRoot = tempDir("data");
    const inbound = tempDir("inbound");
    fs.writeFileSync(path.join(inbound, "console-hello.json"), "");
    const workdir = path.join(dataRoot, "current-job");
    const inboundWarnings = rendezvousStartupWarnings(
      inbound,
      "inbound",
      undefined,
      dataRoot,
      workdir,
      SWEEP_OFF,
    );
    expect(
      inboundWarnings.some((warning) =>
        warning.startsWith("the inbound rendezvous directory"),
      ),
    ).toBe(true);
    const missingOutbound = path.join(tempDir("outbound"), "not-created");
    const outboundWarnings = rendezvousStartupWarnings(
      missingOutbound,
      "outbound",
      undefined,
      dataRoot,
      workdir,
      SWEEP_OFF,
    );
    expect(
      outboundWarnings.some((warning) =>
        warning.startsWith("the outbound rendezvous directory"),
      ),
    ).toBe(true);
  });

  test("a single-mount console keeps the unqualified wording", () => {
    const dataRoot = tempDir("data");
    const missing = path.join(tempDir("rendezvous"), "not-created");
    expect(
      rendezvousStartupWarnings(
        missing,
        "shared",
        undefined,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      )[0],
    ).toContain("the rendezvous directory");
  });
});

/** The overlap warnings alone, isolating the containment branch from the stat-based
 * preflight warnings (which the fixtures avoid by using real writable directories). */
function overlapWarnings(warnings: Array<string>): Array<string> {
  return warnings.filter((warning) => warning.includes("overlaps"));
}

describe("rendezvousStartupWarnings overlap branch", () => {
  test("warns when the rendezvous is nested inside the data root", () => {
    const dataRoot = tempDir("data");
    const rendezvous = subDir(dataRoot, "rendezvous");
    const warnings = overlapWarnings(
      rendezvousStartupWarnings(
        rendezvous,
        "shared",
        undefined,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the job data root");
  });

  test("warns when the data root is nested inside the rendezvous", () => {
    const rendezvous = tempDir("rendezvous");
    const dataRoot = subDir(rendezvous, "data");
    const warnings = overlapWarnings(
      rendezvousStartupWarnings(
        rendezvous,
        "shared",
        undefined,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the job data root");
  });

  test("warns when the rendezvous equals the work-input directory", () => {
    const shared = tempDir("shared");
    const dataRoot = tempDir("data");
    const warnings = overlapWarnings(
      rendezvousStartupWarnings(
        shared,
        "shared",
        shared,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the work-input directory");
  });

  test("warns when the work-input directory contains the rendezvous", () => {
    const jobInput = tempDir("input");
    const rendezvous = subDir(jobInput, "rendezvous");
    const dataRoot = tempDir("data");
    const warnings = overlapWarnings(
      rendezvousStartupWarnings(
        rendezvous,
        "shared",
        jobInput,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the work-input directory");
  });

  test("warns twice when the rendezvous contains both the data root and the work-input directory", () => {
    const rendezvous = tempDir("rendezvous");
    const dataRoot = subDir(rendezvous, "data");
    const jobInput = subDir(rendezvous, "input");
    const warnings = overlapWarnings(
      rendezvousStartupWarnings(
        rendezvous,
        "shared",
        jobInput,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      ),
    );
    expect(warnings).toHaveLength(2);
    expect(
      warnings.some((warning) => warning.includes("the job data root")),
    ).toBe(true);
    expect(
      warnings.some((warning) => warning.includes("the work-input directory")),
    ).toBe(true);
  });

  test("does not warn for non-overlapping sibling directories", () => {
    const rendezvous = tempDir("rendezvous");
    const jobInput = tempDir("input");
    const dataRoot = tempDir("data");
    expect(
      rendezvousStartupWarnings(
        rendezvous,
        "shared",
        jobInput,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      ),
    ).toEqual([]);
  });

  test("warns when the rendezvous mount is symlinked ONTO the data root", () => {
    // What a partner's sync writes reach is the directory at the far end of the
    // link, so a mount that resolves onto the data root is the case the notice
    // exists for however the operator spelled it.
    const mounts = tempDir("mounts");
    const dataRoot = subDir(mounts, "data");
    const rendezvous = path.join(mounts, "sync");
    fs.symlinkSync(dataRoot, rendezvous, "dir");
    const warnings = overlapWarnings(
      rendezvousStartupWarnings(
        rendezvous,
        "shared",
        undefined,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the job data root");
  });

  test("warns when the work-input directory is reached through a symlinked parent", () => {
    // The other side of the same comparison: it is the configured work-input path
    // that holds the link, and the mount that is the plain path.
    const mounts = tempDir("mounts");
    const volume = subDir(mounts, "volume");
    const rendezvous = subDir(volume, "sync");
    const link = path.join(mounts, "reached-by-link");
    fs.symlinkSync(volume, link, "dir");
    const warnings = overlapWarnings(
      rendezvousStartupWarnings(
        rendezvous,
        "shared",
        path.join(link, "sync"),
        tempDir("data"),
        path.join(tempDir("workdirs"), "current-job"),
        SWEEP_OFF,
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the work-input directory");
  });

  test("does not warn for a symlinked mount that lands beside the data root", () => {
    // Resolution decides an overlap, never invents one: a link is not itself the
    // fault, and a console whose mounts are links would otherwise warn always.
    const mounts = tempDir("mounts");
    const dataRoot = subDir(mounts, "data");
    const elsewhere = subDir(mounts, "partner-folder");
    const rendezvous = path.join(mounts, "sync");
    fs.symlinkSync(elsewhere, rendezvous, "dir");
    expect(
      rendezvousStartupWarnings(
        rendezvous,
        "shared",
        undefined,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      ),
    ).toEqual([]);
  });

  test("a mount whose real path cannot be read keeps the lexical verdict", () => {
    // The resolution that would catch a symlinked overlap cannot run, so the
    // configured comparison stands on its own and the operator is told the check
    // ran narrower than it means to -- never that the layout is at fault.
    const dataRoot = tempDir("data");
    const rendezvous = subDir(dataRoot, "sync");
    const warnings = withUnreadableRealpath(rendezvous, () =>
      rendezvousStartupWarnings(
        rendezvous,
        "shared",
        undefined,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      ),
    );
    expect(overlapWarnings(warnings)).toHaveLength(1);
    expect(
      warnings.filter((warning) =>
        warning.includes("could not be resolved to its real path"),
      ),
    ).toHaveLength(1);
  });

  test("an unreadable mount symlinked onto the data root reports the narrowed check", () => {
    // The overlap itself goes unseen, which is exactly what the notice says: the
    // console reports what it could not check rather than looking silent.
    const mounts = tempDir("mounts");
    const dataRoot = subDir(mounts, "data");
    const rendezvous = path.join(mounts, "sync");
    fs.symlinkSync(dataRoot, rendezvous, "dir");
    const warnings = withUnreadableRealpath(rendezvous, () =>
      rendezvousStartupWarnings(
        rendezvous,
        "shared",
        undefined,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      ),
    );
    expect(overlapWarnings(warnings)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not be resolved to its real path");
    expect(warnings[0]).toContain(
      "Give the console read access to every folder on the way to it",
    );
  });

  test("a data root whose real path cannot be read names that side", () => {
    // The other side of the same narrowing: the comparison ran without the data
    // root's real path, and which side the console could not read is what tells
    // the operator where to restore the access. A warning, as every side is.
    const dataRoot = tempDir("data");
    const warnings = withUnreadableRealpath(dataRoot, () =>
      rendezvousStartupWarnings(
        tempDir("rendezvous"),
        "shared",
        undefined,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the job data root");
    expect(warnings[0]).toContain("could not be resolved to its real path");
    expect(warnings[0]).toContain(
      "Give the console read access to every folder on the way to it",
    );
  });

  test("a work-input directory whose real path cannot be read names that side", () => {
    const jobInput = tempDir("input");
    const dataRoot = tempDir("data");
    const warnings = withUnreadableRealpath(jobInput, () =>
      rendezvousStartupWarnings(
        tempDir("rendezvous"),
        "shared",
        jobInput,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the work-input directory");
    expect(warnings[0]).toContain("could not be resolved to its real path");
  });

  test("an unreadable data root symlinked onto the mount reports the narrowed check", () => {
    // The overlap the resolution would have caught goes unseen from this side
    // exactly as it does from the mount's, and the notice is what says so rather
    // than the comparison looking like a clean one.
    const mounts = tempDir("mounts");
    const rendezvous = subDir(mounts, "sync");
    const dataRoot = path.join(mounts, "data");
    fs.symlinkSync(rendezvous, dataRoot, "dir");
    const warnings = withUnreadableRealpath(dataRoot, () =>
      rendezvousStartupWarnings(
        rendezvous,
        "shared",
        undefined,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      ),
    );
    expect(overlapWarnings(warnings)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the job data root");
    expect(warnings[0]).toContain("could not be resolved to its real path");
  });

  test("a mount that does not exist yet raises that notice and no other", () => {
    // A component that does not exist is resolved through the nearest existing
    // ancestor, so the absent mount is not also reported as one the console could
    // not resolve: the operator gets the one fact they can act on.
    const dataRoot = tempDir("data");
    const warnings = rendezvousStartupWarnings(
      path.join(tempDir("rendezvous"), "not-created"),
      "shared",
      tempDir("input"),
      dataRoot,
      path.join(dataRoot, "current-job"),
      SWEEP_OFF,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("does not exist yet");
  });
});

/** Whether a preflight warning is one of those about what the directory holds --
 * the not-empty lead, the listing that follows it, or the unlistable-mount notice --
 * as opposed to the overlap and permission warnings the same call can raise. */
function isContentWarning(warning: string): boolean {
  return (
    warning.includes("is not empty") ||
    warning.includes("holds") ||
    warning.includes("cannot be listed")
  );
}

/** The rendezvous preflight run over a directory holding `entries`, isolated from
 * the overlap branch by non-overlapping sibling fixtures, and reduced to the
 * warnings about what the directory holds. Raw, as the preflight composes them and
 * as the job event stream reports them. */
function contentWarnings(
  entries: Array<string>,
  sweepExchangeFiles: boolean = SWEEP_OFF,
): Array<string> {
  const rendezvous = tempDir("rendezvous");
  const dataRoot = tempDir("data");
  for (const entry of entries)
    fs.writeFileSync(path.join(rendezvous, entry), "");
  return rendezvousStartupWarnings(
    rendezvous,
    "shared",
    tempDir("input"),
    dataRoot,
    path.join(dataRoot, "current-job"),
    sweepExchangeFiles,
  ).filter(isContentWarning);
}

/** Whatever the preflight composed, as the operator reads it: folded through the
 * seat's real display boundary, which is the one and only altitude that escapes
 * these messages. Every assertion about what the operator sees is made on this side
 * of it. */
function renderedAtSeat(warnings: Array<string>): Array<string> {
  return warnings.reduce<Array<string>>(
    (accumulated, warning) => appendSanitizedRunWarning(accumulated, warning),
    [],
  );
}

/** The content warnings as the operator reads them. */
function renderedContentWarnings(
  entries: Array<string>,
  sweepExchangeFiles: boolean = SWEEP_OFF,
): Array<string> {
  return renderedAtSeat(contentWarnings(entries, sweepExchangeFiles));
}

/** The transcript a completed retain-mode run leaves in the mount. */
const retainedTranscript = [
  "console-hello.json",
  "partner-hello.json",
  "console-partner-hello-ack.json",
  "console-20260812T101500123Z-001-4096.json",
  "partner-console-20260812T101500123Z-001-4096-ack.json",
];

describe("rendezvousStartupWarnings emptiness branch", () => {
  test("an empty rendezvous directory is the silent case", () => {
    expect(contentWarnings([])).toEqual([]);
  });

  test("a completed retain-mode run is reported to the next exchange", () => {
    // The console rendezvouses every filedrop job out of the one mount, so the
    // transcript a retain-mode run is asked to keep is still there when the
    // operator starts the next exchange -- no crash anywhere in the story. The
    // console reports it rather than letting the exchange's own entry guard end
    // the next run mid-flow.
    const [lead, listing] = renderedContentWarnings(retainedTranscript);
    expect(lead).toContain("is not empty");
    for (const name of retainedTranscript) expect(listing).toContain(name);
  });

  test("the lead reaches the operator with its whole recovery", () => {
    // The sink caps what it renders, and the clause the cap would eat first is
    // the one that keeps the recovery from looking like "empty this folder".
    const [lead] = renderedContentWarnings(["console-hello.json"]);
    expect(lead).toContain("an exchange refuses to start");
    expect(lead).toContain('Turn on "Clear leftover exchange files"');
    expect(lead).toContain(
      "Your own input and results are not what it refuses over",
    );
    expect(lead).not.toContain(DISPLAY_TRUNCATION_MARKER);
  });

  test("the recovery for a launch without the sweep is pinned whole", () => {
    // The whole sentence, not a clause of it: the two forms share their opening,
    // so a check reading only a fragment would pass while the operator who has to
    // act on this one reads a sentence half-reworded by the other.
    expect(notEmptyLead("/data", "shared", SWEEP_OFF)).toBe(
      "the rendezvous directory /data is not empty; an exchange refuses to " +
        "start on an earlier run's files. Turn on \"Clear leftover exchange " +
        'files" and re-run. Your own input and results are not what it ' +
        "refuses over.",
    );
  });

  test("the recovery for a launch with the sweep is pinned whole", () => {
    // Pinned whole for the reason the form above is, and for one of its own: this
    // form says the sweep RUNS, never that it clears, because the CLI's sweep
    // refuses a retain-mode transcript and the console composes no escalation past
    // that guard. A leftover transcript is the case this warning fires on, so a
    // clause reworded into a promise would be read by the operator whose run is
    // about to refuse it, and a fragment check would not see the rewording.
    expect(notEmptyLead("/data", "shared", SWEEP_ON)).toBe(
      "the rendezvous directory /data is not empty; an exchange refuses to " +
        "start on an earlier run's files. " +
        '"Clear leftover exchange files" is on and runs first; your own ' +
        "input and results are not what it sweeps.",
    );
  });

  test("a sweeping launch reads its own recovery at the seat", () => {
    // Through the preflight rather than the composer, on the transcript the branch
    // exists for: the control this recovery names is the one the operator ticked
    // to get here, so instructing them to tick it says the console did not notice,
    // and the clause naming what the sweep spares is what the cap would eat first.
    const [lead] = renderedContentWarnings(retainedTranscript, SWEEP_ON);
    expect(lead).toContain("an exchange refuses to start");
    expect(lead).not.toContain("Turn on");
    expect(lead).toContain(
      '"Clear leftover exchange files" is on and runs first; your own ' +
        "input and results are not what it sweeps.",
    );
    expect(lead).not.toContain(DISPLAY_TRUNCATION_MARKER);
  });

  test("the recovery sends the operator to a control the console holds", () => {
    // The recovery is the console's own sweep, quoted by the opening of the
    // control's visible label because the whole label does not fit beside the
    // mount path. Either side of that pair drifting leaves the operator hunting
    // the run form for a control worded differently, so the pair is checked here
    // rather than kept in step by hand. Both recoveries name it, so both are
    // checked: a form that quoted a stale label would send that launch nowhere.
    for (const sweepExchangeFiles of [SWEEP_OFF, SWEEP_ON]) {
      const quoted = /"([^"]+)"/.exec(
        notEmptyLead("/data", "shared", sweepExchangeFiles),
      );
      expect(quoted, "the lead names no control at all").not.toBeNull();
      expect(SWEEP_CONTROL_LABEL.startsWith(quoted![1])).toBe(true);
    }
  });

  test("a console mount path rides in the lead", () => {
    for (const sweepExchangeFiles of [SWEEP_OFF, SWEEP_ON]) {
      const lead = notEmptyLead("/data", "shared", sweepExchangeFiles);
      expect(lead).toContain("/data");
      expect(sanitizeForDisplay(lead)).not.toContain(DISPLAY_TRUNCATION_MARKER);
    }
  });

  test("a mount path too long for the lead is left out of it", () => {
    // The path is the lead's only unbounded part, and the recovery is what a
    // truncation would cut, so the path is what gives way.
    const deepMount = `/mnt/${"d".repeat(300)}`;
    const lead = notEmptyLead(deepMount, "shared", SWEEP_OFF);
    expect(lead).not.toContain(deepMount);
    expect(lead).toContain("the rendezvous directory is not empty");
    expect(lead).toContain(
      "Your own input and results are not what it refuses over",
    );
    expect(sanitizeForDisplay(lead)).not.toContain(DISPLAY_TRUNCATION_MARKER);
  });

  test("a mount path only its escapes make too long is left out too", () => {
    // Two mounts of the same raw length, one of confusables: only the escaped one
    // costs the lead its budget, and only a fit measuring what the sink will RENDER
    // can tell them apart. A fit done on the composition's own length keeps both --
    // and shows the operator a lead the sink then cuts mid-recovery.
    const escapedMount = `/mnt/${WIDE_ESCAPING_CHAR.repeat(35)}`;
    const asciiMount = `/mnt/${"d".repeat(35)}`;
    expect(escapedMount.length).toBe(asciiMount.length);
    expect(notEmptyLead(asciiMount, "shared", SWEEP_OFF)).toContain(asciiMount);
    expect(notEmptyLead(escapedMount, "shared", SWEEP_OFF)).not.toContain(
      escapedMount,
    );
    expect(
      sanitizeForDisplay(notEmptyLead(escapedMount, "shared", SWEEP_OFF)),
    ).not.toContain(DISPLAY_TRUNCATION_MARKER);
  });

  test("files the exchange has no claim on are reported the same way", () => {
    // Sorting protocol files from foreign ones is the exchange's grammar, not the
    // console's: the listing names what is there and the operator judges it.
    const warnings = renderedContentWarnings(["patients.csv", "notes.txt"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("patients.csv");
    expect(warnings[1]).toContain("notes.txt");
  });

  test("a subdirectory makes the mount non-empty as a loose file does", () => {
    const rendezvous = tempDir("rendezvous");
    const dataRoot = tempDir("data");
    fs.mkdirSync(path.join(rendezvous, "prior-job"));
    const warnings = rendezvousStartupWarnings(
      rendezvous,
      "shared",
      tempDir("input"),
      dataRoot,
      path.join(dataRoot, "current-job"),
      SWEEP_OFF,
    ).filter(isContentWarning);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("prior-job");
  });

  test("the job's own just-created workdir does not make the mount non-empty", () => {
    // Single-folder layout: the rendezvous directory IS the data root, and
    // createJob has already made this job's workdir inside it by the time the
    // preflight runs; a pristine mount must stay the silent case.
    const shared = tempDir("shared");
    const workdir = subDir(shared, "0f6e2c1a-current");
    const warnings = rendezvousStartupWarnings(
      shared,
      "shared",
      undefined,
      shared,
      workdir,
      SWEEP_OFF,
    ).filter(isContentWarning);
    expect(warnings).toEqual([]);
  });

  test("leftovers beside the job's own workdir are reported without naming it", () => {
    const shared = tempDir("shared");
    const workdir = subDir(shared, "0f6e2c1a-current");
    fs.writeFileSync(path.join(shared, "console-hello.json"), "");
    const warnings = rendezvousStartupWarnings(
      shared,
      "shared",
      undefined,
      shared,
      workdir,
      SWEEP_OFF,
    ).filter(isContentWarning);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("console-hello.json");
    expect(warnings[1]).not.toContain("0f6e2c1a-current");
  });

  test("names are listed in a stable order whatever readdir returns", () => {
    const [, listing] = renderedContentWarnings(["c.json", "a.json", "b.json"]);
    expect(listing).toContain("a.json, b.json, c.json");
  });

  test("a long transcript is counted past the naming cap", () => {
    const overflow = 3;
    const entries = Array.from(
      { length: MAX_NAMED_RENDEZVOUS_ENTRIES + overflow },
      (_unused, index) => `m${String(index).padStart(3, "0")}.json`,
    );
    const [, listing] = renderedContentWarnings(entries);
    expect(listing).toContain(`and ${overflow} more`);
    expect(listing).toContain(entries[MAX_NAMED_RENDEZVOUS_ENTRIES - 1]);
    expect(listing).not.toContain(entries[MAX_NAMED_RENDEZVOUS_ENTRIES]);
    expect(listing).not.toContain(DISPLAY_TRUNCATION_MARKER);
  });

  test("a partner-chosen name is escaped exactly once at the sink", () => {
    // The partner syncs its own files into this directory, so an entry name is
    // partner-controlled text on its way to a display sink. Escaping it here as
    // well would reach the operator doubled: the transform is not idempotent.
    const bellName = `drop${String.fromCharCode(7)}ping.json`;
    const [, composed] = contentWarnings([bellName]);
    expect(composed).toContain(bellName);
    const rendered = sanitizeForDisplay(composed);
    expect(rendered).toContain("drop\\x07ping.json");
    expect(rendered).not.toContain("\\\\x07");
  });

  test("a name that escapes wide is counted rather than shown chopped", () => {
    // Escaping expands: a filename filled to the 255-byte limit with a character
    // that needs an escape renders several times its own length, so what bounds
    // the listing is the name's RENDERED cost, measured before it is admitted.
    const wide = String.fromCharCode(0xe9).repeat(127);
    const [, listing] = renderedContentWarnings(["a.json", wide]);
    expect(listing.length).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH);
    expect(listing).not.toContain(DISPLAY_TRUNCATION_MARKER);
    // A name the cap chopped looks like a whole name the operator could go and
    // delete, so the count absorbs it and the shorter name is still named.
    expect(listing).toContain("a.json");
    expect(listing).toContain("and 1 more");
  });

  test("a mount whose names all escape wide is counted rather than named", () => {
    const wide = String.fromCharCode(0xe9).repeat(127);
    const [, listing] = renderedContentWarnings([wide]);
    expect(listing).toContain("1 entry");
    expect(listing).not.toContain("\\xe9");
    expect(listing).not.toContain(DISPLAY_TRUNCATION_MARKER);
  });

  test("no warning truncates at the sink, whatever the mount holds", () => {
    const wide = String.fromCharCode(0xe9).repeat(127);
    const bell = `drop${String.fromCharCode(7)}ping.json`;
    const shapes: Array<Array<string>> = [
      ["console-hello.json"],
      retainedTranscript,
      Array.from(
        { length: 4 * MAX_NAMED_RENDEZVOUS_ENTRIES },
        (_unused, index) => `m${String(index).padStart(3, "0")}.json`,
      ),
      ["x".repeat(255)],
      ["a.json", "x".repeat(255), "b.json"],
      [wide, "c.json", bell],
      Array.from(
        { length: 12 },
        (_unused, index) => `${index}-${String.fromCharCode(0xe9).repeat(120)}`,
      ),
    ];
    for (const shape of shapes)
      for (const warning of renderedContentWarnings(shape)) {
        expect(warning).not.toContain(DISPLAY_TRUNCATION_MARKER);
        expect(warning.length).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH);
      }
  });

  test.skipIf(process.getuid?.() === 0)(
    "an unlistable mount says so rather than looking empty",
    () => {
      const rendezvous = tempDir("rendezvous");
      fs.writeFileSync(path.join(rendezvous, "console-hello.json"), "");
      fs.chmodSync(rendezvous, 0o300);
      try {
        const dataRoot = tempDir("data");
        const warnings = rendezvousStartupWarnings(
          rendezvous,
          "shared",
          tempDir("input"),
          dataRoot,
          path.join(dataRoot, "current-job"),
          SWEEP_OFF,
        );
        expect(
          warnings.some((warning) => warning.includes("cannot be listed")),
        ).toBe(true);
        expect(
          warnings.some((warning) => warning.includes("is not empty")),
        ).toBe(false);
      } finally {
        fs.chmodSync(rendezvous, 0o700);
      }
    },
  );
});

// Every notice shape below is driven across every leg, through the real display
// boundary rather than the composed string alone -- a truncated final clause
// would only show up there, not at composition. The mount path is the one
// unbounded fragment (operator-configured, with no length cap), so each shape
// runs at an ordinary path, where the notice must NAME the mount, and at a path
// far past the budget, where it must still fit its actionable clause.

/** One preflight notice shape: the branch that raises it, and the clause its copy
 * ends on -- the part a cap eats first. Every shape is driven over every leg label,
 * because a split console preflights each of its two mounts separately: the leg
 * lengthens the notice's own first-party wording, and for the unwritable mount it
 * changes the recovery outright. */
interface NoticeShape {
  label: string;
  /** Set the mount up so this branch is the one that fires, and hand back the
   * preflight's five arguments plus any mode to restore. */
  arrange: (
    mount: string,
    leg: RendezvousLeg,
  ) => {
    args: PreflightArgs;
    restore?: () => void;
  };
  /** Selects this shape's notice out of the warnings the call raised. */
  match: RegExp;
  /** The clause the notice must still end on at the seat, for the leg it is about. */
  tail: (leg: RendezvousLeg) => string;
  /** Whether the notice interpolates the mount path at all. The listing names the
   * mount's ENTRIES instead, and gives way by name rather than by path, while the
   * notices about the other side of the overlap comparison name that side's path. */
  namesMount: boolean;
  /** Skipped as root, whose access checks ignore the mode bits. */
  unprivilegedOnly?: boolean;
}

/** Every leg a notice is composed for: the single shared mount of a one-mount
 * console, and each half of a split console's pair. */
const NOTICE_LEGS: ReadonlyArray<RendezvousLeg> = [
  "shared",
  "inbound",
  "outbound",
];

/** How a notice names the mount it is about, which is all an operator with two
 * folders has to tell them apart by. Distinct per leg: the shared wording is not a
 * substring of either qualified one. */
function legPhrase(leg: RendezvousLeg): string {
  return leg === "shared" ? "the rendezvous " : `the ${leg} rendezvous `;
}

/** The bound the module holds itself to, asserted against the constant it exports
 * rather than a measured number: every notice a branch raises is fitted where it is
 * composed, so first-party copy that outgrows the budget fails here instead of
 * reaching the operator with its closing clause cut off at the seat. */
function expectWithinNoticeBudget(warnings: Array<string>): void {
  for (const warning of warnings)
    expect(renderedDisplayCost(warning)).toBeLessThanOrEqual(
      RENDEZVOUS_NOTICE_BUDGET,
    );
}

/** The preflight's own argument list: the mount, which leg it is, the work-input
 * directory, the data root, this launch's workdir, and its sweep intent. */
type PreflightArgs = [
  string,
  RendezvousLeg,
  string | undefined,
  string,
  string,
  boolean,
];

/** A path segment long enough that a mount built from it is past the notice budget
 * on its raw length alone, before any escaping. */
const OVERLONG_SEGMENT = "d".repeat(200);

/** A mount path whose own rendered cost is far past the notice budget, under a
 * fresh temp root. Nothing is created: each shape creates what its branch needs. */
function overlongMount(segment: string): string {
  return path.join(tempDir("rendezvous"), segment, segment);
}

/**
 * The mount an ordinary case is driven at: a path under a fresh temp directory,
 * pinned to {@link ORDINARY_MOUNT_COST} so every host composes the same notice.
 * Nothing is created: each shape creates what its branch needs.
 *
 * A root leaving no room for it is refused here rather than measured. What a notice
 * does with a mount it cannot fit is drop it, so a root that broke the assumption would
 * otherwise reach the cases as a fit that gave up a path it had room for.
 */
function ordinaryMount(root: string = TEST_TEMP_ROOT): string {
  const parent = tempDir("rendezvous", root);
  const nameCost =
    ORDINARY_MOUNT_COST -
    renderedDisplayCost(parent) -
    renderedDisplayCost(path.sep);
  if (nameCost < 1)
    throw new Error(
      `a mount pinned to ${ORDINARY_MOUNT_COST} rendered characters has no room ` +
        `left for a name under ${parent}, which spends ` +
        `${renderedDisplayCost(parent)} of them. These cases pin the mount's ` +
        "length so that what they measure is the notice fit rather than this " +
        "host's temp root; point TMPDIR (TEMP on Windows) at a short writable " +
        "directory.",
    );
  return path.join(parent, "d".repeat(nameCost));
}

/** Fixtures that keep every branch except this shape's own quiet: a data root and a
 * work-input directory that are siblings of the mount, never its ancestors. */
function isolatedArgs(
  mount: string,
  leg: RendezvousLeg,
  sweepExchangeFiles: boolean = SWEEP_OFF,
): PreflightArgs {
  const dataRoot = tempDir("data");
  return [
    mount,
    leg,
    tempDir("input"),
    dataRoot,
    path.join(dataRoot, "current-job"),
    sweepExchangeFiles,
  ];
}

const NOTICE_SHAPES: Array<NoticeShape> = [
  {
    label: "a mount that does not exist yet",
    arrange: (mount, leg) => ({ args: isolatedArgs(mount, leg) }),
    match: /does not exist yet/,
    tail: () =>
      "the exchange cannot rendezvous until both parties can reach it",
    namesMount: true,
  },
  {
    label: "a mount that is not a directory",
    arrange: (mount, leg) => {
      fs.mkdirSync(path.dirname(mount), { recursive: true });
      fs.writeFileSync(mount, "");
      return { args: isolatedArgs(mount, leg) };
    },
    match: /is not a directory/,
    tail: () => "is not a directory",
    namesMount: true,
  },
  {
    label: "a mount this process cannot write",
    unprivilegedOnly: true,
    arrange: (mount, leg) => {
      fs.mkdirSync(mount, { recursive: true });
      fs.chmodSync(mount, 0o500);
      return {
        args: isolatedArgs(mount, leg),
        restore: () => fs.chmodSync(mount, 0o700),
      };
    },
    match: /is not writable/,
    // The one notice whose recovery is the leg's own: this party writes nothing
    // into the inbound folder, so the reason a read-only one stops the run is the
    // exchange's own connect probe rather than its half of the rendezvous.
    tail: (leg) =>
      leg === "inbound"
        ? "the exchange checks write access on both rendezvous folders before it starts"
        : "the exchange writes its half of the rendezvous there",
    namesMount: true,
  },
  {
    label: "a mount this process cannot list",
    unprivilegedOnly: true,
    arrange: (mount, leg) => {
      fs.mkdirSync(mount, { recursive: true });
      fs.chmodSync(mount, 0o300);
      return {
        args: isolatedArgs(mount, leg),
        restore: () => fs.chmodSync(mount, 0o700),
      };
    },
    match: /cannot be listed/,
    tail: () => "is unknown until the exchange runs",
    namesMount: true,
  },
  {
    label: "the lead of a mount that is not empty",
    arrange: (mount, leg) => {
      fs.mkdirSync(mount, { recursive: true });
      fs.writeFileSync(path.join(mount, "console-hello.json"), "");
      return { args: isolatedArgs(mount, leg) };
    },
    match: /is not empty/,
    tail: () => "Your own input and results are not what it refuses over.",
    namesMount: true,
  },
  {
    // The same branch on a launch that already includes the sweep: the lead has a
    // second copy with its own length to fit, and a budget held only at the
    // wording a fresh launch reads is one the other form can overrun unseen.
    label: "the lead of a mount that is not empty on a sweeping launch",
    arrange: (mount, leg) => {
      fs.mkdirSync(mount, { recursive: true });
      fs.writeFileSync(path.join(mount, "console-hello.json"), "");
      return { args: isolatedArgs(mount, leg, SWEEP_ON) };
    },
    match: /is not empty/,
    tail: () => "your own input and results are not what it sweeps.",
    namesMount: true,
  },
  {
    label: "the listing of what a mount holds",
    arrange: (mount, leg) => {
      fs.mkdirSync(mount, { recursive: true });
      fs.writeFileSync(path.join(mount, "console-hello.json"), "");
      return { args: isolatedArgs(mount, leg) };
    },
    match: /holds/,
    tail: () => "console-hello.json",
    namesMount: false,
  },
  {
    label: "a mount overlapping the job data root",
    arrange: (mount, leg) => {
      fs.mkdirSync(mount, { recursive: true });
      // The mount's own parent is the data root, so BOTH unbounded fragments the
      // overlap notice interpolates grow together, as an operator's nested layout
      // makes them.
      const dataRoot = path.dirname(mount);
      return {
        args: [
          mount,
          leg,
          undefined,
          dataRoot,
          path.join(dataRoot, "current-job"),
          SWEEP_OFF,
        ] as PreflightArgs,
      };
    },
    match: /overlaps/,
    tail: () => "a partner's sync writes would reach it",
    namesMount: true,
  },
  {
    label: "a mount whose real path cannot be read",
    arrange: (mount, leg) => {
      fs.mkdirSync(mount, { recursive: true });
      // The fixtures are built before the resolution is blocked, so only the
      // preflight's own reads meet the failure.
      const args = isolatedArgs(mount, leg);
      return { args, restore: blockRealpath(mount) };
    },
    match: /could not be resolved/,
    tail: () =>
      "Give the console read access to every folder on the way to it.",
    namesMount: true,
  },
  {
    // The same narrowing from the other side of the comparison. It names the
    // data root's own path rather than the mount's, so the mount here is only
    // what the notice attributes itself to -- the fit of the path it does
    // interpolate is driven by the case below the table.
    label: "a data root whose real path cannot be read",
    arrange: (mount, leg) => {
      fs.mkdirSync(mount, { recursive: true });
      const dataRoot = tempDir("data");
      return {
        args: [
          mount,
          leg,
          tempDir("input"),
          dataRoot,
          path.join(dataRoot, "current-job"),
          SWEEP_OFF,
        ] as PreflightArgs,
        restore: blockRealpath(dataRoot),
      };
    },
    match: /^the job data root/,
    tail: () =>
      "Give the console read access to every folder on the way to it.",
    namesMount: false,
  },
  {
    label: "a work-input directory whose real path cannot be read",
    arrange: (mount, leg) => {
      fs.mkdirSync(mount, { recursive: true });
      const dataRoot = tempDir("data");
      const jobInput = tempDir("input");
      return {
        args: [
          mount,
          leg,
          jobInput,
          dataRoot,
          path.join(dataRoot, "current-job"),
          SWEEP_OFF,
        ] as PreflightArgs,
        restore: blockRealpath(jobInput),
      };
    },
    match: /^the work-input directory/,
    tail: () =>
      "Give the console read access to every folder on the way to it.",
    namesMount: false,
  },
];

/** The shapes whose notice interpolates the mount, less any this process cannot
 * arrange: as root the mode-bit branches never fire. These are the shapes whose
 * budget the mount shares, so they are the ones an ordinary mount has to fit. */
function mountNamingShapes(): Array<NoticeShape> {
  return NOTICE_SHAPES.filter(
    (shape) =>
      shape.namesMount && !(shape.unprivilegedOnly && process.getuid?.() === 0),
  );
}

/** The one notice `shape` raises for `mount` on `leg`, raw and as the seat renders
 * it, alongside every warning the same call raised. */
function noticeFor(
  shape: NoticeShape,
  mount: string,
  leg: RendezvousLeg,
): {
  raw: string;
  rendered: string;
  allRaw: Array<string>;
  allRendered: Array<string>;
} {
  const { args, restore } = shape.arrange(mount, leg);
  try {
    const warnings = rendezvousStartupWarnings(...args);
    const raw = warnings.find((warning) => shape.match.test(warning));
    expect(
      raw,
      `${shape.label}: the branch raised no matching notice`,
    ).toBeDefined();
    return {
      raw: raw!,
      rendered: renderedAtSeat([raw!])[0],
      allRaw: warnings,
      allRendered: renderedAtSeat(warnings),
    };
  } finally {
    restore?.();
  }
}

describe("every preflight notice fits its budget once rendered", () => {
  test("the composition budget is at or under the budget the seat applies", () => {
    // The two are what make fitting at composition sufficient: fit to the tighter
    // one and the wider one cannot cut. Were this to flip, every notice below would
    // pass its composition check and still be cut at the seat.
    expect(RENDEZVOUS_NOTICE_BUDGET).toBeLessThanOrEqual(
      WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    );
  });

  test("an ordinary mount fits the residual the widest notice leaves", () => {
    // What every ordinary case below rests on: a mount short enough that the fit
    // has no reason to drop it. The residual is what makes that an assumption rather
    // than a triviality -- a notice's own first-party copy is most of the budget,
    // so what is left for the mount is tens of characters, and a mount built under
    // the host's own temp root is one host apart from not fitting in it. Measured
    // against the pin here, so copy that grows into the residual reddens with the
    // arithmetic rather than as notices below that stopped naming their mount.
    const pathless = mountNamingShapes().flatMap((shape) =>
      NOTICE_LEGS.map((leg) =>
        renderedDisplayCost(
          noticeFor(shape, overlongMount(OVERLONG_SEGMENT), leg).raw,
        ),
      ),
    );
    const residual = RENDEZVOUS_NOTICE_BUDGET - Math.max(...pathless);
    // Strictly inside: the notice with the least room to spare sets the mount off
    // from its label with a space, which the mount's own cost does not cover.
    expect(ORDINARY_MOUNT_COST).toBeLessThan(residual);
    expect(renderedDisplayCost(ordinaryMount())).toBe(ORDINARY_MOUNT_COST);
  });

  test("a temp root too long for an ordinary mount is refused, not measured", () => {
    // The macOS case forced onto any host: `os.tmpdir()` there is
    // `/var/folders/<hash>/T`, long enough to spend the residual above on the root
    // alone, and what a notice then does with the mount is drop it silently.
    const longRoot = subDir(tempDir("root"), "T".repeat(ORDINARY_MOUNT_COST));
    expect(() => ordinaryMount(longRoot)).toThrow(/TMPDIR/);
  });

  for (const shape of NOTICE_SHAPES)
    for (const leg of NOTICE_LEGS) {
      const run =
        shape.unprivilegedOnly && process.getuid?.() === 0 ? test.skip : test;

      run(`${shape.label} gives nothing up at an ordinary ${leg} mount`, () => {
        const mount = ordinaryMount();
        const { raw, rendered, allRaw } = noticeFor(shape, mount, leg);
        // The residual: at an ordinary path nothing is given up, so a fit that
        // started dropping its fragment unconditionally would redden here rather
        // than pass quietly. The listing names no mount at all, giving way by
        // entry name instead.
        if (shape.namesMount) {
          expect(raw).toContain(mount);
          expect(rendered).toContain(mount);
        }
        expect(rendered).toContain(shape.tail(leg));
        // Which of the console's mounts the operator is being sent to.
        expect(rendered).toContain(legPhrase(leg));
        expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
        expectWithinNoticeBudget(allRaw);
      });

      // The two ways a mount runs a notice past the budget. The second is a segment
      // of confusables at a length whose RAW form still fits: what pushes it over is
      // the escape expansion alone, so a fit measuring raw lengths would keep the
      // path there. Which arithmetic the fit does is the whole of the difference
      // between the two classes, and the raw-length assumption below is what says so.
      for (const [pathLabel, segment, rawLengthFitsBudget] of [
        ["past the budget on its own length", OVERLONG_SEGMENT, false],
        [
          "past the budget only once escaped",
          WIDE_ESCAPING_CHAR.repeat(20),
          true,
        ],
      ] as const) {
        run(
          `${shape.label} keeps its closing clause at a ${leg} mount ${pathLabel}`,
          () => {
            const mount = overlongMount(segment);
            const { raw, rendered, allRaw, allRendered } = noticeFor(
              shape,
              mount,
              leg,
            );

            // The case is only worth driving if the mount really is past the budget:
            // a path that fits proves nothing about the fit.
            expect(renderedDisplayCost(mount)).toBeGreaterThan(
              RENDEZVOUS_NOTICE_BUDGET,
            );
            expect(
              mount.length <= RENDEZVOUS_NOTICE_BUDGET,
              `${pathLabel}: the mount's raw length is what separates the two classes`,
            ).toBe(rawLengthFitsBudget);

            // Every notice the branch raised, not just this shape's own: what is
            // left once the path gives way is first-party copy, and the leg is part
            // of it, so a leg's wording that outgrows the budget fails here.
            expectWithinNoticeBudget(allRaw);
            // The mount is what gives way, and it gives way WHOLE: a clipped path
            // looks like a path the operator could go and look at.
            if (shape.namesMount) expect(raw).not.toContain(mount);
            expect(rendered).toContain(shape.tail(leg));
            expect(rendered).toContain(legPhrase(leg));
            expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
            expect(rendered.length).toBeLessThanOrEqual(
              WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
            );
            // Not just this shape's own notice: a branch that raises several must
            // deliver all of them whole.
            for (const other of allRendered)
              expect(other).not.toContain(DISPLAY_TRUNCATION_MARKER);
          },
        );
      }
    }

  test("the overlap notice gives way to a long directory on either side", () => {
    // The only notice naming TWO operator-configured paths, and containment is
    // symmetric: a work-input directory nested deep under a short mount runs the
    // notice past its budget from the other side. Both go together, and the
    // first-party label is what still names which directory was overlapped.
    const mount = tempDir("rendezvous");
    const jobInput = path.join(mount, "d".repeat(200), "d".repeat(200));
    fs.mkdirSync(jobInput, { recursive: true });
    const dataRoot = tempDir("data");

    const warnings = rendezvousStartupWarnings(
      mount,
      "shared",
      jobInput,
      dataRoot,
      path.join(dataRoot, "current-job"),
      SWEEP_OFF,
    );
    const overlap = warnings.find((warning) =>
      warning.includes("the work-input directory"),
    );
    expect(overlap).toBeDefined();
    expect(renderedDisplayCost(jobInput)).toBeGreaterThan(
      RENDEZVOUS_NOTICE_BUDGET,
    );
    expect(overlap).not.toContain(jobInput);
    expect(overlap).not.toContain(mount);

    for (const rendered of renderedAtSeat(warnings))
      expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
    expect(renderedAtSeat([overlap!])[0]).toContain(
      "a partner's sync writes would reach it",
    );
  });

  test("the unresolved-side notice gives way to a long data root", () => {
    // The path this notice interpolates is the other side's, not the mount's, so
    // the fit is driven from that side. What survives is the sentence: which side
    // could not be resolved, which folder it was compared with, and the read
    // access to restore -- none of which the operator can reconstruct.
    const dataRoot = path.join(
      tempDir("data"),
      OVERLONG_SEGMENT,
      OVERLONG_SEGMENT,
    );
    fs.mkdirSync(dataRoot, { recursive: true });
    const warnings = withUnreadableRealpath(dataRoot, () =>
      rendezvousStartupWarnings(
        tempDir("rendezvous"),
        "inbound",
        undefined,
        dataRoot,
        path.join(dataRoot, "current-job"),
        SWEEP_OFF,
      ),
    );
    const notice = warnings.find((warning) =>
      warning.startsWith("the job data root"),
    );
    expect(notice).toBeDefined();
    expect(renderedDisplayCost(dataRoot)).toBeGreaterThan(
      RENDEZVOUS_NOTICE_BUDGET,
    );
    expect(notice).not.toContain(dataRoot);
    expectWithinNoticeBudget(warnings);

    for (const rendered of renderedAtSeat(warnings))
      expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
    const rendered = renderedAtSeat([notice!])[0];
    expect(rendered).toContain(legPhrase("inbound"));
    expect(rendered).toContain(
      "Give the console read access to every folder on the way to it.",
    );
  });
});
