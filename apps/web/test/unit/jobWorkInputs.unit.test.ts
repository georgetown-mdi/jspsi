import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { columnValues, inferDateFormat, loadCSVFile } from "@psilink/core";

import {
  JobInputDriftError,
  JobInputParseBusyError,
  JobInputParseGate,
  MAX_INPUT_LISTING_ENTRIES,
  UnknownJobInputError,
  coverageJobInput,
  isAdmissibleInputName,
  listJobInputs,
  loadJobInputDirFromEnv,
  logJobInputDirBoot,
  profileJobInput,
  useJobInputDir,
} from "@jobs/workInputs";
import { PREVIEW_SAMPLE_SIZE, sampleInputValues } from "@psi/previewSamples";
import { JobApiConfigError } from "@jobs/gate";
import { computeFieldCoverage } from "@psi/nonEmptyAggregate";

import type { CSVRow, Standardization } from "@psilink/core";

const dirs: Array<string> = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `psilink-${label}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  (globalThis as { jobInputDirConfig?: unknown }).jobInputDirConfig = undefined;
  (globalThis as { jobInputParseGate?: unknown }).jobInputParseGate = undefined;
});

// A CSV with blanks interspersed so the first-5-non-empty sample differs from the
// first five rows -- exercising the sampleInputValues semantics, not a row slice.
const FIXTURE_CSV = [
  "ssn,first_name,last_name,date_of_birth",
  "111223333,Jane,Public,1990-01-02",
  "222334444,John,,1985-11-30",
  "333445555,Amy,Adams,2000-05-14",
  "444556666,,Baker,1972-03-08",
  "555667777,Cara,Cole,1995-07-21",
  "666778888,Dan,Diaz,1980-12-01",
  "777889999,Eve,East,1969-09-09",
  "888990000,Fay,Frost,2001-02-28",
].join("\n");

function writeFixture(dir: string, name = "input.csv"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${FIXTURE_CSV}\n`);
  return name;
}

async function fullRows(dir: string, name: string): Promise<Array<CSVRow>> {
  const parsed = await loadCSVFile(fs.createReadStream(path.join(dir, name)));
  return parsed.data;
}

describe("isAdmissibleInputName", () => {
  test("admits ordinary single-segment names", () => {
    for (const name of ["input.csv", "a", "A_b-1.CSV", "data 2026.csv"])
      expect(isAdmissibleInputName(name)).toBe(true);
  });

  test("rejects traversal, dotfiles, non-segments, and control characters", () => {
    for (const name of [
      "",
      ".",
      "..",
      ".hidden",
      ".psilink.key",
      "a/b",
      "a\\b",
      "a\u0000b",
      "a\tb",
      "a\nb",
      "a\u007fb",
      "x".repeat(256),
    ])
      expect(isAdmissibleInputName(name)).toBe(false);
  });
});

