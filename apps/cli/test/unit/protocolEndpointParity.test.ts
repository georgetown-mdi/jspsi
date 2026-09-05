import { expect, test } from "vitest";
import type { EndpointSourceConnectionConfig } from "@psilink/core";

import type { ProtocolConnectionConfig } from "../../src/protocol";

/**
 * True only when `A` and `B` are mutually assignable. The tuple wrappers stop
 * the conditional distributing over the two unions, so this compares them whole
 * rather than member by member.
 */
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

// core's endpoint producer names the channels it can mint a locator for, and
// the CLI's runProtocol names the channels its transport can run; the invite
// path passes one to the other unchanged. Both narrow the same ConnectionConfig
// union by hand, and core cannot import the CLI type, so nothing holds the
// two in step. This check does: a channel added to one union and not the
// other is a type error here before it is a mismatch at runtime.
const UNIONS_AGREE: MutuallyAssignable<
  ProtocolConnectionConfig,
  EndpointSourceConnectionConfig
> = true;

test("the connections runProtocol runs are exactly the connections core mints an endpoint from", () => {
  expect(UNIONS_AGREE).toBe(true);
});
