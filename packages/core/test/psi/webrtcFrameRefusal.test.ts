import { afterEach, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../../src/psi/participant";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import { createMessagePipe } from "../../src/connection/messageConnection";
import {
  AEAD_ENVELOPE_OVERHEAD_BYTES,
  EncryptedMessageConnection,
} from "../../src/connection/encryptedMessageConnection";
import {
  binaryPackByteStringLength,
  minimumPsiSetFrameBytes,
  ROUND_ONE_SET_UNCOUNTED_MESSAGE,
  webrtcFrameReceiveCharge,
} from "../../src/connection/webrtcOutboundBound";
import {
  PeerAbortError,
  UsageError,
  WebRtcFrameLimitError,
} from "../../src/errors";
import {
  assertFirstRoundFitsWebRtcFrame,
  prepareForExchange,
} from "../../src/exchange";
import {
  fanOutReachedMatchingRefusal,
  StandardizedDataset,
  StandardizedField,
  StandardizedKeyIterable,
} from "../../src/standardization";
import { getLogger } from "../../src/utils/logger";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

import type { MessageConnection } from "../../src/connection/messageConnection";
import type { LinkageStrategy } from "../../src/config/linkageTermsSchema";
import type { CSVRow } from "../../src/file";

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

/**
 * The packed length of the frame the library builds for `set` in `role`, sent
 * inside an envelope of `envelopeBytes`.
 */
async function builtFrameBytes(
  role: "starter" | "joiner",
  set: Array<string>,
  envelopeBytes = 0,
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
    return binaryPackByteStringLength(bytes.byteLength + envelopeBytes);
  } finally {
    engine.dispose();
  }
}

const SESSION_KEY = new Uint8Array(32).fill(0x42) as Uint8Array<ArrayBuffer>;

/**
 * One cascade round between a starter holding `starterSet` and a joiner
 * holding `joinerSet`, each advertising its own bound, over AEAD-wrapped
 * connections when `encrypted`. Resolves to how each side ended.
 */
