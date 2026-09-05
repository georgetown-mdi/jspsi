import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  MOUNT_CHECK_IDS,
  nodeMountFs,
  runMountChecks,
} from "../../../src/doctor/mount";
import type { MountFs } from "../../../src/doctor/mount";
import { overallOf } from "../../../src/doctor/verdict";
import type { DoctorReport } from "../../../src/doctor/verdict";

const MARKER = "psilink-check.txt";
const TOKEN = "abc123";
const INPUT = { marker: MARKER, token: TOKEN };

const created: string[] = [];

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-mount-"));
  created.push(directory);
  return directory;
}

afterEach(() => {
  while (created.length > 0)
    fs.rmSync(created.pop() as string, { recursive: true, force: true });
});

function checkById(report: DoctorReport, id: string) {
  const check = report.checks.find((entry) => entry.id === id);
  if (check === undefined) throw new Error(`no check ${id} in the report`);
  return check;
}

describe("a mounted folder that behaves the way psilink needs", () => {
  test("reports every check ok, in the fixed order", () => {
    const directory = tempDirectory();
    fs.writeFileSync(path.join(directory, MARKER), `${TOKEN}\n`);
    const report = runMountChecks(directory, INPUT);
    expect(report.checks.map((check) => check.id)).toEqual([
      ...MOUNT_CHECK_IDS,
    ]);
    expect(overallOf(report)).toBe("ok");
    for (const check of report.checks) expect(check.status).toBe("ok");
  });

  test("leaves nothing of its own behind, and consumes the marker", () => {
    const directory = tempDirectory();
    fs.writeFileSync(path.join(directory, MARKER), `${TOKEN}\n`);
    runMountChecks(directory, INPUT);
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});

describe("the marker cross-check", () => {
  test("a missing marker means the mount and the probe are different folders", () => {
    const report = runMountChecks(tempDirectory(), INPUT);
    const check = checkById(report, "marker");
    expect(check.status).toBe("fail");
    expect(check.meaning).toContain("different directories");
    expect(check.action).toContain("DFS");
    expect(overallOf(report)).toBe("fix_and_retry");
  });

  test("a marker from another run is a warning, not a failure", () => {
    const directory = tempDirectory();
    fs.writeFileSync(path.join(directory, MARKER), "someone-else\n");
    const report = runMountChecks(directory, INPUT);
    const check = checkById(report, "marker");
    expect(check.status).toBe("warn");
    expect(check.action).toContain(MARKER);
    expect(overallOf(report)).toBe("ok");
    // Another operator may be relying on it right now, so it stays.
    expect(fs.existsSync(path.join(directory, MARKER))).toBe(true);
  });

  test("without a marker and token the cross-check is skipped, not assumed", () => {
    const report = runMountChecks(tempDirectory(), {
      marker: "",
      token: "",
    });
    expect(checkById(report, "marker").status).toBe("skipped");
    expect(overallOf(report)).toBe("ok");
  });

  test("the write checks still run when the marker is absent", () => {
    const report = runMountChecks(tempDirectory(), INPUT);
    expect(checkById(report, "write_rename").status).toBe("ok");
    expect(checkById(report, "exclusive_create").status).toBe("ok");
  });
});

describe("a folder that is not there", () => {
  test("is fatal rather than a verdict about the share", () => {
    const report = runMountChecks(
      path.join(tempDirectory(), "not-mounted"),
      INPUT,
    );
    const check = checkById(report, "mount_readable");
    expect(check.status).toBe("fail");
    expect(check.meaning).toContain("Nothing about the share itself");
    expect(overallOf(report)).toBe("fatal");
    expect(checkById(report, "write_rename").status).toBe("skipped");
    expect(report.checks.map((entry) => entry.id)).toEqual([
      ...MOUNT_CHECK_IDS,
    ]);
  });
});

describe("shares whose semantics differ from a local disk", () => {
  test("one that does not refuse a second exclusive create asks for --lockless-rendezvous", () => {
    // O_EXCL is exactly what psilink's rendezvous uses to decide which side goes
    // first, so a share that honours it only weakly is the case this catches.
    const permissive: MountFs = {
      ...nodeMountFs,
      createExclusive: (file) => fs.writeFileSync(file, ""),
    };
    const directory = tempDirectory();
    fs.writeFileSync(path.join(directory, MARKER), `${TOKEN}\n`);
    const report = runMountChecks(directory, INPUT, permissive);
    const check = checkById(report, "exclusive_create");
    expect(check.status).toBe("warn");
    expect(check.action).toContain("--lockless-rendezvous");
    expect(overallOf(report)).toBe("ok");
  });

  test("one that cannot create exclusively at all reports the check untested", () => {
    const refusing: MountFs = {
      ...nodeMountFs,
      createExclusive: () => {
        throw Object.assign(new Error("nope"), { code: "EPERM" });
      },
    };
    const report = runMountChecks(tempDirectory(), INPUT, refusing);
    const check = checkById(report, "exclusive_create");
    expect(check.status).toBe("skipped");
    expect(check.action).toContain("--lockless-rendezvous");
  });

  test("one that will not rename onto an existing file asks for the same flag", () => {
    const noClobber: MountFs = {
      ...nodeMountFs,
      rename: (from, to) => {
        if (fs.existsSync(to))
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        fs.renameSync(from, to);
      },
    };
    const directory = tempDirectory();
    fs.writeFileSync(path.join(directory, MARKER), `${TOKEN}\n`);
    const report = runMountChecks(directory, INPUT, noClobber);
    const check = checkById(report, "rename_onto_existing");
    expect(check.status).toBe("warn");
    expect(check.action).toContain("--lockless-rendezvous");
    // The plain write-then-rename still passed, so the folder is usable.
    expect(checkById(report, "write_rename").status).toBe("ok");
    expect(overallOf(report)).toBe("ok");
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  test("one that mounts but refuses a write reports that, not a mount failure", () => {
    const readOnly: MountFs = {
      ...nodeMountFs,
      writeFile: () => {
        throw Object.assign(new Error("read-only"), { code: "EACCES" });
      },
    };
    const directory = tempDirectory();
    fs.writeFileSync(path.join(directory, MARKER), `${TOKEN}\n`);
    const report = runMountChecks(directory, INPUT, readOnly);
    expect(checkById(report, "mount_readable").status).toBe("ok");
    expect(checkById(report, "marker").status).toBe("ok");
    const check = checkById(report, "write_rename");
    expect(check.status).toBe("fail");
    expect(check.summary).toContain("EACCES");
    expect(overallOf(report)).toBe("fix_and_retry");
  });
});

describe("the real filesystem implementation", () => {
  test("createExclusive refuses a second create", () => {
    const file = path.join(tempDirectory(), "x");
    nodeMountFs.createExclusive(file);
    expect(() => nodeMountFs.createExclusive(file)).toThrow();
  });

  test("remove tolerates a file that is not there", () => {
    expect(() =>
      nodeMountFs.remove(path.join(tempDirectory(), "absent")),
    ).not.toThrow();
  });
});

describe("working names occupied by directories", () => {
  test.each([".psilink-w.tmp", ".psilink-w2.tmp"])(
    "a directory named %s blocks write_rename with a verdict, not a throw",
    (name) => {
      const directory = tempDirectory();
      fs.writeFileSync(path.join(directory, MARKER), `${TOKEN}\n`);
      fs.mkdirSync(path.join(directory, name));
      const report = runMountChecks(directory, INPUT);
      const check = checkById(report, "write_rename");
      expect(check.status).toBe("fail");
      expect(check.action).toContain(name);
      expect(report.checks.map((entry) => entry.id)).toEqual([
        ...MOUNT_CHECK_IDS,
      ]);
      expect(overallOf(report)).toBe("fix_and_retry");
    },
  );

  test.each([
    [".psilink-x.tmp", "exclusive_create"],
    [".psilink-a.tmp", "rename_onto_existing"],
    [".psilink-b.tmp", "rename_onto_existing"],
  ])("a directory named %s blocks only %s", (name, id) => {
    const directory = tempDirectory();
    fs.writeFileSync(path.join(directory, MARKER), `${TOKEN}\n`);
    fs.mkdirSync(path.join(directory, name));
    const report = runMountChecks(directory, INPUT);
    const check = checkById(report, id);
    expect(check.status).toBe("fail");
    expect(check.action).toContain(name);
    expect(checkById(report, "write_rename").status).toBe("ok");
    expect(report.checks.map((entry) => entry.id)).toEqual([
      ...MOUNT_CHECK_IDS,
    ]);
  });
});

describe("a matching marker that cannot be removed", () => {
  test("is a warning with a full verdict, not a crash", () => {
    const directory = tempDirectory();
    fs.writeFileSync(path.join(directory, MARKER), `${TOKEN}\n`);
    const refusesMarkerDelete: MountFs = {
      ...nodeMountFs,
      remove: (file) => {
        if (path.basename(file) === MARKER) throw new Error("EACCES");
        nodeMountFs.remove(file);
      },
    };
    const report = runMountChecks(directory, INPUT, refusesMarkerDelete);
    const check = checkById(report, "marker");
    expect(check.status).toBe("warn");
    expect(check.action).toContain(MARKER);
    expect(report.checks.map((entry) => entry.id)).toEqual([
      ...MOUNT_CHECK_IDS,
    ]);
    expect(fs.existsSync(path.join(directory, MARKER))).toBe(true);
  });
});

describe("every skipped record explains itself", () => {
  test("padded and inapplicable skips all have a meaning", () => {
    const reports = [
      runMountChecks(path.join(os.tmpdir(), "psilink-no-such-dir"), INPUT),
      runMountChecks(tempDirectory(), { marker: "", token: "" }),
    ];
    let skips = 0;
    for (const report of reports)
      for (const check of report.checks)
        if (check.status === "skipped") {
          skips += 1;
          expect(check.meaning).toBeDefined();
        }
    expect(skips).toBeGreaterThan(0);
  });
});

describe("the marker token must match exactly", () => {
  test("a stale token that merely contains this run's is another run's marker", () => {
    const directory = tempDirectory();
    fs.writeFileSync(path.join(directory, MARKER), `kernel${TOKEN}\n`);
    const report = runMountChecks(directory, INPUT);
    expect(checkById(report, "marker").status).toBe("warn");
    expect(fs.existsSync(path.join(directory, MARKER))).toBe(true);
  });
});
