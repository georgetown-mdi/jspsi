import fs from "node:fs";
import path from "node:path";

import { expect, test } from "vitest";
import { sanitizeErrorForDisplay, UsageError } from "@psilink/core";

import {
  configuredIdentityRequired,
  configuredIdentityStillPlaceholder,
  IDENTITY_REQUIRED,
  IDENTITY_STILL_PLACEHOLDER,
  optionalIdentity,
  PLACEHOLDER_IDENTITY,
  resolveIdentity,
  resolveInvitationIdentity,
} from "../../src/partyIdentity";

/** The placeholder as it reaches a resolver: verbatim, and with the whitespace a
 * hand-edited file or a quoted shell argument leaves around it. */
const PLACEHOLDER_FORMS = [
  PLACEHOLDER_IDENTITY,
  ` ${PLACEHOLDER_IDENTITY}`,
  `${PLACEHOLDER_IDENTITY} `,
  `  ${PLACEHOLDER_IDENTITY}\t`,
  `\n${PLACEHOLDER_IDENTITY}\n`,
];

/** Labels a partner could legitimately read, each one holding the placeholder's
 * text or shape without being it. */
const REAL_LABELS = [
  `${PLACEHOLDER_IDENTITY} Health Authority`,
  `Jane Smith, ${PLACEHOLDER_IDENTITY} Inc, jane@example.org`,
  PLACEHOLDER_IDENTITY.toLowerCase(),
  `${PLACEHOLDER_IDENTITY}_2`,
];

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
function refusalFrom(resolve: () => string | undefined): unknown {
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

test("the init template's placeholder is refused as firmly as no identity", () => {
  // The template writes a value the terms schema accepts, so nothing downstream
  // can tell it from a name: an operator who copies it to the command line would
  // otherwise author a partnership whose inviter is the words asking for a name.
  for (const form of PLACEHOLDER_FORMS) {
    const raised = refusalFrom(() => resolveIdentity(form));
    expect(raised).toBeInstanceOf(UsageError);
    expect((raised as Error).message).toBe(IDENTITY_STILL_PLACEHOLDER);
  }
});

test("a run that may go unnamed refuses the placeholder rather than dropping it", () => {
  // Reading it as absence would be the quiet failure: the run proceeds under the
  // configuration's own label, or under none, while the operator who typed the
  // value believes they named this party.
  for (const form of PLACEHOLDER_FORMS) {
    const raised = refusalFrom(() => optionalIdentity(form));
    expect(raised).toBeInstanceOf(UsageError);
    expect((raised as Error).message).toBe(IDENTITY_STILL_PLACEHOLDER);
  }
});

test("a real label carrying the placeholder's text is a name like any other", () => {
  // The match is the whole trimmed value, not a substring or a case-folded one:
  // an organization whose name happens to contain those words -- or an operator
  // who edited the field to something built from them -- must not be refused.
  for (const label of REAL_LABELS) {
    expect(resolveIdentity(label)).toBe(label);
    expect(optionalIdentity(label)).toBe(label);
    expect(resolveInvitationIdentity(label, "/work/psilink.yaml")).toBe(label);
  }
});

test("the placeholder refusal names the flag that supplies an identity", () => {
  // Same obligation the empty-value refusal carries: the message is the only
  // place this path tells the operator how to name the party.
  expect(IDENTITY_STILL_PLACEHOLDER).toContain(
    '--identity "name, org, contact"',
  );
  expect(IDENTITY_STILL_PLACEHOLDER).toContain(PLACEHOLDER_IDENTITY);
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

test("an invitation's configured identity is returned", () => {
  expect(resolveInvitationIdentity("Test Party", "/work/psilink.yaml")).toBe(
    "Test Party",
  );
});

test("an invitation over a configuration carrying no identity is refused", () => {
  // Inviting authors a partnership the partner reads a name off, so it is one of
  // the two commands that will not proceed unnamed; the refusal names the file
  // and the field, since the flag cannot stand in on this path.
  const raised = refusalFrom(() =>
    resolveInvitationIdentity(undefined, "/work/psilink.yaml"),
  );
  expect(raised).toBeInstanceOf(UsageError);
  expect((raised as Error).message).toBe(
    configuredIdentityRequired("/work/psilink.yaml"),
  );
  expect((raised as Error).message).toContain("/work/psilink.yaml");
  expect((raised as Error).message).toContain("linkage_terms.identity");
});

test("a whitespace-only configured identity is refused, not carried", () => {
  // The terms schema's non-empty rule admits "   ", so without this the
  // invitation is minted "named" and renders an empty inviter heading to the
  // partner reading it -- while the same command's --identity path trims to
  // absence and refuses.
  for (const blank of [" ", "   ", "\t", " \t ", "\n"]) {
    const raised = refusalFrom(() =>
      resolveInvitationIdentity(blank, "/work/psilink.yaml"),
    );
    expect(raised).toBeInstanceOf(UsageError);
    expect((raised as Error).message).toBe(
      configuredIdentityRequired("/work/psilink.yaml"),
    );
  }
});

test("an invitation over a configuration still carrying the placeholder is refused", () => {
  // The driving case: the operator fills in the connection block and passes over
  // this field, and the invitation -- certificate mode included -- would go out
  // naming the party the template's instruction to name it. The refusal has to
  // carry the field and the file, since the flag cannot stand in on this path.
  for (const form of PLACEHOLDER_FORMS) {
    const raised = refusalFrom(() =>
      resolveInvitationIdentity(form, "/work/psilink.yaml"),
    );
    expect(raised).toBeInstanceOf(UsageError);
    expect((raised as Error).message).toBe(
      configuredIdentityStillPlaceholder("/work/psilink.yaml"),
    );
  }
  const message = configuredIdentityStillPlaceholder("/work/psilink.yaml");
  expect(message).toContain("linkage_terms.identity");
  expect(message).toContain("/work/psilink.yaml");
  expect(message).toContain(PLACEHOLDER_IDENTITY);
});

test("the placeholder refusal escapes the configuration path exactly once", () => {
  // Same display-boundary contract as the absent-identity refusal: the path is
  // composed RAW and escaped once by the renderer the CLI shows errors through
  // (CONTRIBUTING.md, Operator-facing escaping).
  const windows = String.raw`C:\work\psilink.yaml`;
  const rendered = sanitizeErrorForDisplay(
    new UsageError(configuredIdentityStillPlaceholder(windows)),
  );
  expect(rendered).toContain(String.raw`C:\\work\\psilink.yaml`);
  expect(rendered).not.toContain(String.raw`C:\\\\work`);
});

test("a configured identity comes back verbatim, whitespace and all", () => {
  // Trimming decides only whether the refusal fires. The label the partnership
  // sends is the configuration's own bytes -- every later `psilink exchange`
  // reads them straight from the file, and a certificate authorizes an exact
  // string -- so this must not hand back a trimmed copy.
  expect(
    resolveInvitationIdentity("  Test Party  ", "/work/psilink.yaml"),
  ).toBe("  Test Party  ");
});

test("the configuration path in the refusal is escaped exactly once", () => {
  // The message composes the path RAW and takes its single escape from the
  // renderer the CLI shows errors through. Pinned in both directions: a raw
  // control character must not reach the operator's terminal, and a Windows
  // path's backslashes must not come back quadrupled by a second escape at
  // composition (CONTRIBUTING.md, Operator-facing escaping).
  const windows = String.raw`C:\work\psilink.yaml`;
  const rendered = sanitizeErrorForDisplay(
    new UsageError(configuredIdentityRequired(windows)),
  );
  expect(rendered).toContain(String.raw`C:\\work\\psilink.yaml`);
  expect(rendered).not.toContain(String.raw`C:\\\\work`);

  const withControl = sanitizeErrorForDisplay(
    new UsageError(configuredIdentityRequired("/work/\u001b[31mpsilink.yaml")),
  );
  expect(withControl).not.toContain("\u001b");
  expect(withControl).toContain(String.raw`\x1b[31mpsilink.yaml`);
});

test("an optional identity is trimmed, and blank reads as absent", () => {
  // The runs that may go unnamed take this instead of the refusal: a label rides
  // into the terms, and anything blank -- what `--identity "$ORG"` sends with ORG
  // unset -- leaves the terms carrying none rather than an empty label.
  expect(optionalIdentity("  Jane Smith, Agency A  ")).toBe(
    "Jane Smith, Agency A",
  );
  expect(optionalIdentity(undefined)).toBeUndefined();
  for (const blank of ["", " ", "   ", "\t", " \t "])
    expect(optionalIdentity(blank)).toBeUndefined();
});
