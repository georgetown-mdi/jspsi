import fs from "node:fs";
import path from "node:path";

import { expect, test } from "vitest";
import { UsageError } from "@psilink/core";

import {
  configuredIdentityRequired,
  IDENTITY_REQUIRED,
  resolveConfiguredIdentity,
  resolveIdentity,
} from "../../src/partyIdentity";

/** Every TypeScript source the CLI ships, by name and content, for the
 * structural check below; a failure then names the file rather than printing
 * it. */
function cliSources(): Array<{ name: string; text: string }> {
  const root = path.join(import.meta.dirname, "..", "..", "src");
  const names = fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"));
  if (names.length === 0) throw new Error(`no CLI sources found under ${root}`);
  return names.map((name) => ({
    name,
    text: fs.readFileSync(path.join(root, name), "utf8"),
  }));
}

/** Raise and return what a refusal threw, so each case below asserts on the
 * error rather than on a rejection shape. */
function refusalFrom(resolve: () => string): unknown {
  try {
    resolve();
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal, got a resolved identity");
}

test("a supplied identity is returned, trimmed", () => {
  expect(resolveIdentity("Jane Smith, Agency A")).toBe("Jane Smith, Agency A");
  expect(resolveIdentity("  Jane Smith, Agency A  ")).toBe(
    "Jane Smith, Agency A",
  );
});

test("no identity is refused rather than invented", () => {
  const raised = refusalFrom(() => resolveIdentity(undefined));
  expect(raised).toBeInstanceOf(UsageError);
  expect((raised as Error).message).toBe(IDENTITY_REQUIRED);
});

test("a blank --identity is refused exactly as an absent one", () => {
  // `--identity "$ORG"` with ORG unset is the shape that reaches here blank, and
  // a run that meant to name this party and did not must not proceed under
  // something else.
  for (const blank of ["", " ", "   ", "\t", " \t "]) {
    const raised = refusalFrom(() => resolveIdentity(blank));
    expect(raised).toBeInstanceOf(UsageError);
    expect((raised as Error).message).toBe(IDENTITY_REQUIRED);
  }
});

test("the refusal names the flag that supplies an identity", () => {
  // The operator's way out has to be in the message: nothing else on this path
  // tells them the label is theirs to choose.
  expect(IDENTITY_REQUIRED).toContain('--identity "name, org, contact"');
});

test("nothing the CLI ships resolves a party name from the account", () => {
  // The account psilink runs as is not a label the operator chose -- in the
  // published image it is the image's own -- so the fallback is gone rather than
  // guarded, and the user-database read that raised the unmapped-uid failure is
  // gone with it. This is a source check: it holds for every path, including the
  // ones no test drives, which is what makes "no lookup remains" checkable at
  // all. It sees only this workspace's own sources, so it says nothing about a
  // dependency that reads the user database for its own reasons.
  const offenders = cliSources()
    .filter((source) => /\buserInfo\b|\baccountUserName\b/.test(source.text))
    .map((source) => source.name);
  expect(offenders).toEqual([]);
});

test("a configured identity is returned", () => {
  expect(resolveConfiguredIdentity("Test Party", "/work/psilink.yaml")).toBe(
    "Test Party",
  );
});

test("a configuration carrying no identity is refused, naming the file", () => {
  const raised = refusalFrom(() =>
    resolveConfiguredIdentity(undefined, "/work/psilink.yaml"),
  );
  expect(raised).toBeInstanceOf(UsageError);
  expect((raised as Error).message).toBe(
    configuredIdentityRequired("/work/psilink.yaml"),
  );
  expect((raised as Error).message).toContain("/work/psilink.yaml");
  expect((raised as Error).message).toContain("linkage_terms.identity");
});
