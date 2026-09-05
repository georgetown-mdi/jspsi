import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { removeDuplicatesAndUndefineds } from "../../src/psi/link";
import {
  InProcessPsiEngine,
  valuesContributedExactlyOnce,
  type PsiEngine,
  type PsiEngineMode,
} from "../../src/psi/psiEngine";
import {
  WorkerPsiEngine,
  servePsiWorker,
  type PsiWorkerHandle,
  type PsiWorkerResponse,
} from "../../src/psi/psiWorkerEngine";
import type { Config } from "../../src/types";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";

// The count-only (psi-c) construction at the PsiEngine boundary: a round
// resolving to the intersection cardinality and nothing that names a match.
// Tested properties are the normative rows of docs/spec/PROTOCOL.md, PSI-C;
// countOnlyRun.test.ts drives the exchange built on it. A library refusal is
// asserted generically since WASM reports an opaque marshalling error where
// the native addon names it (docs/notes/psi-c-count-only.md), except the mode
// mismatch, which the engine names itself off the request.

const wasm = await PSI();

// undefined when no prebuild ships for this platform (the backend-parity tests
// below skip); a broken addon throws through and fails rather than skipping.
const native: PSILibrary | undefined = await loadNativeAddonOrSkip();

const senderValues = [
  "Alice",
  "Bob",
  "Carol",
  "David",
  "Elizabeth",
  "Frank",
  "Greta",
];
const receiverValues = ["Carol", "Elizabeth", "Henry"];
// Carol (sender 2 / receiver 0) and Elizabeth (sender 4 / receiver 1) intersect.
const expectedCount = 2;

// Carol repeats within each party's own dataset, so both sides drop it entirely and
// only Dana is contributed by both.
const duplicatingSenderValues = ["Carol", "Carol", "Bob", "Dana"];
const duplicatingReceiverValues = ["Carol", "Carol", "Carol", "Dana", "Henry"];

// Carol repeats only in the sender's own dataset here, so this vector fails if the
// sender's own uniqueness filter is skipped: an unfiltered sender still contributes
// Carol twice, and the library's cardinality operation sums min(senderCount,
// receiverCount) per matched value -- min(2, 1) for Carol plus min(1, 1) for Dana --
// inflating the reported count to 2 instead of 1.
const senderOnlyDuplicateSenderValues = ["Carol", "Carol", "Dana"];
const senderOnlyDuplicateReceiverValues = ["Carol", "Dana"];

type EngineFactory = (
  library: PSILibrary,
  role: Config["role"],
  id: string,
  mode: PsiEngineMode,
) => PsiEngine;

const inProcess: EngineFactory = (library, role, id, mode) =>
  new InProcessPsiEngine(library, role, id, mode);

// The worker boundary driven through an in-process dispatcher, as
// psiWorkerEngine.test.ts drives it: structuredClone here is what a real
// worker's postMessage does, so a mode or a count that could not cross it
// fails here.
const workerBacked: EngineFactory = (library, role, id, mode) => {
  let deliver: (response: PsiWorkerResponse) => void = () => {};
  const dispatch = servePsiWorker(library, { role, id, mode }, (response) =>
    deliver(structuredClone(response)),
  );
  const handle: PsiWorkerHandle = {
    postMessage: (request) => dispatch(structuredClone(request)),
    setHandlers: ({ onMessage }) => {
      deliver = onMessage;
    },
    terminate: () => {},
  };
  return new WorkerPsiEngine(handle);
};

// A rejected promise whether the engine throws synchronously (the in-process role,
// mode, and state guards) or rejects (everything that crosses the worker boundary),
// so a refusal assertion reads the same for both flavors.
const settled = <T>(call: () => Promise<T>): Promise<T> =>
  Promise.resolve().then(call);

const ascending = (indices: ReadonlyArray<number>): Array<number> =>
  [...indices].sort((a, b) => a - b);

