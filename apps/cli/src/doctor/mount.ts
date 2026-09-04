import fs from "node:fs";
import path from "node:path";

import type { SmbMountInput } from "./smbEnvironment";
import type { DoctorCheckRecord, DoctorReport } from "./verdict";
import { fail, ok, skipped, warn } from "./verdict";

// The kernel half of the file-drop checks: the operations psilink's rendezvous
// is built on, run over the real mount rather than over smbclient, which refuses
// a rename onto an existing file whatever the server would have allowed. A share
// can pass every userspace check and still fail here, so both halves are run --
// and the marker cross-check is what proves they were looking at the same
// directory.

/**
 * The checks `doctor mount` reports, in order. Fixed, for the reason the probe's
 * list is: a check that did not run is `skipped`, never absent.
 */
export const MOUNT_CHECK_IDS = [
  "mount_readable",
  "marker",
  "write_rename",
  "exclusive_create",
  "rename_onto_existing",
] as const;

/** Working names this battery creates and removes inside the mounted folder. */
const WRITE_NAME = ".psilink-w.tmp";
const WRITE_RENAMED_NAME = ".psilink-w2.tmp";
const EXCLUSIVE_NAME = ".psilink-x.tmp";
const RENAME_SOURCE_NAME = ".psilink-a.tmp";
const RENAME_TARGET_NAME = ".psilink-b.tmp";

/**
 * The filesystem operations the battery performs, injectable so a share that
 * answers differently from the local disk -- one that does not refuse an
 * exclusive create, one that will not rename onto an existing file -- can be
 * exercised without one.
 */
export interface MountFs {
  /** Throws unless `directory` exists and can be listed. */
  readDirectory(directory: string): string[];
  readFileUtf8(file: string): string;
  writeFile(file: string, contents: string): void;
  /**
   * Create `file`, failing if it already exists. This is `O_EXCL` on a real
   * open(2) -- the same call psilink's rendezvous uses to decide which side goes
   * first, not a proxy for it -- so a share that does not honour the refusal is
   * caught here rather than at the start of an exchange.
   */
  createExclusive(file: string): void;
  rename(from: string, to: string): void;
  /** Best-effort removal; a file that is not there is not an error. */
  remove(file: string): void;
}

/** The real filesystem. */
export const nodeMountFs: MountFs = {
  readDirectory: (directory) => fs.readdirSync(directory),
  readFileUtf8: (file) => fs.readFileSync(file, "utf8"),
  writeFile: (file, contents) => fs.writeFileSync(file, contents),
  createExclusive: (file) => fs.closeSync(fs.openSync(file, "wx")),
  rename: (from, to) => fs.renameSync(from, to),
  remove: (file) => fs.rmSync(file, { force: true }),
};

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? "unknown error";
}

function padSkipped(checks: DoctorCheckRecord[]): DoctorCheckRecord[] {
  const seen = new Set(checks.map((check) => check.id));
  return [
    ...checks,
    ...MOUNT_CHECK_IDS.filter((id) => !seen.has(id)).map((id) =>
      skipped(id, "not run: an earlier check did not pass.", {
        meaning:
          "an earlier check failed and the remaining checks did not run, " +
          "so nothing was established about this one.",
      }),
    ),
  ];
}

