import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  MAX_ENDPOINT_PATH_LENGTH,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  renderedDisplayCost,
  sanitizeForDisplay,
} from "@psilink/core";

import { MAX_INPUT_NAME_LENGTH } from "@jobs/workInputName";
import { appendSanitizedRunWarning } from "@bench/runWarnings";

import {
  MAX_NAMED_RENDEZVOUS_ENTRIES,
  RENDEZVOUS_NOTICE_BUDGET,
  notEmptyLead,
  rendezvousStartupWarnings,
  resolveJobRendezvousDir,
  resolveJobRendezvousFolderName,
  resolveJobRendezvousLocator,
  useJobRendezvousDir,
  useJobRendezvousFolderName,
} from "@jobs/jobRendezvous";

const dirs: Array<string> = [];

/** A fresh, existing, writable directory under the OS temp dir, so the preflight's
 * stat checks pass and only the overlap branch can add a warning. */
function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `psilink-${label}-`));
  dirs.push(dir);
  return dir;
}

/** Cyrillic small a: one character of a path that the display boundary escapes six
 * characters wide, so a fragment built from it costs six times what its own length
 * says. Written as an escape because the point of it is that a reader cannot tell it
 * from the Latin letter. */
const WIDE_ESCAPING_CHAR = "\u0430";

/** A nested (existing, writable) subdirectory of `parent`. */
function subDir(parent: string, name: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  (globalThis as { jobRendezvousDirConfig?: unknown }).jobRendezvousDirConfig =
    undefined;
});

describe("useJobRendezvousDir", () => {
  test("resolves a set directory to an absolute path and memoizes it", () => {
    const dir = tempDir("rendezvous");
    const first = useJobRendezvousDir({ JOB_RENDEZVOUS_DIR: dir });
    expect(first).toBe(path.resolve(dir));
    // The second call ignores a changed env: the value is memoized on globalThis.
    expect(useJobRendezvousDir({ JOB_RENDEZVOUS_DIR: "/elsewhere" })).toBe(
      first,
    );
  });

  test("defaults to JOB_DATA_ROOT when JOB_RENDEZVOUS_DIR is unset", () => {
    const dataRoot = tempDir("data");
    expect(useJobRendezvousDir({ JOB_DATA_ROOT: dataRoot })).toBe(
      path.resolve(dataRoot),
    );
  });

  test("an explicit JOB_RENDEZVOUS_DIR overrides the data-root fallback", () => {
    const rendezvous = tempDir("rendezvous");
    const dataRoot = tempDir("data");
    expect(
      useJobRendezvousDir({
        JOB_RENDEZVOUS_DIR: rendezvous,
        JOB_DATA_ROOT: dataRoot,
      }),
    ).toBe(path.resolve(rendezvous));
  });

  test("is undefined when both JOB_RENDEZVOUS_DIR and JOB_DATA_ROOT are unset", () => {
    expect(useJobRendezvousDir({})).toBeUndefined();
  });
});

/** The name and the locator together, as the rendezvous route composes them: the
 * shared folder's name where the console can name it, and the value the invitation
 * carries either way. */
function locatorFor(env: NodeJS.ProcessEnv): {
  folderName: string | undefined;
  locator: string | undefined;
} {
  const dir = resolveJobRendezvousDir(env);
  const folderName = resolveJobRendezvousFolderName(env, dir);
  return { folderName, locator: resolveJobRendezvousLocator(dir, folderName) };
}