// The three frames of the count-only round, in the order PROTOCOL.md gives them:
// the sender's setup, the receiver's request, the sender's response.
async function runCountOnlyRound(
  sender: PsiEngine,
  receiver: PsiEngine,
  senderInputs: ReadonlyArray<string>,
  receiverInputs: ReadonlyArray<string>,
): Promise<number> {
  const { setup } = await sender.createServerSetup(senderInputs);
  await receiver.receiveServerSetup(setup);
  const request = await receiver.createClientRequest(receiverInputs);
  const response = await sender.processClientRequest(request);
  return receiver.computeIntersectionCardinality(response);
}

const mismatchedOrientations: Array<[PsiEngineMode, PsiEngineMode]> = [
  ["count-only", "identifier-revealing"],
  ["identifier-revealing", "count-only"],
];

describe.each([
  { name: "in-process", create: inProcess },
  { name: "worker-backed", create: workerBacked },
])("count-only $name engines", ({ create }) => {
  const sender = (mode: PsiEngineMode): PsiEngine =>
    create(wasm, "starter", "sender", mode);
  const receiver = (mode: PsiEngineMode): PsiEngine =>
    create(wasm, "joiner", "receiver", mode);

  test("a completed round yields the intersection cardinality", async () => {
    const countOnlySender = sender("count-only");
    const countOnlyReceiver = receiver("count-only");

    await expect(
      runCountOnlyRound(
        countOnlySender,
        countOnlyReceiver,
        senderValues,
        receiverValues,
      ),
    ).resolves.toBe(expectedCount);

    countOnlySender.dispose();
    countOnlyReceiver.dispose();
  });

  test("the count covers the values each side holds exactly once", async () => {
    const countOnlySender = sender("count-only");
    const countOnlyReceiver = receiver("count-only");

    await expect(
      runCountOnlyRound(
        countOnlySender,
        countOnlyReceiver,
        duplicatingSenderValues,
        duplicatingReceiverValues,
      ),
    ).resolves.toBe(1);

    countOnlySender.dispose();
    countOnlyReceiver.dispose();
  });

  test("the count reflects the sender's own filter, not only the receiver's", async () => {
    const countOnlySender = sender("count-only");
    const countOnlyReceiver = receiver("count-only");

    await expect(
      runCountOnlyRound(
        countOnlySender,
        countOnlyReceiver,
        senderOnlyDuplicateSenderValues,
        senderOnlyDuplicateReceiverValues,
      ),
    ).resolves.toBe(1);

    countOnlySender.dispose();
    countOnlyReceiver.dispose();
  });

  test("a count-only setup hands back no sorting permutation", async () => {
    const countOnlySender = sender("count-only");
    const revealingSender = sender("identifier-revealing");

    // No pairing to map back to rows, and the library's permutation indexes the
    // filtered contribution rather than the caller's values.
    const countOnly = await countOnlySender.createServerSetup(senderValues);
    expect(countOnly.permutation).toStrictEqual([]);
    // `psi` still gets the lookup its cascade replay maps matches through.
    const revealing = await revealingSender.createServerSetup(senderValues);
    expect(ascending(revealing.permutation)).toStrictEqual(
      senderValues.map((_, index) => index),
    );

    countOnlySender.dispose();
    revealingSender.dispose();
  });

  test("a count-only engine refuses to produce an association table", async () => {
    const countOnlySender = sender("count-only");
    const countOnlyReceiver = receiver("count-only");

    const { setup } = await countOnlySender.createServerSetup(senderValues);
    await countOnlyReceiver.receiveServerSetup(setup);
    const request = await countOnlyReceiver.createClientRequest(receiverValues);
    const response = await countOnlySender.processClientRequest(request);

    await expect(
      settled(() => countOnlyReceiver.computeAssociationTable(response)),
    ).rejects.toThrow();
    // The refusal is not destructive: the round still resolves to its count.
    await expect(
      countOnlyReceiver.computeIntersectionCardinality(response),
    ).resolves.toBe(expectedCount);

    countOnlySender.dispose();
    countOnlyReceiver.dispose();
  });

  test("an identifier-revealing engine refuses to report a cardinality", async () => {
    const revealingSender = sender("identifier-revealing");
    const revealingReceiver = receiver("identifier-revealing");

    const { setup, permutation } =
      await revealingSender.createServerSetup(senderValues);
    await revealingReceiver.receiveServerSetup(setup);
    const request = await revealingReceiver.createClientRequest(receiverValues);
    const response = await revealingSender.processClientRequest(request);

    await expect(
      settled(() => revealingReceiver.computeIntersectionCardinality(response)),
    ).rejects.toThrow();
    // The disclosure this engine WAS built for is still available: the matched
    // receiver rows, and the sender rows they pair with once its permutation maps
    // the library's sorted slots back to input order.
    const [localIndices, partnerIndices] =
      await revealingReceiver.computeAssociationTable(response);
    expect(ascending(localIndices)).toStrictEqual([0, 1]);
    expect(
      ascending(partnerIndices.map((slot) => permutation[slot])),
    ).toStrictEqual([2, 4]);

    revealingSender.dispose();
    revealingReceiver.dispose();
  });

  test("the response does not contain the request's element order", async () => {
    const countOnlySender = sender("count-only");
    const countOnlyReceiver = receiver("count-only");

    const request = await countOnlyReceiver.createClientRequest(receiverValues);
    const permutedRequest = wasm.request.deserializeBinary(request);
    permutedRequest.setEncryptedElementsList(
      permutedRequest.getEncryptedElementsList_asU8().reverse(),
    );
    const permutedRequestBytes = permutedRequest.serializeBinary();
    expect(permutedRequestBytes).not.toStrictEqual(request);

    // A response holding the request's order would be permuted with it. The two
    // are instead byte-identical, so no response position names a request position
    // -- and the receiver cannot re-derive the correspondence, which would take
    // encrypting its own value under the sender's key.
    const response = await countOnlySender.processClientRequest(request);
    const permutedResponse =
      await countOnlySender.processClientRequest(permutedRequestBytes);
    expect(permutedResponse).toStrictEqual(response);

    countOnlySender.dispose();
    countOnlyReceiver.dispose();
  });

  // TypeScript cannot reach a caller of the published package, who can pass a
  // string outside PsiEngineMode; both worker boundaries read their init back
  // through an unchecked cast, so a spawn site that omits the mode delivers
  // undefined, which the casts stand in for. Every mode decision derives from a
  // single boolean, so a value naming no mode must land wholly on the
  // nondisclosing side, not clear the reveal flag while leaving the contribution
  // filter or sorting permutation set for `psi`.
  const unrecognizedModes: ReadonlyArray<PsiEngineMode> = [
    "reveal-everything" as PsiEngineMode,
    undefined as unknown as PsiEngineMode,
  ];

  test.each(unrecognizedModes)(
    "an unrecognized mode (%s) is count-only in every respect",
    async (unrecognizedMode) => {
      const unrecognizedSender = create(
        wasm,
        "starter",
        "sender",
        unrecognizedMode,
      );
      const unrecognizedReceiver = create(
        wasm,
        "joiner",
        "receiver",
        unrecognizedMode,
      );
      const revealingReceiver = receiver("identifier-revealing");

      const { setup, permutation } = await unrecognizedSender.createServerSetup(
        duplicatingSenderValues,
      );
      expect(permutation).toStrictEqual([]);
      // Pins the sender's own uniqueness filter, not just the empty
      // permutation: an unfiltered setup would include all four of
      // duplicatingSenderValues instead of the two values it holds exactly
      // once.
      expect(
        wasm.serverSetup
          .deserializeBinary(setup)
          .getRaw()!
          .getEncryptedElementsList().length,
      ).toBe(valuesContributedExactlyOnce(duplicatingSenderValues).length);

      await unrecognizedReceiver.receiveServerSetup(setup);
      const request = await unrecognizedReceiver.createClientRequest(
        duplicatingReceiverValues,
      );
      const decodedRequest = wasm.request.deserializeBinary(request);
      expect(decodedRequest.getRevealIntersection()).toBe(false);
      expect(decodedRequest.getEncryptedElementsList().length).toBe(
        valuesContributedExactlyOnce(duplicatingReceiverValues).length,
      );
      // The same two observations on a `psi` request, so neither is trivially true:
      // that flag is set and every value is contributed, repeats included.
      const revealingRequest = await revealingReceiver.createClientRequest(
        duplicatingReceiverValues,
      );
      const decodedRevealingRequest =
        wasm.request.deserializeBinary(revealingRequest);
      expect(decodedRevealingRequest.getRevealIntersection()).toBe(true);
      expect(decodedRevealingRequest.getEncryptedElementsList().length).toBe(
        duplicatingReceiverValues.length,
      );

      const response = await unrecognizedSender.processClientRequest(request);
      await expect(
        settled(() => unrecognizedReceiver.computeAssociationTable(response)),
      ).rejects.toThrow();
      await expect(
        unrecognizedReceiver.computeIntersectionCardinality(response),
      ).resolves.toBe(1);

      unrecognizedSender.dispose();
      unrecognizedReceiver.dispose();
      revealingReceiver.dispose();
    },
  );

  test("a mode mismatch cannot complete a round, in either orientation", async () => {
    for (const [senderMode, receiverMode] of mismatchedOrientations) {
      const mismatchedSender = sender(senderMode);
      const mismatchedReceiver = receiver(receiverMode);

      const { setup } = await mismatchedSender.createServerSetup(senderValues);
      await mismatchedReceiver.receiveServerSetup(setup);
      const request =
        await mismatchedReceiver.createClientRequest(receiverValues);

      // The sender enforces the agreement when it processes the request: the mode
      // rides the request, so a completed round implies the two flags agreed. The
      // refusal NAMES the condition -- which mode the partner ran, and which this
      // exchange runs -- rather than passing through the library's own throw, which
      // on the WebAssembly build is an opaque marshalling error a party could not
      // tell from a malformed frame.
      await expect(
        settled(() => mismatchedSender.processClientRequest(request)),
      ).rejects.toThrow(
        new RegExp(
          `the partner's PSI request ran the ${receiverMode} mode, where ` +
            `this exchange runs ${senderMode}`,
        ),
      );

      mismatchedSender.dispose();
      mismatchedReceiver.dispose();
    }
  });
});

