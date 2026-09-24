import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import {
  boundIdentityOf,
  certificateOnlyLoadCases,
} from "@alcove/core/testing";

import { loadSigningCertificate } from "../../src/signingIdentityFile";

// This is the CLI half of the certificate-only load parity set
// (`@alcove/core/testing`, whose module header states what it holds).
// `packages/` cannot import `apps/`, so driving the set through this app's
// loader belongs in its own test tree; the console half is
// apps/web/test/unit/jobs/boundIdentityParity.test.ts, compared against the same
// documents and so against each other. A tightening here that this file records
// leaves that one failing until the console stops reporting a name the run
// refuses.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-bound-identity-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the certificate-only load reports the name each document names", async () => {
  const cases = await certificateOnlyLoadCases();
  const reported: Record<string, string | undefined> = {};
  const owed: Record<string, string | undefined> = {};
  for (const [id, one] of Object.entries(cases)) {
    const identityPath = path.join(dir, `${id}.json`);
    if (one.document !== null)
      fs.writeFileSync(identityPath, one.document, { mode: 0o600 });
    reported[id] = await boundIdentityOf(
      async () => (await loadSigningCertificate(identityPath))?.identity,
    );
    owed[id] = one.bound ?? undefined;
  }
  // Compared as whole records rather than case by case, so a case the loop
  // never reached fails here instead of passing unnoticed.
  expect(reported).toStrictEqual(owed);
});
