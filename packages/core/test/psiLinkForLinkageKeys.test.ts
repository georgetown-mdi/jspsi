import { expect, test } from "vitest";
import PSI from "@openmined/psi.js";
import log from "loglevel";

import {
  buildStandardizedDataset,
  StandardizedKeyIterable,
} from "../src/standardization";
import { PSIParticipant } from "../src/participant";
import { linkViaPSI } from "../src/link";
import type { LinkageTerms } from "../src/config/linkageTerms";
import type { ColumnMetadata } from "../src/config/metadata";

import { createMessagePipe } from "../src/connection/messageConnection";
import { UNBOUNDED_PSI_ELEMENTS } from "./utils/psiElementBounds";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const metadata: ColumnMetadata[] = [
  { name: "id", type: "identifier", role: "identifier", isPayload: false },
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  {
    name: "date_of_birth",
    type: "date_of_birth",
    role: "linkage",
    isPayload: false,
  },
];

// Two keys: SSN+LN+DOB (precise), then SSN+LN1+FN1 (looser). This replicates
// the cascade tested in the original psiLinkForLinkageKeys.test.ts.
const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "test",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    { name: "lastName", type: "last_name" },
    { name: "firstName", type: "first_name" },
    { name: "dateOfBirth", type: "date_of_birth" },
  ],
  linkageKeys: [
    {
      name: "SSN + LN + DOB",
      elements: [
        { field: "ssn" },
        { field: "lastName" },
        { field: "dateOfBirth" },
      ],
    },
    {
      name: "SSN + LN1 + FN1",
      elements: [
        { field: "ssn" },
        {
          field: "lastName",
          transform: [
            { function: "substring", params: { start: 1, length: 1 } },
          ],
        },
        {
          field: "firstName",
          transform: [
            { function: "substring", params: { start: 1, length: 1 } },
          ],
        },
      ],
    },
  ],
};

function makeIterables(
  rawRows: ReadonlyArray<Record<string, string>>,
  isReceiver = false,
): StandardizedKeyIterable[] {
  const dataset = buildStandardizedDataset(undefined, rawRows, metadata, terms);
  return terms.linkageKeys.map(
    (key) =>
      new StandardizedKeyIterable(key, dataset, rawRows.length, isReceiver),
  );
}

// ─── PSI participants ─────────────────────────────────────────────────────────

const psiLibrary = await PSI();

const [serverConn, clientConn] = createMessagePipe();

const server = new PSIParticipant(
  "server",
  psiLibrary,
  { role: "starter", verbose: -1 },
  UNBOUNDED_PSI_ELEMENTS,
);
const client = new PSIParticipant(
  "client",
  psiLibrary,
  { role: "joiner", verbose: -1 },
  UNBOUNDED_PSI_ELEMENTS,
);

log.setLevel("DEBUG");

// ─── Tests ────────────────────────────────────────────────────────────────────

test("rules match in order", async () => {
  // Data is pre-cleaned: SSNs without dashes, DOBs in YYYYMMDD.
  const serverRows = [
    {
      id: "159859483",
      first_name: "James",
      last_name: "HEARD",
      ssn: "559811301",
      date_of_birth: "19750716",
    },
    {
      id: "165562801",
      first_name: "Albert",
      last_name: "IORIO",
      ssn: "322842281",
      date_of_birth: "19750817",
    },
  ];

  // Client row 0 matches only by key 2 (SSN+LN1+FN1, wrong DOB).
  // Client row 1 matches by key 1 (SSN+LN+DOB, exact match).
  // Client row 2 matches only by key 2 (SSN+LN1+FN1, wrong DOB) — same SSN as
  // server row 0, but key 1 consumed that server record already.
  const clientRows = [
    {
      id: "159859483",
      first_name: "Jim",
      last_name: "HEARD",
      ssn: "559811301",
      date_of_birth: "19750717",
    }, // wrong DOB
    {
      id: "159859483",
      first_name: "Jim",
      last_name: "HEARD",
      ssn: "559811301",
      date_of_birth: "19750716",
    },
    {
      id: "165562801",
      first_name: "Albert",
      last_name: "IORIO",
      ssn: "322842281",
      date_of_birth: "19750818",
    }, // wrong DOB
  ];

  const serverKeys = makeIterables(serverRows);
  const clientKeys = makeIterables(clientRows);

  const [serverResult, clientResult] = await Promise.all([
    linkViaPSI(
      { cardinality: "one-to-one" },
      server,
      serverConn,
      serverKeys,
      -1,
    ),
    linkViaPSI(
      { cardinality: "one-to-one" },
      client,
      clientConn,
      clientKeys,
      -1,
    ),
  ]);

  expect(serverResult).toEqual([
    [0, 1],
    [1, 2],
  ]);
  expect(clientResult).toEqual([
    [1, 2],
    [0, 1],
  ]);
});
