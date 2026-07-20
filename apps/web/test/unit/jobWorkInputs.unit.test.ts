import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  CSV_LINE_BYTE_CEILING,
  MAX_TRANSFORM_PATTERN_LENGTH,
  columnValues,
  inferDateFormat,
  loadCSVFile,
} from "@psilink/core";

import {
  JobInputCoverageAbortedError,
  JobInputNotFoundError,
  JobInputProfileError,
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
  test("is undefined when both JOB_INPUT_DIR and JOB_DATA_ROOT are unset", () => {
    expect(useJobInputDir({})).toBeUndefined();
  });

  test("resolves a set directory to an absolute path and memoizes it", () => {
    const dir = tempDir("input");
    const first = useJobInputDir({ JOB_INPUT_DIR: dir });
    expect(first).toBe(path.resolve(dir));
    // The second call ignores a changed env: the value is memoized on globalThis.
    expect(useJobInputDir({ JOB_INPUT_DIR: "/elsewhere" })).toBe(first);
  });

  test("defaults to JOB_DATA_ROOT when JOB_INPUT_DIR is unset", () => {
    const dataRoot = tempDir("data");
    expect(useJobInputDir({ JOB_DATA_ROOT: dataRoot })).toBe(
      path.resolve(dataRoot),
    );
  });

  test("an explicit JOB_INPUT_DIR overrides the data-root fallback", () => {
    const inputDir = tempDir("input");
    const dataRoot = tempDir("data");
    expect(
      useJobInputDir({ JOB_INPUT_DIR: inputDir, JOB_DATA_ROOT: dataRoot }),
    ).toBe(path.resolve(inputDir));
  });
});