// The normative singleton rule -- a party contributes the values occurring exactly
// once in its own dataset, in first-appearance order -- has two implementations: the
// engine's count-only contribution filter, and the cascade's
// removeDuplicatesAndUndefineds that link.ts runs on the live `psi` path. This pins
// their agreement on the vector set below (which values survive, and in what order),
// not the cascade's extra job: undefined means "no value for this key" there, where
// the engine sees only a dense list of strings.
test("the count-only contribution filter and the cascade agree on the singleton rule", () => {
  const vectors: Array<Array<string>> = [
    [],
    ["solo"],
    ["Alice", "Bob", "Carol"],
    ["Alice", "Alice"],
    ["Alice", "Bob", "Alice"],
    ["Bob", "Alice", "Bob", "Carol", "Alice", "Dana"],
    ["Alice", "Alice", "Alice", "Bob"],
    ["", "", "Alice"],
    ["Alice", "", "Bob"],
    duplicatingSenderValues,
    duplicatingReceiverValues,
    senderValues,
  ];

  for (const values of vectors) {
    const [cascadeValues, cascadeIndices] = removeDuplicatesAndUndefineds([
      ...values,
    ]);
    expect(valuesContributedExactlyOnce(values)).toStrictEqual(cascadeValues);
    // The cascade also reports where each survivor came from; reading the input at
    // those positions must reproduce the same list, so the two agree on the
    // occurrences dropped and not merely on the multiset that survives.
    expect(cascadeIndices.map((index) => values[index])).toStrictEqual(
      cascadeValues,
    );
  }

  // The cascade's own case, outside the agreement: a key with no value drops out.
  expect(
    removeDuplicatesAndUndefineds(["Alice", undefined, "Bob", undefined]),
  ).toStrictEqual([
    ["Alice", "Bob"],
    [0, 2],
  ]);
});

