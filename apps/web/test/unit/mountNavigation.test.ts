import { describe, expect, test } from "vitest";

import {
  breadcrumbTrail,
  enterSubdir,
  fileSubPath,
} from "@bench/mountNavigation";

describe("mount navigation", () => {
  test("enterSubdir appends one segment without mutating the input", () => {
    const base = [".ssh"];
    expect(enterSubdir(base, "keys")).toEqual([".ssh", "keys"]);
    expect(base).toEqual([".ssh"]);
  });

  test("fileSubPath is the directory plus the file name", () => {
    expect(fileSubPath([".ssh"], "id_ed25519")).toEqual([".ssh", "id_ed25519"]);
    expect(fileSubPath([], "partner-password")).toEqual(["partner-password"]);
  });

  test("breadcrumbTrail carries the cumulative subPath for each crumb", () => {
    expect(breadcrumbTrail("secrets", ["a", "b"])).toEqual([
      { label: "secrets", subPath: [] },
      { label: "a", subPath: ["a"] },
      { label: "b", subPath: ["a", "b"] },
    ]);
  });

  test("breadcrumbTrail at the root is just the root crumb", () => {
    expect(breadcrumbTrail("secrets", [])).toEqual([
      { label: "secrets", subPath: [] },
    ]);
  });
});
