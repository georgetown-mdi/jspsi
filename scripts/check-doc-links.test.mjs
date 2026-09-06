import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findFailures } from "./check-doc-links.mjs";
import { UnterminatedFenceError } from "./lib/markdownFences.mjs";

// findFailures resolves relative targets against dirname(absPath), so a fixed
// absPath inside this directory is enough -- the fixture doc never needs to
// exist on disk, but the "missing" targets must not exist here.
const here = dirname(fileURLToPath(import.meta.url));
const file = "fixture.md";
const absPath = resolve(here, file);

describe("check-doc-links inline code spans", () => {
  it("does not flag a link-shaped substring inside an inline code span", () => {
    const raw =
      "The pattern `/^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9])?$/` validates the field.\n";
    expect(findFailures(file, absPath, raw)).toEqual([]);
  });

  it("still flags a dead link", () => {
    const raw = "[broken](missing.md)\n";
    const failures = findFailures(file, absPath, raw);
    expect(failures).toEqual([`${file}:1  dead path -> missing.md`]);
  });

  it("reports the correct line for a dead link positioned after a stripped span", () => {
    const raw = "line1 with code `](x)` span\nline2\n[broken](missing2.md)\n";
    const failures = findFailures(file, absPath, raw);
    expect(failures).toEqual([`${file}:3  dead path -> missing2.md`]);
  });

  it("does not let a code span crossing a newline hide or shift a later dead link", () => {
    const raw =
      "para `open code\nspanning two lines` end\n[broken](missing3.md)\n";
    const failures = findFailures(file, absPath, raw);
    expect(failures).toEqual([`${file}:3  dead path -> missing3.md`]);
  });

  it("closes a multi-backtick span containing a single backtick without hiding a later dead link", () => {
    const raw = "text ``a`b`` and [broken](missing4.md) after\n";
    const failures = findFailures(file, absPath, raw);
    expect(failures).toEqual([`${file}:1  dead path -> missing4.md`]);
  });

  it("reports the correct line for a dead link after a multi-line HTML comment", () => {
    const raw =
      "<!-- example [link](syntax.md) lives here\nacross\nseveral\nlines -->\nline5\n[broken](missing5.md)\n";
    const failures = findFailures(file, absPath, raw);
    expect(failures).toEqual([`${file}:6  dead path -> missing5.md`]);
  });
});

describe("check-doc-links fenced code blocks", () => {
  const scratch = [];
  const fixtureDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "psilink-doc-links-"));
    scratch.push(dir);
    return dir;
  };

  afterEach(() => {
    while (scratch.length > 0) {
      rmSync(scratch.pop(), { recursive: true, force: true });
    }
  });

  it("does not read a link out of a block that shows a tilde fence", () => {
    const raw = "```md\n~~~\n[example](missing6.md)\n~~~\n```\n";
    expect(findFailures(file, absPath, raw)).toEqual([]);
  });

  it("does not read a link out of a shorter fence inside a longer one", () => {
    const raw = "````md\n```\n[example](missing7.md)\n```\n````\n";
    expect(findFailures(file, absPath, raw)).toEqual([]);
  });

  it("reports an unterminated fence instead of scanning a mis-split document", () => {
    const raw = "```sh\nls\n```\n\n```sh\n[broken](missing8.md)\n";
    expect(() => findFailures(file, absPath, raw)).toThrow(
      UnterminatedFenceError,
    );
    expect(() => findFailures(file, absPath, raw)).toThrow(`${file}:5`);
  });

  it("reports an unterminated fence in the document an anchor points into", () => {
    const dir = fixtureDir();
    writeFileSync(join(dir, "target.md"), "# Title\n\n```sh\nls\n");
    const raw = "[x](target.md#title)\n";
    expect(() =>
      findFailures("fixture.md", join(dir, "fixture.md"), raw),
    ).toThrow(UnterminatedFenceError);
  });

  it("does not take a heading inside a target's fenced block as an anchor", () => {
    const dir = fixtureDir();
    writeFileSync(join(dir, "target.md"), "# Title\n\n```md\n## Sample\n```\n");
    const raw = "[x](target.md#sample)\n";
    expect(findFailures("fixture.md", join(dir, "fixture.md"), raw)).toEqual([
      "fixture.md:1  dead anchor -> target.md#sample",
    ]);
  });
});