test("a duplicated response does not inflate the reported cardinality", async () => {
  // The response element bound (psiElementBounds, connection/frameSize.ts)
  // upper-bounds a party's DISTINCT values (keyCount * recordCount), so it leaves room
  // for more elements when a dataset has a repeated or empty key. What refuses the
  // inflation is the vendored library's own cardinality operation, exercised here with
  // every element repeated five times: the count stays unchanged.
  const countOnlySender = inProcess(wasm, "starter", "sender", "count-only");
  const countOnlyReceiver = inProcess(wasm, "joiner", "receiver", "count-only");

  const { setup } = await countOnlySender.createServerSetup(senderValues);
  await countOnlyReceiver.receiveServerSetup(setup);
  const request = await countOnlyReceiver.createClientRequest(receiverValues);
  const response = await countOnlySender.processClientRequest(request);

  const inflated = wasm.response.deserializeBinary(response);
  const elements = inflated.getEncryptedElementsList_asU8();
  expect(elements.length).toBe(receiverValues.length);
  inflated.setEncryptedElementsList(
    Array.from({ length: 5 }, () => elements).flat(),
  );
  const inflatedBytes = inflated.serializeBinary();
  expect(
    wasm.response.deserializeBinary(inflatedBytes).getEncryptedElementsList()
      .length,
  ).toBe(receiverValues.length * 5);

  await expect(
    countOnlyReceiver.computeIntersectionCardinality(inflatedBytes),
  ).resolves.toBe(expectedCount);

  countOnlySender.dispose();
  countOnlyReceiver.dispose();
});

