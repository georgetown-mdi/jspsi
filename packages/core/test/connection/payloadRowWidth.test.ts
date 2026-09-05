import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../../src/exchange";
import {
  ConnectionError,
  createMessagePipe,
} from "../../src/connection/messageConnection";

import type { MessageConnection } from "../../src/connection/messageConnection";
import type { PreparedExchange } from "../../src/exchange";
import type { Output } from "../../src/config/linkageTermsSchema";

// A payload row must supply exactly one value per named column, or the
// record's readable governance list and its committed values fall out of
// sync. These tests drive a full `psi` run so the refusal is shown landing
// before the output or record stage, on the lazy receive path, where
// reconciliation itself does not refuse. Parse-level cases are in
// payloadExchange.test.ts.

const psiLibrary = await PSI();

const both: Output = { expectsOutput: true, shareWithPartner: true };

const firstNameTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "cascade" as const,
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

// The receiving party holds a linkage column only, so it discloses nothing of its
// own and every payload assertion below is about what it RECEIVED.
const receiverRows = [
  { first_name: "Carol" },
  { first_name: "Elizabeth" },
  { first_name: "Henry" },
];
const receiverColumns = ["first_name"];

// `diagnosis` is neither a linkage nor a PII alias, so inferMetadata marks it
// transmitted and the honest run below includes it.
const senderRows = [
  { first_name: "Alice", diagnosis: "A-hypertension" },
  { first_name: "Carol", diagnosis: "C-diabetes" },
  { first_name: "Elizabeth", diagnosis: "E-asthma" },
];
const senderColumns = ["first_name", "diagnosis"];

function prepared(
  identity: string,
  rows: Array<Record<string, string>>,
  columns: Array<string>,
): PreparedExchange {
  const exchange = prepareForExchange(
    { linkageTerms: { ...firstNameTerms, identity, output: both } },
    identity,
    rows,
    columns,
  );
  // No payload block and no persisted commitment: the receive side is lazy, so
  // reconcileReceivedPayload takes whatever arrives and the wire schema is the
  // only thing standing between a forged frame and the record.
  expect(exchange.expectedPayloadColumns).toBeUndefined();
  return exchange;
}

/** Swap this party's outbound payload frame for `forged`, leaving every other
 * message of the exchange untouched. */
function withForgedPayload(
  conn: MessageConnection,
  forged: unknown,
): MessageConnection {
  return {
    send: (data) =>
      conn.send(
        typeof data === "object" && data !== null && "hasData" in data
          ? forged
          : data,
      ),
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}

test("a run receiving an honest payload frame records the columns whose values it committed", async () => {
  const [connReceiver, connSender] = createMessagePipe();

  const [receiverOutcome, senderOutcome] = await Promise.allSettled([
    runExchange(
      connReceiver,
      "initiator",
      prepared("Receiver Co", receiverRows, receiverColumns),
      {
        psiLibrary,
      },
    ),
    runExchange(
      connSender,
      "responder",
      prepared("Sender Co", senderRows, senderColumns),
      {
        psiLibrary,
      },
    ),
  ]);

  // Rethrow rather than assert a status, so a regression reports the refusal it
  // introduced instead of a bare "fulfilled" mismatch.
  if (receiverOutcome.status === "rejected") throw receiverOutcome.reason;
  if (senderOutcome.status === "rejected") throw senderOutcome.reason;

  const received = receiverOutcome.value.partnerPayload;
  expect(received.columns).toEqual(["diagnosis"]);
  expect(received.rows).toEqual([["C-diabetes"], ["E-asthma"]]);

  // The two halves of the record agree: every value the committed payload binds
  // sits under a column the readable list names.
  const record = receiverOutcome.value.audit?.record;
  expect(
    record?.governance.payloadReceived.map((column) => column.name),
  ).toEqual(["diagnosis"]);
});

test("a run receiving a columnless frame that holds rows is refused before its output or record stage", async () => {
  const [connReceiver, connSenderRaw] = createMessagePipe();
  // One value per matched record, against no column at all. Accepting it would
  // commit those values while the record's readable received-column list read
  // empty.
  const connSender = withForgedPayload(connSenderRaw, {
    hasData: true,
    columns: [],
    rowIndices: [1, 2],
    rows: [["C-diabetes"], ["E-asthma"]],
  });

  const [receiverOutcome] = await Promise.allSettled([
    runExchange(
      connReceiver,
      "initiator",
      prepared("Receiver Co", receiverRows, receiverColumns),
      {
        psiLibrary,
      },
    ),
    runExchange(
      connSender,
      "responder",
      prepared("Sender Co", senderRows, senderColumns),
      {
        psiLibrary,
      },
    ),
  ]);

  // The receiving party's whole run rejects, so it produces no result table, no
  // partner payload, and no record -- the refusal is the exchange's outcome
  // rather than something a later stage has to compensate for.
  expect(receiverOutcome.status).toBe("rejected");
  const refusal =
    receiverOutcome.status === "rejected" ? receiverOutcome.reason : undefined;
  expect(refusal).toBeInstanceOf(ConnectionError);
  expect((refusal as ConnectionError).kind).toBe("protocol");
  expect(String((refusal as ConnectionError).cause)).toMatch(
    /each payload row must have one value per declared column/,
  );
});