describe("listJobInputs admission", () => {
  test("unset directory is configured:false with an empty list", () => {
    expect(listJobInputs(undefined)).toEqual({
      configured: false,
      totalEntries: 0,
      truncated: false,
      files: [],
    });
  });

  test("admits regular files and skips directories, dotfiles, and symlinks", () => {
    const dir = tempDir("listing");
    fs.writeFileSync(path.join(dir, "a.csv"), "x\n1\n");
    fs.writeFileSync(path.join(dir, "b.csv"), "x\n1\n2\n");
    fs.writeFileSync(path.join(dir, ".hidden.csv"), "secret\n");
    fs.mkdirSync(path.join(dir, "subdir"));
    // A symlink pointing at a secret OUTSIDE the directory must never be listed.
    const secret = tempDir("secret");
    fs.writeFileSync(path.join(secret, "creds"), "TOP SECRET\n");
    fs.symlinkSync(path.join(secret, "creds"), path.join(dir, "link.csv"));

    const listing = listJobInputs(dir);
    expect(listing.configured).toBe(true);
    // Five raw readdir entries (2 files, 1 dotfile, 1 subdir, 1 symlink);
    // only the two regular non-dot files are admitted.
    expect(listing.totalEntries).toBe(5);
    expect(listing.files.map((f) => f.name)).toEqual(["a.csv", "b.csv"]);
    expect(listing.truncated).toBe(false);
  });

  test("totalEntries distinguishes an all-inadmissible directory from an empty one", () => {
    const empty = tempDir("empty");
    expect(listJobInputs(empty)).toMatchObject({
      configured: true,
      totalEntries: 0,
      files: [],
    });

    const inadmissible = tempDir("inadmissible");
    fs.mkdirSync(path.join(inadmissible, "sub"));
    fs.writeFileSync(path.join(inadmissible, ".dot"), "x\n");
    const listing = listJobInputs(inadmissible);
    expect(listing.totalEntries).toBe(2);
    expect(listing.files).toEqual([]);
  });

  test("size and mtime are reported as integer epoch milliseconds", () => {
    const dir = tempDir("meta");
    const name = writeFixture(dir);
    const stat = fs.statSync(path.join(dir, name));
    const entry = listJobInputs(dir).files[0];
    expect(entry.sizeBytes).toBe(stat.size);
    expect(entry.modifiedAt).toBe(Math.trunc(stat.mtimeMs));
    expect(Number.isInteger(entry.modifiedAt)).toBe(true);
  });

  test("admitted names are sorted and truncated deterministically at the cap", () => {
    const dir = tempDir("truncate");
    const count = MAX_INPUT_LISTING_ENTRIES + 88;
    // Zero-padded names so lexicographic order equals numeric order.
    for (let i = 0; i < count; i++)
      fs.writeFileSync(
        path.join(dir, `file${String(i).padStart(4, "0")}.csv`),
        "x\n1\n",
      );
    const listing = listJobInputs(dir);
    expect(listing.totalEntries).toBe(count);
    expect(listing.truncated).toBe(true);
    expect(listing.files).toHaveLength(MAX_INPUT_LISTING_ENTRIES);
    expect(listing.files[0].name).toBe("file0000.csv");
    expect(listing.files[MAX_INPUT_LISTING_ENTRIES - 1].name).toBe(
      `file${String(MAX_INPUT_LISTING_ENTRIES - 1).padStart(4, "0")}.csv`,
    );
    const names = listing.files.map((f) => f.name);
    expect(names).toEqual([...names].sort());
  });
});