test("the library's cardinality operation reports the multiset size the filter excludes", () => {
  // The assumption behind the uniqueness filter, driven against the real
  // library: a raw column passed through counts a value repeated on both
  // sides once per matched pair -- three here, where the filtered round
  // yields one.
  const server = wasm.server!.createWithNewKey(false);
  const client = wasm.client!.createWithNewKey(false);
  try {
    const setup = server.createSetupMessage(
      0.0,
      -1,
      duplicatingSenderValues,
      wasm.dataStructure.Raw,
      [],
    );
    const response = server.processRequest(
      client.createRequest(duplicatingReceiverValues),
    );
    expect(client.getIntersectionSize(setup, response)).toBe(3);
  } finally {
    server.delete();
    client.delete();
  }
});

// Cross-backend parity for the mode, the way psiParticipantNativeParity.test.ts pins
// it for `psi`: the count-only round completes and agrees whichever backend each
// party runs, and the two refusals that make the mode count-only hold on the native
// addon exactly as they do on WASM. The addon is a per-platform prebuilt binary, so
// these SKIP where no prebuild ships; CI runs them on the platforms it builds.
type BackendName = "native" | "WASM";

const backendPairs: Array<{
  name: string;
  sender: BackendName;
  receiver: BackendName;
}> = [
  {
    name: "native sender and native receiver",
    sender: "native",
    receiver: "native",
  },
  {
    name: "native sender and WASM receiver",
    sender: "native",
    receiver: "WASM",
  },
  {
    name: "WASM sender and native receiver",
    sender: "WASM",
    receiver: "native",
  },
];