describe("listJobInputs", () => {
  test("reports the unconfigured state for an undefined directory", () => {
    expect(listJobInputs(undefined)).toEqual({
      configured: false,
      readable: true,
      files: [],
    });
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

  test("reports the unreadable state for a directory that cannot be read", () => {
    // A configured-but-unreadable mount is distinct from an empty one: readable is
    // false, so the operator is told to check the mount rather than to place a file.
    expect(
      listJobInputs(path.join(os.tmpdir(), "psilink-missing-xyz")),
    ).toEqual({ configured: true, readable: false, files: [] });
  });

  test("reports readable for an empty but present directory", () => {
    const dir = tempDir("input");
    expect(listJobInputs(dir)).toEqual({
      configured: true,
      readable: true,
      files: [],
    });
  });

  test("lists a symlink to a regular file (statSync follows the link)", () => {
    // The listing stats through symlinks, so an operator who symlinks a PII CSV into
    // the mounted directory rather than copying it sees the linked file listed. This
    // is the deliberate design: no lstat exclusion enforces a confinement the mount
    // model disclaims.
    const dir = tempDir("input");
    const target = tempDir("target");
    const realFile = path.join(target, "real.csv");
    fs.writeFileSync(realFile, FIXTURE_CSV);
    fs.symlinkSync(realFile, path.join(dir, "linked.csv"));
    const listing = listJobInputs(dir);
    expect(listing.files.map((file) => file.name)).toEqual(["linked.csv"]);
    expect(listing.files[0].sizeBytes).toBeGreaterThan(0);
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

    // The samples ride the wire as an ordered array of {column, values} pairs, one
    // per column in the profile's column order, each equal to sampleInputValues over
    // the parsed rows: the first PREVIEW_SAMPLE_SIZE non-empty values in row order.
    const { data } = await loadCSVFile(
      fs.createReadStream(path.join(dir, "input.csv")),
    );
    const rows = data;
    expect(profile.columnSamples.map((sample) => sample.column)).toEqual(
      profile.columns,
    );
    for (const { column, values } of profile.columnSamples)
      expect(values).toEqual(sampleInputValues(rows, column));
    const firstName = profile.columnSamples.find(
      (sample) => sample.column === "first_name",
    );
    expect(firstName?.values.length).toBeLessThanOrEqual(PREVIEW_SAMPLE_SIZE);
  });

  test("prototype-member column names are ordinary sample data", async () => {
    // A column literally named __proto__/constructor/prototype must ride the profile
    // as plain data, never a key that drives a prototype setter or resolves to an
    // inherited member. The samples are an array of pairs, so every such column is
    // present with its own values and none pollutes the profile.
    const dir = tempDir("input");
    const csv = [
      "__proto__,constructor,prototype",
      "polluted,ctor,proto",
      "second,ctor2,proto2",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "proto.csv"), csv);
    const profile = await profileJobInput(dir, "proto.csv");
    expect(profile.columns).toEqual(["__proto__", "constructor", "prototype"]);
    expect(profile.columnSamples.map((sample) => sample.column)).toEqual([
      "__proto__",
      "constructor",
      "prototype",
    ]);
    const byColumn = (name: string) =>
      profile.columnSamples.find((sample) => sample.column === name)?.values;
    // constructor/prototype carry ordinary own-property values; __proto__ is a
    // prototype accessor the CSV parser cannot represent as a cell, so it profiles as
    // an empty (but present) sample rather than being dropped or crashing.
    expect(Array.isArray(byColumn("__proto__"))).toBe(true);
    expect(byColumn("constructor")).toEqual(["ctor", "ctor2"]);
    expect(byColumn("prototype")).toEqual(["proto", "proto2"]);
    // No prototype pollution: a fresh object is unaffected.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
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

  test("classifies an empty file as not_a_csv", async () => {
    const dir = tempDir("input");
    fs.writeFileSync(path.join(dir, "empty.csv"), "");
    await expect(profileJobInput(dir, "empty.csv")).rejects.toMatchObject({
      code: "not_a_csv",
    });
  });

  test("classifies a single-line ceiling trip as too_large", async () => {
    // A header line with no terminator past the CSV single-line byte ceiling trips
    // the core guard, which the profile pass maps to the too_large code.
    const dir = tempDir("input");
    fs.writeFileSync(
      path.join(dir, "huge.csv"),
      "a".repeat(CSV_LINE_BYTE_CEILING + 8),
    );
    await expect(profileJobInput(dir, "huge.csv")).rejects.toMatchObject({
      code: "too_large",
    });
  });

  test("classifies a mid-read fault as parse_failed without leaking the error", async () => {
    // Simulate a read fault whose message embeds the mounted path and cell bytes; the
    // classified error must carry only the code, never that message.
    const dir = tempDir("input");
    writeFixture(dir);
    const stream = new Readable({ read() {} });
    vi.spyOn(fs, "createReadStream").mockReturnValue(
      stream as unknown as fs.ReadStream,
    );
    const promise = profileJobInput(dir, "input.csv");
    // Let the parser attach its stream listeners before the read faults, so the error
    // flows through the parser rather than surfacing as an uncaught 'error'.
    await new Promise((resolve) => setImmediate(resolve));
    const leak = `${dir}/input.csv: EIO 111223333`;
    stream.destroy(new Error(leak));
    const error = await promise.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JobInputProfileError);
    expect((error as JobInputProfileError).code).toBe("parse_failed");
    expect((error as JobInputProfileError).message).not.toContain(dir);
    expect((error as JobInputProfileError).message).not.toContain("111223333");
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

  test("aborts before reading when the signal is already aborted", async () => {
    const dir = tempDir("input");
    writeFixture(dir);
    const controller = new AbortController();
    controller.abort();
    await expect(
      coverageJobInput(dir, "input.csv", standardization, controller.signal),
    ).rejects.toBeInstanceOf(JobInputCoverageAbortedError);
  });

  test("stops the pass when the signal aborts, rejecting with the aborted error", async () => {
    // The abort listener is registered synchronously before the stream is read, so an
    // abort issued right after the call destroys the stream before it scans the file.
    const dir = tempDir("input");
    writeFixture(dir);
    const controller = new AbortController();
    const promise = coverageJobInput(
      dir,
      "input.csv",
      standardization,
      controller.signal,
    );
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(JobInputCoverageAbortedError);
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