describe("profileJobInput", () => {
  test("computes columns, rowCount, dateInputFormat, and samples in one pass", async () => {
    const dir = tempDir("profile");
    const name = writeFixture(dir);
    const rows = await fullRows(dir, name);
    const profile = await profileJobInput(dir, name);

    expect(profile.name).toBe(name);
    expect(profile.columns).toEqual([
      "ssn",
      "first_name",
      "last_name",
      "date_of_birth",
    ]);
    expect(profile.rowCount).toBe(rows.length);

    // dateInputFormat equals inferDateFormat over the FULL date column.
    expect(profile.dateInputFormat).toBe("YYYY-MM-DD");
    expect(profile.dateInputFormat).toBe(
      inferDateFormat(columnValues(rows, "date_of_birth")),
    );

    // columnSamples equals sampleInputValues (first N non-empty, row order) over
    // the full rows -- proving the blank-skipping semantics, not a row slice.
    for (const column of profile.columns)
      expect(profile.columnSamples[column]).toEqual(
        sampleInputValues(rows, column, PREVIEW_SAMPLE_SIZE),
      );
    // The blank last_name rows are skipped, so its sample is not a row prefix.
    expect(profile.columnSamples.last_name).toEqual([
      "Public",
      "Adams",
      "Baker",
      "Cole",
      "Diaz",
    ]);
  });

  test("a file with no date column yields no dateInputFormat", async () => {
    const dir = tempDir("nodate");
    fs.writeFileSync(path.join(dir, "in.csv"), "a,b\n1,2\n3,4\n");
    const profile = await profileJobInput(dir, "in.csv");
    expect(profile.dateInputFormat).toBeUndefined();
    expect(profile.rowCount).toBe(2);
  });

  test("an unknown name is an UnknownJobInputError", async () => {
    const dir = tempDir("unknown");
    writeFixture(dir);
    await expect(profileJobInput(dir, "absent.csv")).rejects.toBeInstanceOf(
      UnknownJobInputError,
    );
  });

  test("a symlinked entry is never resolvable by name", async () => {
    const dir = tempDir("symlink-open");
    const secret = tempDir("symlink-secret");
    fs.writeFileSync(path.join(secret, "creds"), "ssn\n999\n");
    fs.symlinkSync(path.join(secret, "creds"), path.join(dir, "link.csv"));
    await expect(profileJobInput(dir, "link.csv")).rejects.toBeInstanceOf(
      UnknownJobInputError,
    );
  });

  test("a dev/ino mismatch at open time is refused (swap detection)", async () => {
    const dir = tempDir("devino");
    const name = writeFixture(dir);
    const realFstat = fs.fstatSync;
    // Simulate the file being swapped for a different inode between the admission
    // lstat and the open-time fstat: the (dev, ino) recheck must reject it.
    vi.spyOn(fs, "fstatSync").mockImplementationOnce((fd: number) => {
      const real = realFstat(fd);
      return { ...real, ino: real.ino + 1 };
    });
    await expect(profileJobInput(dir, name)).rejects.toBeInstanceOf(
      UnknownJobInputError,
    );
  });

  test("a symlink swapped in between admission and open is UnknownJobInputError, no fd leak", async () => {
    const dir = tempDir("open-race");
    const name = writeFixture(dir);
    const secret = tempDir("open-race-secret");
    fs.writeFileSync(path.join(secret, "creds"), "ssn\n999\n");

    const realOpen = fs.openSync;
    const closeSpy = vi.spyOn(fs, "closeSync");
    // The genuine race O_NOFOLLOW exists to close: after the admission lstat has
    // accepted the regular file, swap it for a symlink, then let the REAL open run
    // -- O_NOFOLLOW makes it throw a genuine ELOOP, which must map to
    // UnknownJobInputError (the 404 posture) rather than escape as a generic error.
    vi.spyOn(fs, "openSync").mockImplementationOnce(((
      filePath: fs.PathLike,
      flags: number,
    ) => {
      fs.rmSync(path.join(dir, name));
      fs.symlinkSync(path.join(secret, "creds"), path.join(dir, name));
      return realOpen(filePath, flags);
    }) as typeof fs.openSync);

    await expect(profileJobInput(dir, name)).rejects.toBeInstanceOf(
      UnknownJobInputError,
    );
    // The open threw before any descriptor existed, so nothing is closed: no leak.
    expect(closeSpy).not.toHaveBeenCalled();
  });
});

describe("coverageJobInput", () => {
  const standardization: Standardization = [
    {
      output: "last_name",
      input: "last_name",
      steps: [{ function: "to_upper_case" }],
    },
    {
      output: "birth_date",
      input: "date_of_birth",
      steps: [
        { function: "parse_date", params: { inputFormat: "YYYY-MM-DD" } },
      ],
    },
  ];

  test("streaming coverage equals computeFieldCoverage over the same fixture", async () => {
    const dir = tempDir("coverage");
    const name = writeFixture(dir);
    const rows = await fullRows(dir, name);
    const profile = await profileJobInput(dir, name);

    const streamed = await coverageJobInput(
      dir,
      name,
      profile.sizeBytes,
      profile.modifiedAt,
      standardization,
    );
    expect(streamed).toEqual(computeFieldCoverage(rows, standardization));
    // The batch and streaming drivers agree on the participating count too.
    expect(streamed[0].total).toBe(rows.length);
  });

  test("a drifted (size, mtime) pair is refused", async () => {
    const dir = tempDir("drift");
    const name = writeFixture(dir);
    const profile = await profileJobInput(dir, name);
    await expect(
      coverageJobInput(
        dir,
        name,
        profile.sizeBytes + 1,
        profile.modifiedAt,
        standardization,
      ),
    ).rejects.toBeInstanceOf(JobInputDriftError);
    await expect(
      coverageJobInput(
        dir,
        name,
        profile.sizeBytes,
        profile.modifiedAt + 1000,
        standardization,
      ),
    ).rejects.toBeInstanceOf(JobInputDriftError);
  });
});

describe("JobInputParseGate", () => {
  test("runs one at a time, queues one, and refuses a third", async () => {
    const gate = new JobInputParseGate();
    let releaseA!: () => void;
    const a = gate.run(
      () =>
        new Promise<string>((resolve) => {
          releaseA = () => resolve("a");
        }),
    );
    const b = gate.run(() => Promise.resolve("b"));
    await expect(gate.run(() => Promise.resolve("c"))).rejects.toBeInstanceOf(
      JobInputParseBusyError,
    );
    releaseA();
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    // The gate is free again once both settle.
    expect(await gate.run(() => Promise.resolve("d"))).toBe("d");
  });
});