describe.each(backendPairs)("count-only backend parity: $name", (pair) => {
  // undefined while no native prebuild ships here, which is what the tests skip on.
  const libraries = (): [PSILibrary, PSILibrary] | undefined => {
    if (!native) return undefined;
    const resolve = (backend: BackendName): PSILibrary =>
      backend === "native" ? native : wasm;
    return [resolve(pair.sender), resolve(pair.receiver)];
  };

  test("the round yields the same cardinality", async (ctx) => {
    const resolved = libraries();
    if (!resolved) {
      ctx.skip();
      return;
    }
    const [senderLibrary, receiverLibrary] = resolved;
    const countOnlySender = inProcess(
      senderLibrary,
      "starter",
      "sender",
      "count-only",
    );
    const countOnlyReceiver = inProcess(
      receiverLibrary,
      "joiner",
      "receiver",
      "count-only",
    );

    await expect(
      runCountOnlyRound(
        countOnlySender,
        countOnlyReceiver,
        senderValues,
        receiverValues,
      ),
    ).resolves.toBe(expectedCount);

    countOnlySender.dispose();
    countOnlyReceiver.dispose();
  });

  test("the association table and a mode mismatch are refused", async (ctx) => {
    const resolved = libraries();
    if (!resolved) {
      ctx.skip();
      return;
    }
    const [senderLibrary, receiverLibrary] = resolved;
    const countOnlySender = inProcess(
      senderLibrary,
      "starter",
      "sender",
      "count-only",
    );
    const countOnlyReceiver = inProcess(
      receiverLibrary,
      "joiner",
      "receiver",
      "count-only",
    );
    const revealingReceiver = inProcess(
      receiverLibrary,
      "joiner",
      "receiver",
      "identifier-revealing",
    );

    const { setup } = await countOnlySender.createServerSetup(senderValues);
    await countOnlyReceiver.receiveServerSetup(setup);
    const request = await countOnlyReceiver.createClientRequest(receiverValues);
    const response = await countOnlySender.processClientRequest(request);

    await expect(
      settled(() => countOnlyReceiver.computeAssociationTable(response)),
    ).rejects.toThrow();

    // The refusal is pinned to the reveal flag the request holds disagreeing
    // with the one this sender's key was generated under, on EITHER backend:
    // the flag is read off the request and the condition named before the
    // library is asked, which is what makes the WebAssembly sender's
    // diagnosis as good as the addon's (the library itself reports this as
    // an opaque marshalling error there).
    const revealingRequest =
      await revealingReceiver.createClientRequest(receiverValues);
    await expect(
      settled(() => countOnlySender.processClientRequest(revealingRequest)),
    ).rejects.toThrow(
      /the partner's PSI request ran the identifier-revealing mode, where this exchange runs count-only/,
    );

    countOnlySender.dispose();
    countOnlyReceiver.dispose();
    revealingReceiver.dispose();
  });

  // The same inflation attempt pinned above for the WASM-only pair, run over this
  // pair's backends: the sender that produces the response varies, but the wire
  // bytes are decoded and re-encoded through the WASM module's protobuf codec
  // either way, exactly as the setup and request bytes already cross backends above.
  test("a duplicated response does not inflate the reported cardinality", async (ctx) => {
    const resolved = libraries();
    if (!resolved) {
      ctx.skip();
      return;
    }
    const [senderLibrary, receiverLibrary] = resolved;
    const countOnlySender = inProcess(
      senderLibrary,
      "starter",
      "sender",
      "count-only",
    );
    const countOnlyReceiver = inProcess(
      receiverLibrary,
      "joiner",
      "receiver",
      "count-only",
    );

    const { setup } = await countOnlySender.createServerSetup(senderValues);
    await countOnlyReceiver.receiveServerSetup(setup);
    const request = await countOnlyReceiver.createClientRequest(receiverValues);
    const response = await countOnlySender.processClientRequest(request);

    const inflated = wasm.response.deserializeBinary(response);
    const elements = inflated.getEncryptedElementsList_asU8();
    expect(elements.length).toBe(receiverValues.length);
    inflated.setEncryptedElementsList(
      Array.from({ length: 5 }, () => elements).flat(),
    );
    const inflatedBytes = inflated.serializeBinary();
    expect(
      wasm.response.deserializeBinary(inflatedBytes).getEncryptedElementsList()
        .length,
    ).toBe(receiverValues.length * 5);

    await expect(
      countOnlyReceiver.computeIntersectionCardinality(inflatedBytes),
    ).resolves.toBe(expectedCount);

    countOnlySender.dispose();
    countOnlyReceiver.dispose();
  });
});
