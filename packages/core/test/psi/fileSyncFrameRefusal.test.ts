import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  AEAD_ENVELOPE_OVERHEAD_BYTES,
  EncryptedMessageConnection,
} from "../../src/connection/encryptedMessageConnection";
import {
  MESSAGE_HEADER_BYTES,
  MESSAGE_TYPE_BINARY,
  serializeFileSyncMessage,
} from "../../src/connection/fileSyncFraming";
import { MAX_FRAME_SIZE_BYTES } from "../../src/connection/frameSize";
import { createMessagePipe } from "../../src/connection/messageConnection";
import {
  PSI_ENCODED_ELEMENT_BYTES,
  PSI_SET_MAX_FRAMING_BYTES,
} from "../../src/connection/webrtcOutboundBound";
import { RoundSetLimitError, UsageError } from "../../src/errors";
import {
  assertFirstRoundFitsFileSyncFrame,
  fileSyncMaxRoundSetValues,
  fileSyncRoundOneSetTooLargeMessage,
  prepareForExchange,
} from "../../src/exchange";
import {
  MAX_ROUND_DISTINCT_VALUES,
  roundDistinctValueLimitRefusal,
} from "../../src/psi/link";
import { serializeRequest, serializeSetup } from "../../src/psi/psiChunks";
import { sanitizeErrorForDisplay } from "../../src/utils/sanitizeErrorForDisplay";
import { DISPLAY_TRUNCATION_MARKER } from "../../src/utils/sanitizeForDisplay";
import {
  StandardizedDataset,
  StandardizedField,
} from "../../src/standardization";

import type { LinkageStrategy } from "../../src/config/linkageTermsSchema";
import type { CSVRow } from "../../src/file";

// The SFTP and synced-folder first-round check reads the prepared dataset,
// before any connection. The frame bound is lowered so the boundary is reached
// with a few hundred values.

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

// The most bytes a first-round message file of `values` values takes.
const boundFor = (values: number) =>
  MESSAGE_HEADER_BYTES +
  AEAD_ENVELOPE_OVERHEAD_BYTES +
  PSI_SET_MAX_FRAMING_BYTES +
  values * PSI_ENCODED_ELEMENT_BYTES;

test("the real bound holds fewer values than one round's deduplication", () => {
  const ceiling = fileSyncMaxRoundSetValues();
  expect(ceiling).toBe(15_339_166);
  expect(boundFor(ceiling)).toBeLessThanOrEqual(MAX_FRAME_SIZE_BYTES);
  expect(boundFor(ceiling + 1)).toBeGreaterThan(MAX_FRAME_SIZE_BYTES);
  expect(ceiling).toBeLessThan(MAX_ROUND_DISTINCT_VALUES);
  expect(fileSyncMaxRoundSetValues(boundFor(300))).toBe(300);
  expect(fileSyncMaxRoundSetValues(boundFor(300) - 1)).toBe(299);
});

const psiLibrary = await PSI();

/** The message file the encrypting connection writes for `payload`. */
async function encryptedMessageFile(payload: Uint8Array): Promise<Buffer> {
  const [local, peer] = createMessagePipe();
  const sender = await EncryptedMessageConnection.create(
    local,
    new Uint8Array(32).fill(0x42),
    "initiator",
  );
  await sender.send(payload);
  const envelope = (await peer.receive()) as Uint8Array;
  return serializeFileSyncMessage(MESSAGE_TYPE_BINARY, 1, envelope);
}

test("a first-round file at the ceiling fits the frame bound the check applies", async () => {
  const values = 300;
  const bound = boundFor(values);
  expect(fileSyncMaxRoundSetValues(bound)).toBe(values);
  const elements = Array.from({ length: values }, () =>
    new Uint8Array(PSI_ENCODED_ELEMENT_BYTES - 2).fill(7),
  );
  for (const message of [
    serializeSetup(psiLibrary, elements),
    serializeRequest(psiLibrary, elements, true),
  ]) {
    const file = await encryptedMessageFile(message);
    expect(file.length).toBeLessThanOrEqual(bound);
  }
});

