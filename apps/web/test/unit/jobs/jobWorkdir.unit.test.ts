import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  JOB_FILE_MODE,
  WORKDIR_MODE,
  createWorkdir,
  generateJobId,
  isValidJobId,
  jobPathPresent,
  removeWorkdir,
  resolveWorkdir,
  writeJobFile,
} from "@jobs/workdir";

import { tempDataRoot } from "../../utils/jobFixtures";

const created: Array<string> = [];
afterEach(() => {
  for (const dir of created.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("isValidJobId", () => {
  test("accepts a generated v4 UUID", () => {
    expect(isValidJobId(generateJobId())).toBe(true);
  });

  test("rejects traversal payloads and non-UUID shapes", () => {
    expect(isValidJobId("../etc")).toBe(false);
    expect(isValidJobId("..")).toBe(false);
    expect(isValidJobId("/etc/passwd")).toBe(false);
    expect(isValidJobId("")).toBe(false);
    expect(isValidJobId("not-a-uuid")).toBe(false);
    expect(isValidJobId("../../../../root/.ssh")).toBe(false);
  });
});

describe("resolveWorkdir keeps the path under the data root", () => {
  test("resolves a valid id inside the root", () => {
    const root = "/srv/jobs";
    const id = generateJobId();
    const resolved = resolveWorkdir(root, id);
    expect(resolved).toBe(path.join(root, id));
  });

  test("rejects a malformed id (no filesystem escape)", () => {
    expect(resolveWorkdir("/srv/jobs", "../../etc")).toBeNull();
    expect(resolveWorkdir("/srv/jobs", "..")).toBeNull();
    expect(resolveWorkdir("/srv/jobs", "/etc/passwd")).toBeNull();
  });
});

describe("createWorkdir and writeJobFile enforce least-privilege modes", () => {
  test("creates the workdir mode 0o700", async () => {
    const root = tempDataRoot("workdir");
    created.push(root);
    const id = generateJobId();
    const { workdir } = await createWorkdir(root, id);
    expect(fs.statSync(workdir).mode & 0o777).toBe(WORKDIR_MODE);
    expect(workdir).toBe(path.join(root, id));
  });

  test("writes a file mode 0o600 with the given content", async () => {
    const root = tempDataRoot("files");
    created.push(root);
    const id = generateJobId();
    const { workdir } = await createWorkdir(root, id);
    const filePath = await writeJobFile(workdir, ".psilink.key", "secret");
    expect(fs.statSync(filePath).mode & 0o777).toBe(JOB_FILE_MODE);
    expect(fs.readFileSync(filePath, "utf8")).toBe("secret");
  });

  test("removeWorkdir deletes the tree and is idempotent", async () => {
    const root = tempDataRoot("remove");
    created.push(root);
    const id = generateJobId();
    const { workdir } = await createWorkdir(root, id);
    await removeWorkdir(workdir);
    expect(fs.existsSync(workdir)).toBe(false);
    await expect(removeWorkdir(workdir)).resolves.toBeUndefined();
  });
});

describe("jobPathPresent", () => {
  /** Root searches a mode-`000` directory whatever its permissions, so the
   * unsearchable-parent case cannot be staged as that account and the test below
   * skips rather than passing on a directory it could search after all. */
  const runningAsRoot = process.getuid?.() === 0;

  test.skipIf(runningAsRoot)(
    "reads a file under an unsearchable parent as absent",
    () => {
      // The probe fails open: a path whose parent cannot be searched is treated
      // as nothing being there, which for the signing refusal admits the run. The
      // console cannot see into that mount to find anything there either, and the
      // data root it cannot search fails createWorkdir before a run starts.
      const root = tempDataRoot("present-unsearchable");
      created.push(root);
      const parent = path.join(root, "mount");
      fs.mkdirSync(parent, { recursive: true });
      const filePath = path.join(parent, ".psilink-signing-identity.json");
      fs.writeFileSync(filePath, "{}\n");
      fs.chmodSync(parent, 0o000);
      try {
        expect(jobPathPresent(filePath)).toBe(false);
      } finally {
        fs.chmodSync(parent, 0o700);
      }
    },
  );
});
