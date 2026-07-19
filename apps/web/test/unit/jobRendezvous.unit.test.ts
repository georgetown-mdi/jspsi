import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { rendezvousStartupWarnings } from "@jobs/jobRendezvous";

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

  test("does not warn for non-overlapping sibling directories", () => {
    const rendezvous = tempDir("rendezvous");
    const jobInput = tempDir("input");
    const dataRoot = tempDir("data");
    expect(rendezvousStartupWarnings(rendezvous, jobInput, dataRoot)).toEqual(
      [],
    );
  });
});
