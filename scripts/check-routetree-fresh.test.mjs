import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROBE,
  REGENERATE_COMMAND,
  ROUTE_TREE,
  checkRouteTreeFreshness,
} from "./check-routetree-fresh.mjs";
import { CHECKS } from "./run-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// Nothing here drives the REAL codegen, deliberately. That invocation pegs every
// core for ~8s, and from inside this suite it runs beside the repo-wide egress
// scan in a parallel worker: on a two-core CI runner it starved the scan's
// comment-strip pass past its timeout (measured, run 30683166508). The real run
// has its own home -- the `Route tree freshness` step in static_checks.yaml,
// which is `npm run check:routetree` over the committed tree on every pull
// request. An invocation that stops regenerating reddens that step, since the
// check fails closed on a surviving probe line; the logic around it is what is
// left for this file, driven through an injected codegen.
const GENERATED = "// generated\nexport const routeTree = 1\n";

describe("freshness against an injected codegen", () => {
  let root;
  let file;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "routetree-fresh-test-"));
    file = join(root, ROUTE_TREE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, GENERATED);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes when the generator reproduces the checked-in copy", () => {
    const result = checkRouteTreeFreshness({
      root,
      regenerate: () => writeFileSync(file, GENERATED),
    });
    expect(result).toMatchObject({ ok: true, status: "fresh" });
    expect(readFileSync(file, "utf8")).toBe(GENERATED);
  });

  it("fails on a stale copy and puts the working-tree bytes back", () => {
    const result = checkRouteTreeFreshness({
      root,
      regenerate: () =>
        writeFileSync(file, "// generated\nexport const routeTree = 2\n"),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("stale");
    expect(result.message).toContain("first difference at line 2");
    expect(result.message).toContain("npm exec --workspace apps/web");
    expect(readFileSync(file, "utf8")).toBe(GENERATED);
  });

  it("hands the codegen the working-tree copy plus the probe line", () => {
    let handed;
    checkRouteTreeFreshness({
      root,
      regenerate: () => {
        handed = readFileSync(file, "utf8");
        writeFileSync(file, GENERATED);
      },
    });
    expect(handed.startsWith(GENERATED)).toBe(true);
    expect(handed).toContain(PROBE);
  });

  it("fails closed when the command rewrites nothing", () => {
    const result = checkRouteTreeFreshness({ root, regenerate: () => {} });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("codegen-did-not-run");
    expect(result.message).toContain("the probe line this check wrote");
    expect(readFileSync(file, "utf8")).toBe(GENERATED);
  });

  it("fails closed when the command removes the file", () => {
    const result = checkRouteTreeFreshness({
      root,
      regenerate: () => rmSync(file),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("codegen-did-not-run");
    expect(result.message).toContain("the file is gone");
    expect(readFileSync(file, "utf8")).toBe(GENERATED);
  });

  it("fails closed when the command errors, carrying its output", () => {
    const result = checkRouteTreeFreshness({
      root,
      regenerate: () => {
        const error = new Error("Command failed");
        error.stdout = "";
        error.stderr = "Error: Cannot find module '@psilink/core'";
        throw error;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("codegen-failed");
    expect(result.message).toContain("Cannot find module '@psilink/core'");
    expect(readFileSync(file, "utf8")).toBe(GENERATED);
  });

  it("fails without regenerating when the checked-in copy is absent", () => {
    rmSync(file);
    let ran = false;
    const result = checkRouteTreeFreshness({
      root,
      regenerate: () => {
        ran = true;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("missing");
    expect(ran).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
});

describe("wiring and the documentation a contributor reads", () => {
  const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");

  it("is a root npm script", () => {
    expect(JSON.parse(read("package.json")).scripts["check:routetree"]).toBe(
      "node scripts/check-routetree-fresh.mjs",
    );
  });

  it("runs on every pull request", () => {
    expect(CHECKS.map((check) => check.script)).toContain("check:routetree");
  });

  it("agrees with the refresh command apps/web/README.md gives", () => {
    const readme = read("apps/web/README.md");
    expect(readme).toContain(REGENERATE_COMMAND);
    expect(readme).toContain("npm run check:routetree");
  });
});
