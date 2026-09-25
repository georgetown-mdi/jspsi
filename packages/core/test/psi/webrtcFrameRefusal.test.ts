import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../../src/psi/participant";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import { createMessagePipe } from "../../src/connection/messageConnection";
import {
  binaryPackByteStringLength,
  minimumPsiSetFrameBytes,
  webrtcFrameReceiveCharge,
} from "../../src/connection/webrtcOutboundBound";
import { PeerAbortError, WebRtcFrameLimitError } from "../../src/errors";
import {
  assertFirstRoundFitsWebRtcFrame,
  prepareForExchange,
} from "../../src/exchange";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

import type { MessageConnection } from "../../src/connection/messageConnection";
import type { LinkageStrategy } from "../../src/config/linkageTermsSchema";

// The sender-side half of the WebRTC frame bound: a party refuses a set frame
// the partner's receive path would refuse, before it goes on the wire. The
// bound is lowered to a few kilobytes so the boundary is reached with sets of
// a few hundred values; the arithmetic at the real bound is pinned in
// connection/webrtcOutboundBound.test.ts.

const psiLibrary = await PSI();

/** `conn` advertising `bound` as its partner's receive-side frame bound. */
function withFrameBound(
  conn: MessageConnection,
  bound: number | undefined,
): MessageConnection {
  return {
    send: (data) => conn.send(data),
    receive: (timeoutMs) => conn.receive(timeoutMs),
    close: () => conn.close(),
    outboundWebRtcFrameBound: () => bound,
  };
}

function values(count: number, prefix: string): Array<string> {
  return Array.from({ length: count }, (_unused, i) => `${prefix}-${i}`);
}

/** The packed length of the frame the library builds for `set` in `role`. */
async function builtFrameBytes(
  role: "starter" | "joiner",
  set: Array<string>,
): Promise<number> {
  const engine = new InProcessPsiEngine(
    psiLibrary,
    role,
    role === "starter" ? "server" : "client",
    "identifier-revealing",
  );
  try {
    const bytes =
      role === "starter"
        ? (await engine.createServerSetup(set)).setup
        : await engine.createClientRequest(set);
    return binaryPackByteStringLength(bytes.byteLength);
  } finally {
    engine.dispose();
  }
}

/**
 * One cascade round between a starter holding `starterSet` and a joiner
 * holding `joinerSet`, each advertising its own bound. Resolves to how each
 * side ended.
 */
