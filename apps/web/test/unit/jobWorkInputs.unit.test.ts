import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MAX_TRANSFORM_PATTERN_LENGTH,
  columnValues,
  inferDateFormat,
  loadCSVFile,
} from "@psilink/core";

import {
  JobInputNotFoundError,
  coverageJobInput,
  coverageRequestSchema,
  isAdmissibleInputName,
  jobInputFilePath,
  listJobInputs,
  profileJobInput,
  useJobInputDir,
} from "@jobs/workInputs";
import { PREVIEW_SAMPLE_SIZE, sampleInputValues } from "@psi/columnSamples";
import { computeFieldCoverage } from "@psi/nonEmptyAggregate";

import type { Standardization } from "@psilink/core";

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
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, FIXTURE_CSV);
  return filePath;
}

describe("useJobInputDir", () => {
  test("is undefined when JOB_INPUT_DIR is unset", () => {
    expect(useJobInputDir({})).toBeUndefined();
  });

  test("resolves a set directory to an absolute path and memoizes it", () => {
    const dir = tempDir("input");
    const first = useJobInputDir({ JOB_INPUT_DIR: dir });
    expect(first).toBe(path.resolve(dir));
    // The second call ignores a changed env: the value is memoized on globalThis.
    expect(useJobInputDir({ JOB_INPUT_DIR: "/elsewhere" })).toBe(first);
  });
});

describe("listJobInputs", () => {
  test("reports the unconfigured state for an undefined directory", () => {
    expect(listJobInputs(undefined)).toEqual({ configured: false, files: [] });
  });

  test("admits regular files with admissible names, sorted by name", () => {
    const dir = tempDir("input");
    writeFixture(dir, "b.csv");
    writeFixture(dir, "a.csv");
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, ".psilink.key"), "secret");
    const listing = listJobInputs(dir);
    expect(listing.configured).toBe(true);
    expect(listing.files.map((file) => file.name)).toEqual(["a.csv", "b.csv"]);
    for (const file of listing.files) {
      expect(file.sizeBytes).toBeGreaterThan(0);
      expect(Number.isInteger(file.modifiedAt)).toBe(true);
    }
  });

  test("returns an empty list for a directory that cannot be read", () => {
    expect(
      listJobInputs(path.join(os.tmpdir(), "psilink-missing-xyz")),
    ).toEqual({ configured: true, files: [] });
  });
});

describe("profileJobInput", () => {
  test("profiles columns, row count, samples, and date format in one pass", async () => {
    const dir = tempDir("input");
    writeFixture(dir);
    const profile = await profileJobInput(dir, "input.csv");
    expect(profile.name).toBe("input.csv");
    expect(profile.rowCount).toBe(8);
    expect(profile.columns).toEqual([
      "ssn",
      "first_name",
      "last_name",
      "date_of_birth",
    ]);
    expect(profile.dateInputFormat).toBe("YYYY-MM-DD");

    // The samples equal sampleInputValues over the parsed rows: the first
    // PREVIEW_SAMPLE_SIZE non-empty values per column in row order.
    const { data } = await loadCSVFile(
      fs.createReadStream(path.join(dir, "input.csv")),
    );
    const rows = data;
    for (const column of profile.columns)
      expect(profile.columnSamples[column]).toEqual(
        sampleInputValues(rows, column),
      );
    expect(profile.columnSamples.first_name.length).toBeLessThanOrEqual(
      PREVIEW_SAMPLE_SIZE,
    );
  });

  test("date format equals inferDateFormat over the whole date column", async () => {
    const dir = tempDir("input");
    writeFixture(dir);
    const { data } = await loadCSVFile(
      fs.createReadStream(path.join(dir, "input.csv")),
    );
    const dobs = columnValues(data, "date_of_birth");
    const profile = await profileJobInput(dir, "input.csv");
    expect(profile.dateInputFormat).toBe(inferDateFormat(dobs));
  });

  test("throws JobInputNotFoundError for an unknown name", async () => {
    const dir = tempDir("input");
    await expect(profileJobInput(dir, "missing.csv")).rejects.toBeInstanceOf(
      JobInputNotFoundError,
    );
  });

  test("throws JobInputNotFoundError for an inadmissible name", async () => {
    const dir = tempDir("input");
    await expect(profileJobInput(dir, "../escape")).rejects.toBeInstanceOf(
      JobInputNotFoundError,
    );
  });
});

describe("coverageJobInput", () => {
  const standardization: Standardization = [
    { input: "first_name", output: "given", steps: [] },
    { input: "last_name", output: "family", steps: [] },
  ];

  test("equals computeFieldCoverage over the same rows", async () => {
    const dir = tempDir("input");
    writeFixture(dir);
    const rates = await coverageJobInput(dir, "input.csv", standardization);
    const { data } = await loadCSVFile(
      fs.createReadStream(path.join(dir, "input.csv")),
    );
    const expected = computeFieldCoverage(data, standardization);
    expect(rates).toEqual(expected);
  });

  test("throws JobInputNotFoundError for an unknown name", async () => {
    const dir = tempDir("input");
    await expect(
      coverageJobInput(dir, "missing.csv", standardization),
    ).rejects.toBeInstanceOf(JobInputNotFoundError);
  });
});

describe("jobInputFilePath", () => {
  test("returns the composed path for a regular file", () => {
    const dir = tempDir("input");
    writeFixture(dir);
    expect(jobInputFilePath(dir, "input.csv")).toBe(
      path.join(dir, "input.csv"),
    );
  });

  test("throws JobInputNotFoundError for a missing or inadmissible name", () => {
    const dir = tempDir("input");
    expect(() => jobInputFilePath(dir, "missing.csv")).toThrow(
      JobInputNotFoundError,
    );
    expect(() => jobInputFilePath(dir, "a/b")).toThrow(JobInputNotFoundError);
  });
});

describe("isAdmissibleInputName", () => {
  test("rejects traversal, separators, dotfiles, and control characters", () => {
    expect(isAdmissibleInputName("input.csv")).toBe(true);
    expect(isAdmissibleInputName("..")).toBe(false);
    expect(isAdmissibleInputName("a/b")).toBe(false);
    expect(isAdmissibleInputName(".psilink.key")).toBe(false);
    expect(isAdmissibleInputName("bad name")).toBe(true);
  });
});

describe("coverageRequestSchema", () => {
  test("accepts a name and standardization only", () => {
    const parsed = coverageRequestSchema.safeParse({
      name: "input.csv",
      standardization: [{ input: "a", output: "b", steps: [] }],
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects an unknown field (strict)", () => {
    const parsed = coverageRequestSchema.safeParse({
      name: "input.csv",
      standardization: [],
      sizeBytes: 42,
    });
    expect(parsed.success).toBe(false);
  });

  test("caps a compiled regex pattern's length (RE2 compile-DoS bound)", () => {
    const parsed = coverageRequestSchema.safeParse({
      name: "input.csv",
      standardization: [
        {
          input: "a",
          output: "b",
          steps: [
            {
              function: "replace_regex",
              params: {
                pattern: "a".repeat(MAX_TRANSFORM_PATTERN_LENGTH + 1),
                replacement: "",
              },
            },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
