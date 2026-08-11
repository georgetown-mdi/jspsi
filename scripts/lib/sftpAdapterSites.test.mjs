import { describe, expect, it } from "vitest";

import { parseSource, requestIssuingSites } from "./sftpAdapterSites.mjs";

describe("SFTP adapter request-issuing sites", () => {
  it("finds a round trip issued on a local aliasing the client or the wrapper", () => {
    // The adapter issues every round trip on `this.client` or on a `{ sftp }`
    // destructured from the internals cast, so neither check over it exercises
    // the alias rule and a regression in it would fail no assertion there.
    // Pinned against a source of its own instead: without the rule these two
    // sites are simply not seen, and an uncounted round trip written this way
    // passes both checks.
    const aliasing = parseSource(
      "aliasing.ts",
      `class A {
         private issue(path: string) {
           const client = this.client;
           const relayed = client;
           void relayed.stat(path);
           const internals = this.client as unknown as Ssh2SftpClientInternals;
           const { sftp } = internals;
           sftp.readdir(path, () => {});
         }
       }`,
    );
    expect(requestIssuingSites(aliasing).map((site) => site.callee)).toEqual([
      "relayed.stat",
      "sftp.readdir",
    ]);
  });
});