/** The marker cross-check: is the mounted folder the one the probe tested? */
function markerCheck(
  directory: string,
  input: SmbMountInput,
  mountFs: MountFs,
): DoctorCheckRecord {
  if (input.marker === "" || input.token === "")
    return skipped(
      "marker",
      "no marker and token were supplied, so this folder was not cross-checked " +
        "against the one `psilink doctor probe` tested.",
      {
        meaning:
          "does not apply to the inputs given: no marker and token were " +
          "supplied.",
      },
    );
  const markerPath = path.join(directory, input.marker);
  let contents: string;
  try {
    contents = mountFs.readFileUtf8(markerPath);
  } catch {
    return fail(
      "marker",
      `${input.marker} is not in this folder.`,
      "the file the network checks left behind is not visible here. Either " +
        "a previous `doctor mount` already consumed it -- run `doctor probe` " +
        "again first -- or the mount and those checks are pointing at " +
        "different directories: the server, share, or subfolder is wrong " +
        "somewhere, and a DFS path is the usual reason, because the " +
        "namespace and the real location can differ in all three.",
      "read the real path from the folder's Properties, DFS tab, and set " +
        "SMB_SERVER, SMB_SHARE and SMB_PATH from it. See the troubleshooting " +
        "page, 'Reading the real path from Windows'.",
    );
  }
  if (contents.trim() !== input.token)
    return warn(
      "marker",
      `${input.marker} is here but is not this run's file.`,
      "either someone else is setting up this same share right now, or an " +
        "earlier run left the file behind. The mount reached the folder either " +
        "way.",
      `to tell the two apart, delete ${input.marker} from the drop folder ` +
        "and run this again: if it comes back, you have company.",
    );
  // The mount check owns the marker's lifecycle: the probe deliberately leaves
  // it, and this is where it is consumed. A mount that matches but refuses the
  // delete still gets its verdict -- the write checks below own that diagnosis.
  try {
    mountFs.remove(markerPath);
  } catch {
    return warn(
      "marker",
      "the folders match, but the marker could not be removed.",
      "the mount and the network checks agree on this folder, and this mount " +
        "refuses deletes -- expect the write checks below to fail too.",
      `remove ${input.marker} from the drop folder yourself once write ` +
        "access is fixed.",
    );
  }
  return ok("marker", "the mount and the network checks agree on this folder.");
}

/**
 * Run the mount-semantics battery against an already-mounted directory and
 * report a verdict. Every file it creates is removed before it returns.
 */