describe("loadJobInputDirFromEnv startup checks", () => {
  test("unset returns undefined (feature off)", () => {
    expect(loadJobInputDirFromEnv({})).toBeUndefined();
  });

  test("set without a data root refuses", () => {
    const dir = tempDir("nodataroot");
    expect(() => loadJobInputDirFromEnv({ JOB_INPUT_DIR: dir })).toThrow(
      JobApiConfigError,
    );
  });

  test("a nonexistent directory refuses", () => {
    const root = tempDir("root");
    expect(() =>
      loadJobInputDirFromEnv({
        JOB_INPUT_DIR: path.join(root, "missing"),
        JOB_DATA_ROOT: path.join(root, "data"),
      }),
    ).toThrow(JobApiConfigError);
  });

  test("a path that is a file, not a directory, refuses", () => {
    const dir = tempDir("filenotdir");
    const file = path.join(dir, "f.csv");
    fs.writeFileSync(file, "x\n");
    expect(() =>
      loadJobInputDirFromEnv({
        JOB_INPUT_DIR: file,
        JOB_DATA_ROOT: path.join(dir, "data"),
      }),
    ).toThrow(JobApiConfigError);
  });

  test("mutual containment with the data root refuses both directions", () => {
    const base = tempDir("containment");
    const inputInside = path.join(base, "inputs");
    const dataOutside = path.join(base, "data");
    fs.mkdirSync(inputInside);
    fs.mkdirSync(dataOutside);
    // input dir contained by data root
    expect(() =>
      loadJobInputDirFromEnv({
        JOB_INPUT_DIR: inputInside,
        JOB_DATA_ROOT: base,
      }),
    ).toThrow(JobApiConfigError);
    // data root contained by input dir
    expect(() =>
      loadJobInputDirFromEnv({
        JOB_INPUT_DIR: base,
        JOB_DATA_ROOT: dataOutside,
      }),
    ).toThrow(JobApiConfigError);
    // equal
    expect(() =>
      loadJobInputDirFromEnv({ JOB_INPUT_DIR: base, JOB_DATA_ROOT: base }),
    ).toThrow(JobApiConfigError);
  });

  test("a valid disjoint directory resolves to its realpath", () => {
    const base = tempDir("disjoint");
    const input = path.join(base, "inputs");
    const data = path.join(base, "data");
    fs.mkdirSync(input);
    fs.mkdirSync(data);
    const resolved = loadJobInputDirFromEnv({
      JOB_INPUT_DIR: input,
      JOB_DATA_ROOT: data,
    });
    expect(resolved).toBe(fs.realpathSync(input));
  });
});

describe("useJobInputDir and boot log", () => {
  test("memoizes the resolved directory across calls", () => {
    const base = tempDir("memo");
    const input = path.join(base, "inputs");
    const data = path.join(base, "data");
    fs.mkdirSync(input);
    fs.mkdirSync(data);
    vi.stubEnv("JOB_INPUT_DIR", input);
    vi.stubEnv("JOB_DATA_ROOT", data);
    const first = useJobInputDir();
    expect(first).toBe(fs.realpathSync(input));
    // A later env change is not re-read: the directory is boot-resolved once.
    vi.stubEnv("JOB_INPUT_DIR", "");
    expect(useJobInputDir()).toBe(first);
  });

  test("the boot log line names the realpath and the readdir/admissible counts", () => {
    const dir = tempDir("bootlog");
    writeFixture(dir);
    fs.mkdirSync(path.join(dir, "sub"));
    const info = vi.fn();
    logJobInputDirBoot(dir, {
      info,
    } as unknown as Parameters<typeof logJobInputDirBoot>[1]);
    expect(info).toHaveBeenCalledTimes(1);
    const line = info.mock.calls[0][0] as string;
    expect(line).toContain(fs.realpathSync(dir));
    expect(line).toContain("2 readdir entries");
    expect(line).toContain("1 admissible");
  });
});
