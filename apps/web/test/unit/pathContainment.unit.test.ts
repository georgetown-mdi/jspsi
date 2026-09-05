import { describe, expect, test } from "vitest";

import { isPathWithin } from "@jobs/pathContainment";

import type { PathContainmentBound } from "@jobs/pathContainment";

const BOUNDS: Array<PathContainmentBound> = ["at-or-under", "strictly-under"];

describe.each(BOUNDS)("isPathWithin (%s)", (bound) => {
  test("a child whose basename starts with .. is within", () => {
    expect(isPathWithin("/x", "/x/..data", bound)).toBe(true);
  });

  test("a ../ escape is outside", () => {
    expect(isPathWithin("/x", "/x/../y", bound)).toBe(false);
  });

  test("a bare .. is outside", () => {
    expect(isPathWithin("/x", "/x/..", bound)).toBe(false);
  });

  test("a sibling sharing the parent's prefix is outside", () => {
    expect(isPathWithin("/x", "/xy", bound)).toBe(false);
  });

  test("an absolute child on another branch is outside", () => {
    expect(isPathWithin("/x", "/etc/shadow", bound)).toBe(false);
  });

  test("a relative child throws rather than resolving against the working directory", () => {
    expect(() => isPathWithin(process.cwd(), "..data", bound)).toThrow(
      /child must be an absolute path/,
    );
  });

  test("a relative parent throws rather than resolving against the working directory", () => {
    expect(() => isPathWithin("mount", "/mount/file", bound)).toThrow(
      /parent must be an absolute path/,
    );
  });
});

describe("isPathWithin bound", () => {
  test("at-or-under admits the parent itself", () => {
    expect(isPathWithin("/x", "/x", "at-or-under")).toBe(true);
  });

  test("strictly-under refuses the parent itself", () => {
    expect(isPathWithin("/x", "/x", "strictly-under")).toBe(false);
  });

  test("a trailing separator does not make a root its own child", () => {
    expect(isPathWithin("/x/", "/x", "strictly-under")).toBe(false);
    expect(isPathWithin("/x", "/x/", "strictly-under")).toBe(false);
  });

  test("the filesystem root contains an absolute path under it", () => {
    expect(isPathWithin("/", "/x", "strictly-under")).toBe(true);
    expect(isPathWithin("/", "/", "strictly-under")).toBe(false);
    expect(isPathWithin("/", "/", "at-or-under")).toBe(true);
  });
});
