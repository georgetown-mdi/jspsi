import { afterEach, expect, test, vi } from "vitest";
import { sanitizeErrorForDisplay, UsageError } from "@psilink/core";

// The account lookup is the seam every test here drives: the real call reads the
// OS user database, so replacing the module (rather than node:os) lets each test
// state what that read does -- a name, a blank, or the ERR_SYSTEM_ERROR throw an
// account with no user-database entry produces.
vi.mock("../../src/util/accountUserName", () => ({
  accountUserName: vi.fn(),
}));

import { accountUserName } from "../../src/util/accountUserName";
import {
  configuredIdentityRequired,
  IDENTITY_REQUIRED,
  resolveConfiguredIdentity,
  resolveIdentity,
} from "../../src/partyIdentity";

const lookup = vi.mocked(accountUserName);

/** What `os.userInfo()` throws for a uid with no entry in the user database --
 *  the failure a container run under `--user <uid>:<gid>` produces for a uid the
 *  image does not define. */
function unmappedUidFailure(): Error {
  return Object.assign(
    new Error("uv_os_get_passwd returned ENOENT (no such file or directory)"),
    { code: "ERR_SYSTEM_ERROR" },
  );
}

afterEach(() => {
  lookup.mockReset();
});

test("a supplied identity is returned without consulting the account", () => {
  lookup.mockImplementation(() => {
    throw unmappedUidFailure();
  });
  expect(resolveIdentity("Jane Smith, Agency A")).toBe("Jane Smith, Agency A");
  expect(lookup).not.toHaveBeenCalled();
});

test("no supplied identity falls back to the account's user name", () => {
  lookup.mockReturnValue("node");
  expect(resolveIdentity(undefined)).toBe("node");
});

test("an account with no user-database entry is refused, not defaulted", () => {
  const failure = unmappedUidFailure();
  lookup.mockImplementation(() => {
    throw failure;
  });
  let raised: unknown;
  try {
    resolveIdentity(undefined);
  } catch (err) {
    raised = err;
  }
  expect(raised).toBeInstanceOf(UsageError);
  expect((raised as Error).message).toBe(IDENTITY_REQUIRED);
  // The system error is carried rather than swallowed, so the operator still
  // sees what psilink tried when the refusal is rendered.
  expect((raised as Error).cause).toBe(failure);
  expect(sanitizeErrorForDisplay(raised)).toContain("uv_os_get_passwd");
});

test("the refusal names the flag that supplies an identity", () => {
  // The operator's way out has to be in the message: nothing else on this path
  // tells them the label is theirs to choose.
  expect(IDENTITY_REQUIRED).toContain("--identity");
});

test("an account that reports a blank user name is refused with no cause", () => {
  lookup.mockReturnValue("");
  let raised: unknown;
  try {
    resolveIdentity(undefined);
  } catch (err) {
    raised = err;
  }
  expect(raised).toBeInstanceOf(UsageError);
  expect((raised as Error).message).toBe(IDENTITY_REQUIRED);
  expect((raised as Error).cause).toBeUndefined();
});

test("an empty --identity is treated as none supplied", () => {
  lookup.mockReturnValue("node");
  expect(resolveIdentity("")).toBe("node");
});

test("a configured identity is returned without consulting the account", () => {
  expect(resolveConfiguredIdentity("Test Party", "/work/psilink.yaml")).toBe(
    "Test Party",
  );
  expect(lookup).not.toHaveBeenCalled();
});

test("a configuration carrying no identity is refused, naming the file", () => {
  let raised: unknown;
  try {
    resolveConfiguredIdentity(undefined, "/work/psilink.yaml");
  } catch (err) {
    raised = err;
  }
  expect(raised).toBeInstanceOf(UsageError);
  expect((raised as Error).message).toBe(
    configuredIdentityRequired("/work/psilink.yaml"),
  );
  expect((raised as Error).message).toContain("/work/psilink.yaml");
  expect((raised as Error).message).toContain("linkage_terms.identity");
  // No account fallback on this path at all, so the refusal is the only outcome.
  expect(lookup).not.toHaveBeenCalled();
});
