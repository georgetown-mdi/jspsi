import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import {
  boundIdentityOf,
  certificateOnlyLoadCases,
} from "@alcove/core/testing";

import { readBoundIdentity } from "@jobs/signingIdentity";

// This is the console half of the certificate-only load parity set
// (`@alcove/core/testing`, whose module header states what it holds).
// `packages/` cannot import `apps/` and `apps/web` may not import `apps/cli`,
// so each app drives the set from its own test tree; the CLI half is
// apps/cli/test/unit/boundIdentityParity.test.ts, compared against the same
// documents and so against each other.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-bound-identity-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the console reports the name a certificate-only load reports", async () => {
  const cases = await certificateOnlyLoadCases();
  const reported: Record<string, string | undefined> = {};
  const owed: Record<string, string | undefined> = {};
  for (const [id, one] of Object.entries(cases)) {
    const identityPath = path.join(dir, `${id}.json`);
    if (one.document !== null)
      fs.writeFileSync(identityPath, one.document, { mode: 0o600 });
    reported[id] = await boundIdentityOf(() => readBoundIdentity(identityPath));
    owed[id] = one.bound ?? undefined;
  }
  // Compared as whole records rather than case by case, so a case the loop
  // never reached fails here instead of passing unnoticed.
  expect(reported).toStrictEqual(owed);
});
