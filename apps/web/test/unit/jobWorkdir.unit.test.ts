import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  JOB_FILE_MODE,
  WORKDIR_MODE,
  createWorkdir,
  generateJobId,
  isValidJobId,
  removeWorkdir,
  resolveWorkdir,
  writeJobFile,
} from "@jobs/workdir";

import { tempDataRoot } from "../utils/jobFixtures";

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
  test("creates the workdir and exchange subdir mode 0o700", async () => {
    const root = tempDataRoot("workdir");
    created.push(root);
    const id = generateJobId();
    const { workdir, exchangeDirectory } = await createWorkdir(
      root,
      id,
      "exchange",
    );
    expect(fs.statSync(workdir).mode & 0o777).toBe(WORKDIR_MODE);
    expect(fs.statSync(exchangeDirectory).mode & 0o777).toBe(WORKDIR_MODE);
    expect(exchangeDirectory).toBe(path.join(workdir, "exchange"));
  });

  test("writes a file mode 0o600 with the given content", async () => {
    const root = tempDataRoot("files");
    created.push(root);
    const id = generateJobId();
    const { workdir } = await createWorkdir(root, id, "exchange");
    const filePath = await writeJobFile(workdir, ".psilink.key", "secret");
    expect(fs.statSync(filePath).mode & 0o777).toBe(JOB_FILE_MODE);
    expect(fs.readFileSync(filePath, "utf8")).toBe("secret");
  });

  test("removeWorkdir deletes the tree and is idempotent", async () => {
    const root = tempDataRoot("remove");
    created.push(root);
    const id = generateJobId();
    const { workdir } = await createWorkdir(root, id, "exchange");
    await removeWorkdir(workdir);
    expect(fs.existsSync(workdir)).toBe(false);
    await expect(removeWorkdir(workdir)).resolves.toBeUndefined();
  });
});
