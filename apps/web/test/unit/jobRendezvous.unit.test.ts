import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  MAX_ENDPOINT_PATH_LENGTH,
  sanitizeForDisplay,
} from "@psilink/core";

import { MAX_INPUT_NAME_LENGTH } from "@jobs/workInputName";

import {
  MAX_NAMED_RENDEZVOUS_ENTRIES,
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

/** The same warnings as the operator reads them: each console warning sink stores
 * `sanitizeForDisplay(message)`, so this is core's real display transform -- escaping
 * and 256-character cap both -- applied once to what the preflight composed. Every
 * assertion about what the operator sees is made on this side of it. */
function renderedContentWarnings(entries: Array<string>): Array<string> {
  return contentWarnings(entries).map((warning) => sanitizeForDisplay(warning));
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
