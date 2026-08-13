import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  MAX_ENDPOINT_PATH_LENGTH,
} from "@psilink/core";

import { MAX_INPUT_NAME_LENGTH } from "@jobs/workInputName";

import {
  MAX_NAMED_RENDEZVOUS_ENTRIES,
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
      rendezvousStartupWarnings(rendezvous, undefined, dataRoot),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the job data root");
  });

  test("warns when the data root is nested inside the rendezvous", () => {
    const rendezvous = tempDir("rendezvous");
    const dataRoot = subDir(rendezvous, "data");
    const warnings = overlapWarnings(
      rendezvousStartupWarnings(rendezvous, undefined, dataRoot),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the job data root");
  });

  test("warns when the rendezvous equals the work-input directory", () => {
    const shared = tempDir("shared");
    const dataRoot = tempDir("data");
    const warnings = overlapWarnings(
      rendezvousStartupWarnings(shared, shared, dataRoot),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the work-input directory");
  });

  test("warns when the work-input directory contains the rendezvous", () => {
    const jobInput = tempDir("input");
    const rendezvous = subDir(jobInput, "rendezvous");
    const dataRoot = tempDir("data");
    const warnings = overlapWarnings(
      rendezvousStartupWarnings(rendezvous, jobInput, dataRoot),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the work-input directory");
  });

  test("warns twice when the rendezvous contains both the data root and the work-input directory", () => {
    const rendezvous = tempDir("rendezvous");
    const dataRoot = subDir(rendezvous, "data");
    const jobInput = subDir(rendezvous, "input");
    const warnings = overlapWarnings(
      rendezvousStartupWarnings(rendezvous, jobInput, dataRoot),
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
    expect(rendezvousStartupWarnings(rendezvous, jobInput, dataRoot)).toEqual(
      [],
    );
  });
});

/** The rendezvous preflight run over a directory holding `entries`, isolated from
 * the overlap branch by non-overlapping sibling fixtures, and reduced to the
 * warnings about what the directory holds. */
function contentWarnings(entries: Array<string>): Array<string> {
  const rendezvous = tempDir("rendezvous");
  for (const entry of entries)
    fs.writeFileSync(path.join(rendezvous, entry), "");
  return rendezvousStartupWarnings(
    rendezvous,
    tempDir("input"),
    tempDir("data"),
  ).filter(
    (warning) =>
      warning.includes("is not empty") || warning.includes("cannot be listed"),
  );
}

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
    const transcript = [
      "console-hello.json",
      "partner-hello.json",
      "console-partner-hello-ack.json",
      "console-20260812T101500123Z-001-4096.json",
      "partner-console-20260812T101500123Z-001-4096-ack.json",
    ];
    const warnings = contentWarnings(transcript);
    expect(warnings).toHaveLength(1);
    for (const name of transcript) expect(warnings[0]).toContain(name);
  });

  test("the warning carries the recovery, not just the listing", () => {
    const warnings = contentWarnings(["console-hello.json"]);
    expect(warnings[0]).toContain("delete those on the host before launching");
    // The operator's own files share this mount in the single-folder layout, and
    // the exchange tolerates them; the recovery must not read as "empty it".
    expect(warnings[0]).toContain("your own input and results are not among");
  });

  test("files the exchange has no claim on are reported the same way", () => {
    // Sorting protocol files from foreign ones is the exchange's grammar, not the
    // console's: the listing names what is there and the operator judges it.
    const warnings = contentWarnings(["patients.csv", "notes.txt"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("patients.csv");
    expect(warnings[0]).toContain("notes.txt");
  });

  test("a subdirectory makes the mount non-empty as a loose file does", () => {
    const rendezvous = tempDir("rendezvous");
    fs.mkdirSync(path.join(rendezvous, "prior-job"));
    const warnings = rendezvousStartupWarnings(
      rendezvous,
      tempDir("input"),
      tempDir("data"),
    ).filter((warning) => warning.includes("is not empty"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("prior-job");
  });

  test("names are listed in a stable order whatever readdir returns", () => {
    const warnings = contentWarnings(["c.json", "a.json", "b.json"]);
    expect(warnings[0]).toContain("a.json, b.json, c.json");
  });

  test("a long transcript is counted past the naming cap", () => {
    const overflow = 3;
    const entries = Array.from(
      { length: MAX_NAMED_RENDEZVOUS_ENTRIES + overflow },
      (_unused, index) => `m${String(index).padStart(3, "0")}.json`,
    );
    const warnings = contentWarnings(entries);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`and ${overflow} more`);
    expect(warnings[0]).toContain(entries[MAX_NAMED_RENDEZVOUS_ENTRIES - 1]);
    expect(warnings[0]).not.toContain(entries[MAX_NAMED_RENDEZVOUS_ENTRIES]);
  });

  test("a partner-chosen name is escaped before it reaches the console", () => {
    // The partner syncs its own files into this directory, so an entry name is
    // partner-controlled text on its way to a display sink.
    const bellName = `drop${String.fromCharCode(7)}ping.json`;
    const warnings = contentWarnings([bellName]);
    expect(warnings[0]).toContain("drop\\x07ping.json");
    expect(warnings[0]).not.toContain(bellName);
  });

  test("a name that escapes wide cannot run the listing long", () => {
    // Escaping expands: a filename filled to the 255-byte limit with a character
    // that needs an escape renders several times its own length, so the per-name
    // cap -- not the naming cap alone -- is what bounds the listing.
    const wide = String.fromCharCode(0xe9).repeat(127);
    const warnings = contentWarnings([wide]);
    const holdsPrefix = "It holds ";
    const listing = warnings[0].slice(
      warnings[0].indexOf(holdsPrefix) + holdsPrefix.length,
    );
    expect(listing.length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length,
    );
    expect(listing).toContain(DISPLAY_TRUNCATION_MARKER);
  });

  test("an unlistable mount says so rather than reading as empty", () => {
    if (process.getuid?.() === 0) return;
    const rendezvous = tempDir("rendezvous");
    fs.writeFileSync(path.join(rendezvous, "console-hello.json"), "");
    fs.chmodSync(rendezvous, 0o300);
    try {
      const warnings = rendezvousStartupWarnings(
        rendezvous,
        tempDir("input"),
        tempDir("data"),
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