async function round(
  starterSet: Array<string>,
  joinerSet: Array<string>,
  bounds: { starter?: number; joiner?: number },
  encrypted = false,
): Promise<{ starter: unknown; joiner: unknown }> {
  const [rawA, rawB] = createMessagePipe();
  const [a, b]: Array<MessageConnection> = encrypted
    ? await Promise.all([
        EncryptedMessageConnection.create(
          withFrameBound(rawA, bounds.starter),
          SESSION_KEY,
          "initiator",
        ),
        EncryptedMessageConnection.create(
          withFrameBound(rawB, bounds.joiner),
          SESSION_KEY,
          "responder",
        ),
      ])
    : [
        withFrameBound(rawA, bounds.starter),
        withFrameBound(rawB, bounds.joiner),
      ];
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
    settle(starter.identifyIntersection(a, starterSet)),
    settle(joiner.identifyIntersection(b, joinerSet)),
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

test("over an encrypted connection, the bound is charged the envelope too", async () => {
  const set = values(100, "e");
  const wrappedCharge = webrtcFrameReceiveCharge(
    await builtFrameBytes("starter", set, AEAD_ENVELOPE_OVERHEAD_BYTES),
  );

  const at = await round(set, values(3, "e"), { starter: wrappedCharge }, true);
  expect(at).toEqual({ starter: "completed", joiner: "completed" });

  const under = await round(
    set,
    values(3, "e"),
    { starter: wrappedCharge - 1 },
    true,
  );
  expect(under.starter).toBeInstanceOf(WebRtcFrameLimitError);
  expect((under.starter as WebRtcFrameLimitError).setOwner).toBe("local");
  expect(under.joiner).toBeInstanceOf(PeerAbortError);

  // Unwrapped, the same frame fits one byte under the wrapped charge.
  const plain = await round(set, values(3, "e"), {
    starter: wrappedCharge - 1,
  });
  expect(plain).toEqual({ starter: "completed", joiner: "completed" });
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

test("the first-round check raises the fan-out refusal for a candidate set a count-only round refuses", () => {
  const split = [{ function: "split_on", params: { delimiter: " " } }];
  const cascade = prepareForExchange(
    {
      linkageTerms: {
        version: "1.0.0",
        date: "2026-01-01",
        algorithm: "psi",
        deduplicate: false,
        linkageStrategy: "cascade",
        identity: "Tester",
        output: { expectsOutput: true, shareWithPartner: true },
        linkageFields: [{ name: "firstName", type: "first_name" }],
        linkageKeys: [
          {
            name: "firstName",
            elements: [{ field: "firstName", transform: split }],
          },
        ],
      },
    },
    "Tester",
    Array.from({ length: 200 }, (_unused, i) => ({
      first_name: `${letters(2 * i)} ${letters(2 * i + 1)}`,
    })),
    ["first_name"],
  );
  // A count-only exchange assembled without the prepare step's refusal.
  const countOnly = {
    ...cascade,
    linkageTerms: { ...cascade.linkageTerms, algorithm: "psi-c" as const },
  };
  const bound = webrtcFrameReceiveCharge(minimumPsiSetFrameBytes(100));

  expect(() => assertFirstRoundFitsWebRtcFrame(cascade, bound)).toThrow(
    WebRtcFrameLimitError,
  );
  expect(() => assertFirstRoundFitsWebRtcFrame(countOnly, bound)).toThrow(
    fanOutReachedMatchingRefusal().message,
  );
});

/**
 * `prepared` reading its one field from `rowCount` rows, each of which throws
 * `failure` when read.
 */
function withThrowingRows(
  prepared: ReturnType<typeof preparedWith>,
  rowCount: number,
  failure: Error,
) {
  const rows = new Proxy<Array<CSVRow>>([], {
    get: (target, prop, receiver) => {
      if (prop === "length") return rowCount;
      if (typeof prop === "string" && /^[0-9]+$/.test(prop)) throw failure;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  const field = new StandardizedField("firstName", "first_name", [], rows);
  return {
    ...prepared,
    dataset: new StandardizedDataset(
      [field],
      prepared.linkageTerms.linkageKeys,
    ),
    rowCount,
  };
}

test("the first-round check refuses, with the failure as its cause, when the count throws", () => {
  const rowCount = 50;
  const prepared = preparedWith(
    Array.from({ length: rowCount }, (_unused, i) => letters(i)),
  );
  const failure = new RangeError("Map maximum size exceeded");
  let refusal: unknown;
  try {
    assertFirstRoundFitsWebRtcFrame(
      withThrowingRows(prepared, rowCount, failure),
      100,
    );
  } catch (err) {
    refusal = err;
  }
  expect(refusal).toBeInstanceOf(WebRtcFrameLimitError);
  expect((refusal as WebRtcFrameLimitError).setOwner).toBe("local");
  expect((refusal as Error).message).toBe(ROUND_ONE_SET_UNCOUNTED_MESSAGE);
  expect((refusal as Error).cause).toBe(failure);
});

test("the first-round check raises a refusal the count throws in both roles as it is", () => {
  const rowCount = 50;
  const prepared = preparedWith(
    Array.from({ length: rowCount }, (_unused, i) => letters(i)),
  );
  const refusal = new UsageError("a refusal the round would raise");
  expect(() =>
    assertFirstRoundFitsWebRtcFrame(
      withThrowingRows(prepared, rowCount, refusal),
      100,
    ),
  ).toThrow(refusal);
});

afterEach(() => vi.restoreAllMocks());

test("the first-round check reports no row, so each row's warning comes once, from the round", () => {
  // Two split elements: a row realizing 21 x 20 candidates is dropped from the
  // round, one realizing 21 x 1 is kept and warned as wide.
  const split = [{ function: "split_on", params: { delimiter: " " } }];
  const parts = (row: string, count: number) =>
    Array.from({ length: count }, (_unused, i) =>
      `${row}x${letters(i)}`.padEnd(8, "z"),
    ).join(" ");
  const prepared = prepareForExchange(
    {
      linkageTerms: {
        version: "1.0.0",
        date: "2026-01-01",
        algorithm: "psi",
        deduplicate: false,
        linkageStrategy: "cascade",
        identity: "Tester",
        output: { expectsOutput: true, shareWithPartner: true },
        linkageFields: [
          { name: "lastName", type: "last_name" },
          { name: "firstName", type: "first_name" },
        ],
        linkageKeys: [
          {
            name: "names",
            elements: [
              { field: "lastName", transform: split },
              { field: "firstName", transform: split },
            ],
          },
        ],
      },
    },
    "Tester",
    [
      { last_name: parts("dropped", 21), first_name: parts("dropped", 20) },
      { last_name: parts("wide", 21), first_name: "zqsole" },
      { last_name: "zqplain", first_name: "zqplain" },
    ],
    ["last_name", "first_name"],
  );
  const warn = vi
    .spyOn(getLogger("cleaning"), "warn")
    .mockImplementation(() => {});
  const rowLines = () =>
    warn.mock.calls
      .map(([line]) => String(line))
      .filter((line) => /^row \d+, key "names"/.test(line));

  // A bound the dataset's ceiling crosses, so the check reads the rows, and
  // the set the round sends fits.
  expect(() =>
    assertFirstRoundFitsWebRtcFrame(
      prepared,
      webrtcFrameReceiveCharge(minimumPsiSetFrameBytes(100)),
    ),
  ).not.toThrow();
  expect(rowLines()).toEqual([]);

  const [key] = prepared.linkageTerms.linkageKeys;
  const firstRound = new StandardizedKeyIterable(
    key,
    prepared.dataset,
    prepared.rowCount,
    false,
    0,
  );
  expect(Array.from(firstRound)[0]).toBeUndefined();
  firstRound.closeRowReporting();
  const lines = rowLines();
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^row 0, key "names": .*contributes no value/);
  expect(lines[1]).toMatch(/^row 1, key "names": cross-product produced 21 /);
});

test("the first-round check refuses, with the failure as its cause, when the receiver-role count throws", () => {
  const rowCount = 50;
  const prepared = preparedWith(
    Array.from({ length: rowCount }, (_unused, i) => letters(i)),
  );
  // The field cache holds each row once read, so the receiver-role pass fails
  // at its collection of the key's values instead of at a row.
  const failure = new RangeError("Invalid array length");
  const arrayFrom = Array.from.bind(Array);
  let keyPasses = 0;
  vi.spyOn(Array, "from").mockImplementation(((
    source: Iterable<unknown> | ArrayLike<unknown>,
    ...rest: Array<unknown>
  ) => {
    if (source instanceof StandardizedKeyIterable && ++keyPasses === 2)
      throw failure;
    return (arrayFrom as (...args: Array<unknown>) => Array<unknown>)(
      source,
      ...rest,
    );
  }) as typeof Array.from);
  let refusal: unknown;
  try {
    assertFirstRoundFitsWebRtcFrame(prepared, 100);
  } catch (err) {
    refusal = err;
  }
  expect(keyPasses).toBe(2);
  expect(refusal).toBeInstanceOf(WebRtcFrameLimitError);
  expect((refusal as WebRtcFrameLimitError).setOwner).toBe("local");
  expect((refusal as Error).message).toBe(ROUND_ONE_SET_UNCOUNTED_MESSAGE);
  expect((refusal as Error).cause).toBe(failure);
});
