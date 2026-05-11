import { Readable } from "node:stream";

import { expect, test } from "vitest";
import PSI from "@openmined/psi.js";
import log from "loglevel";

import { getMetadataAndLinkageKeys } from "../src/linkageKeys";
import { PSIParticipant } from "../src/participant";
import { linkViaPSI } from "../src/link";

import { PassthroughConnection } from "./utils/passthroughConnection";

import type { LinkageKeyDefinition } from "../src/types";

const formatters = {
  ssn: (x: unknown) =>
    typeof x === "string" && x ? x.replaceAll("-", "") : "",
  first_name: (x: unknown) =>
    typeof x === "string" && x ? x.toUpperCase() : "",
  last_name: (x: unknown) =>
    typeof x === "string" && x ? x.toUpperCase() : "",
  date_of_birth: (x: unknown) =>
    x instanceof Date && !isNaN(x.getDate())
      ? x.toISOString().substring(0, 10)
      : "",
};

const linkageKeyDefinitions: Array<LinkageKeyDefinition> = [
  [
    {
      outputFieldName: "ssn",
      inputFieldName: "ssn",
      formatter: formatters["ssn"],
    },
    {
      outputFieldName: "last_name",
      inputFieldName: "lastName",
      formatter: formatters["last_name"],
    },
    {
      outputFieldName: "date_of_birth",
      inputFieldName: "dateOfBirth",
      formatter: formatters["date_of_birth"],
    },
  ],
  [
    {
      outputFieldName: "ssn",
      inputFieldName: "ssn",
      formatter: formatters["ssn"],
    },
    {
      outputFieldName: "last_name",
      inputFieldName: "lastName",
      formatter: formatters["last_name"],
    },
    {
      outputFieldName: "first_name_1",
      inputFieldName: "firstName",
      formatter: (x) => formatters["first_name"](x).substring(0, 1),
    },
  ],
];

const psiLibrary = await PSI();

const serverConn = new PassthroughConnection();
const clientConn = new PassthroughConnection(serverConn);
serverConn.setOther(clientConn);

const server = new PSIParticipant("server", psiLibrary, {
  role: "starter",
  verbose: -1,
});

const client = new PSIParticipant("client", psiLibrary, {
  role: "joiner",
  verbose: -1,
});

log.setLevel("DEBUG");

test("rules match in order", async () => {
  const serverInputData = [
    ["id,first_name,last_name,ssn,date_of_birth\n"],
    ["159859483,James,Heard,559-81-1301,7/16/1975\n"],
    ["165562801,Albert,Iorio,322-84-2281,8/17/1975"],
  ];
  const serverData = await getMetadataAndLinkageKeys(
    Readable.from(serverInputData),
    linkageKeyDefinitions,
  );

  /* client input 0 matches rule 1, while input 1 matches rule 0 using rule 0
     should consume the potential client input so that it can't be used for the
     first input.
   */

  const clientInputData = [
    ["id,first_name,last_name,ssn,date_of_birth\n"],
    ["159859483,Jim,Heard,559-81-1301,7/17/1975\n"], // wrong dob
    ["159859483,Jim,Heard,559-81-1301,7/16/1975\n"],
    ["165562801,Albert,Iorio,322-84-2281,8/17/1976"], // wrong dob
  ];

  const clientData = await getMetadataAndLinkageKeys(
    Readable.from(clientInputData),
    linkageKeyDefinitions,
  );

  const [serverResult, clientResult] = await (async () => {
    return await Promise.all([
      linkViaPSI(
        { cardinality: "one-to-one" },
        server,
        serverConn,
        serverData.linkageKeys,
        -1,
      ),
      linkViaPSI(
        { cardinality: "one-to-one" },
        client,
        clientConn,
        clientData.linkageKeys,
        -1,
      ),
    ]);
  })();

  expect(serverResult).toEqual([
    [0, 1],
    [1, 2],
  ]);
  expect(clientResult).toEqual([
    [1, 2],
    [0, 1],
  ]);
});