async function round(
  starterSet: Array<string>,
  joinerSet: Array<string>,
  bounds: { starter?: number; joiner?: number },
): Promise<{ starter: unknown; joiner: unknown }> {
  const [a, b] = createMessagePipe();
  const starter = new PSIParticipant(
    "server",
    psiLibrary,
    { role: "starter", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const joiner = new PSIParticipant(
    "client",
    psiLibrary,
    { role: "joiner", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const settle = (promise: Promise<unknown>) =>
    promise.then(
      () => "completed",
      (err: unknown) => err,
    );
  const [starterEnd, joinerEnd] = await Promise.all([
    settle(
      starter.identifyIntersection(
        withFrameBound(a, bounds.starter),
        starterSet,
      ),
    ),
    settle(
      joiner.identifyIntersection(withFrameBound(b, bounds.joiner), joinerSet),
    ),
  ]);
  await a.close();
  await b.close();
  starter.dispose();
  joiner.dispose();
  return { starter: starterEnd, joiner: joinerEnd };
}

test("a starter's setup is sent one under and at the bound, and refused one over", async () => {
  const set = values(100, "s");
  const charge = webrtcFrameReceiveCharge(
    await builtFrameBytes("starter", set),
  );

  for (const bound of [charge + 1, charge]) {
    const ended = await round(set, values(3, "s"), { starter: bound });
    expect(ended).toEqual({ starter: "completed", joiner: "completed" });
  }

  const ended = await round(set, values(3, "s"), { starter: charge - 1 });
  expect(ended.starter).toBeInstanceOf(WebRtcFrameLimitError);
  expect((ended.starter as WebRtcFrameLimitError).setOwner).toBe("local");
  // The partner, parked on the setup, reads the abort sent in its place.
  expect(ended.joiner).toBeInstanceOf(PeerAbortError);
});

test("a joiner's request is sent one under and at the bound, and refused one over", async () => {
  const set = values(120, "j");
  const charge = webrtcFrameReceiveCharge(await builtFrameBytes("joiner", set));

  for (const bound of [charge + 1, charge]) {
    const ended = await round(values(3, "j"), set, { joiner: bound });
    expect(ended).toEqual({ starter: "completed", joiner: "completed" });
  }

  const ended = await round(values(3, "j"), set, { joiner: charge - 1 });
  expect(ended.joiner).toBeInstanceOf(WebRtcFrameLimitError);
  expect((ended.joiner as WebRtcFrameLimitError).setOwner).toBe("local");
  expect(ended.starter).toBeInstanceOf(PeerAbortError);
});

test("the reply returning a partner's set over the bound is refused as the partner's", async () => {
  // A partner that checks nothing sends a request the starter's reply to would
  // cross the bound; the starter's own setup is small enough to send.
  const joinerSet = values(200, "r");
  const bound = webrtcFrameReceiveCharge(
    minimumPsiSetFrameBytes(joinerSet.length) - 1,
  );
  const ended = await round(values(3, "r"), joinerSet, { starter: bound });
  expect(ended.starter).toBeInstanceOf(WebRtcFrameLimitError);
  expect((ended.starter as WebRtcFrameLimitError).setOwner).toBe("partner");
  expect((ended.starter as Error).message).toMatch(/Ask your partner/);
  expect(ended.joiner).toBeInstanceOf(PeerAbortError);
});

test("a transport stating no bound sends any set", async () => {
  const ended = await round(values(50, "n"), values(50, "n"), {});
  expect(ended).toEqual({ starter: "completed", joiner: "completed" });
});

// The first-round check reads the prepared dataset, before any connection.

function letters(i: number): string {
  let out = "";
  let n = i;
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  // A prefix no first-name cleaning shortens or maps onto another name.
  return `zq${out}`;
}

function preparedWith(
  firstNames: Array<string>,
  strategy: LinkageStrategy = "cascade",
) {
  return prepareForExchange(
    {
      linkageTerms: {
        version: "1.0.0",
        date: "2026-01-01",
        algorithm: "psi",
        deduplicate: false,
        linkageStrategy: strategy,
        identity: "Tester",
        output: { expectsOutput: true, shareWithPartner: true },
        linkageFields: [{ name: "firstName", type: "first_name" }],
        linkageKeys: [
          { name: "firstName", elements: [{ field: "firstName" }] },
        ],
      },
    },
    "Tester",
    firstNames.map((name) => ({ first_name: name })),
    ["first_name"],
  );
}

test("the first-round check refuses one value over the bound and admits one under and at it", () => {
  // 300 values held by one record each, beside 40 records sharing 20 values:
  // the round drops a shared value, so 300 is the count the check weighs.
  const unique = Array.from({ length: 301 }, (_unused, i) => letters(i));
  const shared = Array.from({ length: 20 }, (_unused, i) => letters(1000 + i));
  const rows = (uniqueCount: number) => [
    ...unique.slice(0, uniqueCount),
    ...shared,
    ...shared,
  ];
  const boundAt = webrtcFrameReceiveCharge(minimumPsiSetFrameBytes(300));

  expect(() =>
    assertFirstRoundFitsWebRtcFrame(preparedWith(rows(299)), boundAt),
  ).not.toThrow();
  expect(() =>
    assertFirstRoundFitsWebRtcFrame(preparedWith(rows(300)), boundAt),
  ).not.toThrow();
  let refusal: unknown;
  try {
    assertFirstRoundFitsWebRtcFrame(preparedWith(rows(301)), boundAt);
  } catch (err) {
    refusal = err;
  }
  expect(refusal).toBeInstanceOf(WebRtcFrameLimitError);
  expect((refusal as WebRtcFrameLimitError).setOwner).toBe("local");
  expect((refusal as Error).message).toMatch(
    /at least 301 values to send.*Nothing was sent/,
  );
});

test("the first-round check leaves a single-pass exchange to its dataset ceiling", () => {
  const rows = Array.from({ length: 50 }, (_unused, i) => letters(i));
  expect(() =>
    assertFirstRoundFitsWebRtcFrame(preparedWith(rows, "single-pass"), 100),
  ).not.toThrow();
  expect(() =>
    assertFirstRoundFitsWebRtcFrame(preparedWith(rows), 100),
  ).toThrow(WebRtcFrameLimitError);
});