describe("the shared folder's name the invitation is minted from", () => {
  test("a name the segment rule admits can never be what fails a mint", () => {
    // The folder-name bound rides the shared segment rule's 255-character cap;
    // the endpoint schema's path cap is what a mint enforces. The inequality is
    // the load-bearing fact: were it to flip, an admitted name could fail the
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
      // Deliberately NOT falling back to the mount point: a caller that set the
      // variable has already said the mount point does not name the folder.
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
      useJobRendezvousFolderName({
        JOB_RENDEZVOUS_DIR: dir,
        JOB_RENDEZVOUS_NAME: "study-a",
      }),
    ).toBe("study-a");
    expect(
      useJobRendezvousFolderName({ JOB_RENDEZVOUS_NAME: "something-else" }),
    ).toBe("study-a");
    expect(useJobRendezvousDir({})).toBe(path.resolve(dir));
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
        undefined,
        dataRoot,
        path.join(dataRoot, "current-job"),
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
        undefined,
        dataRoot,
        path.join(dataRoot, "current-job"),
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
        shared,
        dataRoot,
        path.join(dataRoot, "current-job"),
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
        jobInput,
        dataRoot,
        path.join(dataRoot, "current-job"),
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
        jobInput,
        dataRoot,
        path.join(dataRoot, "current-job"),
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
        jobInput,
        dataRoot,
        path.join(dataRoot, "current-job"),
      ),
    ).toEqual([]);
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
 * as the job event stream carries them. */
function contentWarnings(entries: Array<string>): Array<string> {
  const rendezvous = tempDir("rendezvous");
  const dataRoot = tempDir("data");
  for (const entry of entries)
    fs.writeFileSync(path.join(rendezvous, entry), "");
  return rendezvousStartupWarnings(
    rendezvous,
    tempDir("input"),
    dataRoot,
    path.join(dataRoot, "current-job"),
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
function renderedContentWarnings(entries: Array<string>): Array<string> {
  return renderedAtSeat(contentWarnings(entries));
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

  test("the lead reaches the operator carrying its whole recovery", () => {
    // The sink caps what it renders, and the clause the cap would eat first is
    // the one that keeps the recovery from reading as "empty this folder".
    const [lead] = renderedContentWarnings(["console-hello.json"]);
    expect(lead).toContain("an exchange refuses to start");
    expect(lead).toContain("delete those on the host first");
    expect(lead).toContain(
      "Your own input and results are not what it refuses over",
    );
    expect(lead).not.toContain(DISPLAY_TRUNCATION_MARKER);
  });

  test("a console mount path rides in the lead", () => {
    const lead = notEmptyLead("/data");
    expect(lead).toContain("/data");
    expect(sanitizeForDisplay(lead)).not.toContain(DISPLAY_TRUNCATION_MARKER);
  });

  test("a mount path too long for the lead is left out of it", () => {
    // The path is the lead's only unbounded part, and the recovery is what a
    // truncation would cut, so the path is what gives way.
    const deepMount = `/mnt/${"d".repeat(300)}`;
    const lead = notEmptyLead(deepMount);
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
    expect(notEmptyLead(asciiMount)).toContain(asciiMount);
    expect(notEmptyLead(escapedMount)).not.toContain(escapedMount);
    expect(sanitizeForDisplay(notEmptyLead(escapedMount))).not.toContain(
      DISPLAY_TRUNCATION_MARKER,
    );
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
      tempDir("input"),
      dataRoot,
      path.join(dataRoot, "current-job"),
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
      undefined,
      shared,
      workdir,
    ).filter(isContentWarning);
    expect(warnings).toEqual([]);
  });

  test("leftovers beside the job's own workdir are reported without naming it", () => {
    const shared = tempDir("shared");
    const workdir = subDir(shared, "0f6e2c1a-current");
    fs.writeFileSync(path.join(shared, "console-hello.json"), "");
    const warnings = rendezvousStartupWarnings(
      shared,
      undefined,
      shared,
      workdir,
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
    // A name the cap chopped reads like a whole name the operator could go and
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

  test("an unlistable mount says so rather than reading as empty", () => {
    if (process.getuid?.() === 0) return;
    const rendezvous = tempDir("rendezvous");
    fs.writeFileSync(path.join(rendezvous, "console-hello.json"), "");
    fs.chmodSync(rendezvous, 0o300);
    try {
      const dataRoot = tempDir("data");
      const warnings = rendezvousStartupWarnings(
        rendezvous,
        tempDir("input"),
        dataRoot,
        path.join(dataRoot, "current-job"),
      );
      expect(
        warnings.some((warning) => warning.includes("cannot be listed")),
      ).toBe(true);
      expect(warnings.some((warning) => warning.includes("is not empty"))).toBe(
        false,
      );
    } finally {
      fs.chmodSync(rendezvous, 0o700);
    }
  });
});

// Every notice the preflight can raise, driven through the branch that raises it
// and then through the seat's real display boundary. The mount path is the one
// unbounded fragment in all of them -- it is the operator's own server-side
// configuration, and nothing caps its length -- so each shape is driven twice: once
// at an ordinary path, where the notice must NAME the mount, and once at a path far
// past the budget, where the notice must still deliver the clause the operator acts
// on. Truncation cutting a warning's final clause is the failure this table exists
// to catch, and it is invisible to a check that reads only the composed string:
// composing is where the fit is decided, but the seat is where the cut would land.

/** One preflight notice shape: the branch that raises it, and the clause its copy
 * ends on -- the part a cap eats first. */
interface NoticeShape {
  label: string;
  /** Set the mount up so this branch is the one that fires, and hand back the
   * preflight's four arguments plus any mode to restore. */
  arrange: (mount: string) => {
    args: [string, string | undefined, string, string];
    restore?: () => void;
  };
  /** Selects this shape's notice out of the warnings the call raised. */
  match: RegExp;
  /** The clause the notice must still end on at the seat. */
  tail: string;
  /** Whether the notice interpolates the mount path at all. The listing names the
   * mount's ENTRIES instead, and gives way by name rather than by path. */
  namesMount: boolean;
  /** Skipped as root, whose access checks ignore the mode bits. */
  unprivilegedOnly?: boolean;
}

/** A mount path whose own rendered cost is far past the notice budget, under a
 * fresh temp root. Nothing is created: each shape creates what its branch needs. */
function overlongMount(segment: string): string {
  return path.join(tempDir("rendezvous"), segment, segment);
}

/** Fixtures that keep every branch except this shape's own quiet: a data root and a
 * work-input directory that are siblings of the mount, never its ancestors. */
function isolatedArgs(
  mount: string,
): [string, string | undefined, string, string] {
  const dataRoot = tempDir("data");
  return [
    mount,
    tempDir("input"),
    dataRoot,
    path.join(dataRoot, "current-job"),
  ];
}

const NOTICE_SHAPES: Array<NoticeShape> = [
  {
    label: "a mount that does not exist yet",
    arrange: (mount) => ({ args: isolatedArgs(mount) }),
    match: /does not exist yet/,
    tail: "the exchange cannot rendezvous until both parties can reach it",
    namesMount: true,
  },
  {
    label: "a mount that is not a directory",
    arrange: (mount) => {
      fs.mkdirSync(path.dirname(mount), { recursive: true });
      fs.writeFileSync(mount, "");
      return { args: isolatedArgs(mount) };
    },
    match: /is not a directory/,
    tail: "is not a directory",
    namesMount: true,
  },
  {
    label: "a mount this process cannot write",
    unprivilegedOnly: true,
    arrange: (mount) => {
      fs.mkdirSync(mount, { recursive: true });
      fs.chmodSync(mount, 0o500);
      return {
        args: isolatedArgs(mount),
        restore: () => fs.chmodSync(mount, 0o700),
      };
    },
    match: /is not writable/,
    tail: "the exchange writes its half of the rendezvous there",
    namesMount: true,
  },
  {
    label: "a mount this process cannot list",
    unprivilegedOnly: true,
    arrange: (mount) => {
      fs.mkdirSync(mount, { recursive: true });
      fs.chmodSync(mount, 0o300);
      return {
        args: isolatedArgs(mount),
        restore: () => fs.chmodSync(mount, 0o700),
      };
    },
    match: /cannot be listed/,
    tail: "is unknown until the exchange runs",
    namesMount: true,
  },
  {
    label: "the lead of a mount that is not empty",
    arrange: (mount) => {
      fs.mkdirSync(mount, { recursive: true });
      fs.writeFileSync(path.join(mount, "console-hello.json"), "");
      return { args: isolatedArgs(mount) };
    },
    match: /is not empty/,
    tail: "Your own input and results are not what it refuses over.",
    namesMount: true,
  },
  {
    label: "the listing of what a mount holds",
    arrange: (mount) => {
      fs.mkdirSync(mount, { recursive: true });
      fs.writeFileSync(path.join(mount, "console-hello.json"), "");
      return { args: isolatedArgs(mount) };
    },
    match: /holds/,
    tail: "console-hello.json",
    namesMount: false,
  },
  {
    label: "a mount overlapping the job data root",
    arrange: (mount) => {
      fs.mkdirSync(mount, { recursive: true });
      // The mount's own parent is the data root, so BOTH unbounded fragments the
      // overlap notice interpolates grow together, as an operator's nested layout
      // makes them.
      const dataRoot = path.dirname(mount);
      return {
        args: [
          mount,
          undefined,
          dataRoot,
          path.join(dataRoot, "current-job"),
        ] as [string, string | undefined, string, string],
      };
    },
    match: /overlaps/,
    tail: "a partner's sync writes would reach it",
    namesMount: true,
  },
];

/** The one notice `shape` raises for `mount`, raw and as the seat renders it,
 * alongside every warning the same call raised. */
function noticeFor(
  shape: NoticeShape,
  mount: string,
): { raw: string; rendered: string; allRendered: Array<string> } {
  const { args, restore } = shape.arrange(mount);
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

  for (const shape of NOTICE_SHAPES) {
    const run =
      shape.unprivilegedOnly && process.getuid?.() === 0 ? test.skip : test;

    run(`${shape.label} gives nothing up at an ordinary mount`, () => {
      const mount = path.join(tempDir("rendezvous"), "drops");
      const { raw, rendered } = noticeFor(shape, mount);
      // The residual: at an ordinary path nothing is given up, so a fit that
      // started dropping its fragment unconditionally would redden here rather
      // than pass quietly.
      const kept = shape.namesMount ? mount : shape.tail;
      expect(raw).toContain(kept);
      expect(rendered).toContain(kept);
      expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
    });

    // The two ways a mount runs a notice past the budget. The second is a segment
    // of confusables at a length whose RAW form still fits: what carries it over is
    // the escape expansion alone, so a fit measuring raw lengths would keep the
    // path there. Which arithmetic the fit does is the whole of the difference
    // between the two classes, and the raw-length premise below is what says so.
    for (const [pathLabel, segment, rawLengthFitsBudget] of [
      ["past the budget on its own length", "d".repeat(200), false],
      [
        "past the budget only once escaped",
        WIDE_ESCAPING_CHAR.repeat(20),
        true,
      ],
    ] as const) {
      run(
        `${shape.label} keeps its closing clause at a mount ${pathLabel}`,
        () => {
          const mount = overlongMount(segment);
          const { raw, rendered, allRendered } = noticeFor(shape, mount);

          // The case is only worth driving if the mount really is past the budget:
          // a path that fits proves nothing about the fit.
          expect(renderedDisplayCost(mount)).toBeGreaterThan(
            RENDEZVOUS_NOTICE_BUDGET,
          );
          expect(
            mount.length <= RENDEZVOUS_NOTICE_BUDGET,
            `${pathLabel}: the mount's raw length is what separates the two classes`,
          ).toBe(rawLengthFitsBudget);

          expect(renderedDisplayCost(raw)).toBeLessThanOrEqual(
            RENDEZVOUS_NOTICE_BUDGET,
          );
          // The mount is what gives way, and it gives way WHOLE: a clipped path
          // reads like a path the operator could go and look at.
          if (shape.namesMount) expect(raw).not.toContain(mount);
          expect(rendered).toContain(shape.tail);
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
      jobInput,
      dataRoot,
      path.join(dataRoot, "current-job"),
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
});