test("the check refuses one value over the bound and admits one under and at it", () => {
  // 300 values held by one record each, beside 40 records sharing 20 values:
  // the round drops a shared value, so 300 is the count the check weighs.
  const unique = Array.from({ length: 301 }, (_unused, i) => letters(i));
  const shared = Array.from({ length: 20 }, (_unused, i) => letters(1000 + i));
  const rows = (uniqueCount: number) => [
    ...unique.slice(0, uniqueCount),
    ...shared,
    ...shared,
  ];
  const bound = boundFor(300);

  expect(() =>
    assertFirstRoundFitsFileSyncFrame(preparedWith(rows(299)), bound),
  ).not.toThrow();
  expect(() =>
    assertFirstRoundFitsFileSyncFrame(preparedWith(rows(300)), bound),
  ).not.toThrow();
  let refusal: unknown;
  try {
    assertFirstRoundFitsFileSyncFrame(preparedWith(rows(301)), bound);
  } catch (err) {
    refusal = err;
  }
  expect(refusal).toBeInstanceOf(RoundSetLimitError);
  expect((refusal as RoundSetLimitError).alcoveRecoveryHintEmitted).toBe(true);
  expect((refusal as Error).message).toMatch(
    /SFTP or a synced folder: .*at least 301 values to send, over the 300 one message file holds\. Nothing was sent\. Split the input/,
  );
});

test("the check leaves a single-pass exchange to its dataset ceiling", () => {
  const rows = Array.from({ length: 50 }, (_unused, i) => letters(i));
  expect(() =>
    assertFirstRoundFitsFileSyncFrame(
      preparedWith(rows, "single-pass"),
      boundFor(10),
    ),
  ).not.toThrow();
  expect(() =>
    assertFirstRoundFitsFileSyncFrame(preparedWith(rows), boundFor(10)),
  ).toThrow(RoundSetLimitError);
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

test("the check refuses, with the failure as its cause, when the count throws", () => {
  const rowCount = 50;
  const prepared = preparedWith(
    Array.from({ length: rowCount }, (_unused, i) => letters(i)),
  );
  const failure = new RangeError("out of memory");
  let refusal: unknown;
  try {
    assertFirstRoundFitsFileSyncFrame(
      withThrowingRows(prepared, rowCount, failure),
      boundFor(10),
    );
  } catch (err) {
    refusal = err;
  }
  expect(refusal).toBeInstanceOf(RoundSetLimitError);
  expect((refusal as Error).message).toMatch(
    /could not count .* one message file\. Nothing was sent\./,
  );
  expect((refusal as Error).cause).toBe(failure);
});

test("the check raises a refusal the count throws in both roles as it is", () => {
  const rowCount = 50;
  const prepared = preparedWith(
    Array.from({ length: rowCount }, (_unused, i) => letters(i)),
  );
  const refusal = new UsageError("a refusal the round would raise");
  expect(() =>
    assertFirstRoundFitsFileSyncFrame(
      withThrowingRows(prepared, rowCount, refusal),
      boundFor(10),
    ),
  ).toThrow(refusal);
});

test("each refusal survives the display boundary whole at the real bound", () => {
  // The remedy is the last sentence, and the render boundary truncates a link,
  // so a message that grows past it loses the part the operator acts on.
  for (const refusal of [
    new RoundSetLimitError(
      fileSyncRoundOneSetTooLargeMessage(MAX_ROUND_DISTINCT_VALUES * 10),
    ),
    roundDistinctValueLimitRefusal(MAX_ROUND_DISTINCT_VALUES),
  ]) {
    const shown = sanitizeErrorForDisplay(refusal);
    expect(shown).not.toContain(DISPLAY_TRUNCATION_MARKER);
    expect(shown).toContain(
      "Split the input into smaller files and run one exchange for each.",
    );
  }
});