export function runMountChecks(
  directory: string,
  input: SmbMountInput,
  mountFs: MountFs = nodeMountFs,
): DoctorReport {
  const checks: DoctorCheckRecord[] = [];
  const at = (name: string): string => path.join(directory, name);

  // A working name the battery cannot clear -- usually a directory someone left
  // in the shared drop folder, which best-effort remove() cannot take -- blocks
  // that one check, never the battery: the verdict document comes back whatever
  // the folder holds.
  const clearName = (name: string): boolean => {
    try {
      mountFs.remove(at(name));
      return true;
    } catch {
      return false;
    }
  };
  const occupied = (id: string, name: string): DoctorCheckRecord =>
    fail(
      id,
      `${name} is in this folder and cannot be removed.`,
      "something is occupying a name this check creates and removes -- " +
        "usually a folder with the doctor's working name.",
      `remove ${name} from the drop folder and run this again.`,
    );

  try {
    mountFs.readDirectory(directory);
  } catch (err) {
    checks.push(
      fail(
        "mount_readable",
        `${directory} could not be read (${errorCode(err)}).`,
        "the folder the exchange runs in is not there, or is not a directory " +
          "this process can list. Nothing about the share itself has been " +
          "established.",
        "check that the volume is mounted at this path and that the container " +
          "was started with it attached.",
        { blocksRun: true },
      ),
    );
    return { mode: "mount", checks: padSkipped(checks) };
  }
  checks.push(ok("mount_readable", `${directory} is readable.`));

  checks.push(markerCheck(directory, input, mountFs));

  const writeBlocked = !clearName(WRITE_NAME)
    ? WRITE_NAME
    : !clearName(WRITE_RENAMED_NAME)
      ? WRITE_RENAMED_NAME
      : undefined;
  if (writeBlocked !== undefined) {
    checks.push(occupied("write_rename", writeBlocked));
    return { mode: "mount", checks: padSkipped(checks) };
  }
  try {
    // Write under a temporary name and rename into place, which is what psilink
    // does for every message: read access alone is not enough, and neither is
    // create-without-rename.
    mountFs.writeFile(at(WRITE_NAME), "psilink write probe\n");
    mountFs.rename(at(WRITE_NAME), at(WRITE_RENAMED_NAME));
    mountFs.remove(at(WRITE_RENAMED_NAME));
    checks.push(ok("write_rename", "wrote a file and renamed it into place."));
  } catch (err) {
    checks.push(
      fail(
        "write_rename",
        `could not write and rename in this folder (${errorCode(err)}).`,
        "the mount reached a folder but psilink cannot write in it. Either " +
          "the account this container runs as does not own the folder, or it " +
          "can open the folder but not create files in it, or the share is " +
          "out of space.",
        "see the troubleshooting page, 'The folder cannot be written to'.",
      ),
    );
    clearName(WRITE_NAME);
    clearName(WRITE_RENAMED_NAME);
    return { mode: "mount", checks: padSkipped(checks) };
  }

  if (!clearName(EXCLUSIVE_NAME)) {
    checks.push(occupied("exclusive_create", EXCLUSIVE_NAME));
  } else {
    runExclusiveCreate();
  }

  const renameBlocked = !clearName(RENAME_SOURCE_NAME)
    ? RENAME_SOURCE_NAME
    : !clearName(RENAME_TARGET_NAME)
      ? RENAME_TARGET_NAME
      : undefined;
  if (renameBlocked !== undefined) {
    checks.push(occupied("rename_onto_existing", renameBlocked));
  } else {
    runRenameOntoExisting();
  }

  return { mode: "mount", checks };

  function runExclusiveCreate(): void {
    let created = false;
    try {
      mountFs.createExclusive(at(EXCLUSIVE_NAME));
      created = true;
    } catch {
      checks.push(
        skipped(
          "exclusive_create",
          "could not test exclusive create on this share.",
          {
            meaning:
              "the check was attempted and could not be completed: psilink " +
              "uses an exclusive create to decide which side goes first, and " +
              "this share would not stage one.",
            action:
              "if the exchange hangs at the start, pass --lockless-rendezvous on " +
              "both sides.",
          },
        ),
      );
    }
    if (created) {
      let refused = true;
      try {
        mountFs.createExclusive(at(EXCLUSIVE_NAME));
        refused = false;
      } catch {
        refused = true;
      }
      checks.push(
        refused
          ? ok("exclusive_create", "the share refuses to create a file twice.")
          : warn(
              "exclusive_create",
              "this share does not refuse to create a file that already exists.",
              "psilink uses that refusal to decide which side goes first, so " +
                "without it both sides can believe they did.",
              "pass --lockless-rendezvous on BOTH sides of the exchange.",
            ),
      );
      clearName(EXCLUSIVE_NAME);
    }
  }

  function runRenameOntoExisting(): void {
    try {
      mountFs.writeFile(at(RENAME_SOURCE_NAME), "a\n");
      mountFs.writeFile(at(RENAME_TARGET_NAME), "b\n");
      try {
        mountFs.rename(at(RENAME_SOURCE_NAME), at(RENAME_TARGET_NAME));
        checks.push(
          ok(
            "rename_onto_existing",
            "the share renames onto an existing file.",
          ),
        );
      } catch {
        checks.push(
          warn(
            "rename_onto_existing",
            "this share will not rename a file onto an existing one.",
            "psilink does that when two sides meet at once.",
            "pass --lockless-rendezvous on BOTH sides of the exchange.",
          ),
        );
      }
    } catch (err) {
      checks.push(
        skipped(
          "rename_onto_existing",
          `could not stage the rename test (${errorCode(err)}).`,
          {
            meaning:
              "the files this check renames could not be created, so " +
              "nothing was established about renaming.",
          },
        ),
      );
    } finally {
      clearName(RENAME_SOURCE_NAME);
      clearName(RENAME_TARGET_NAME);
    }
  }
}
