import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { PSIParticipant } from "../../src/participant";
import { linkViaPSI } from "../../src/link";

import { createMessagePipe } from "../../src/connection/messageConnection";
import { sortAssociationTable } from "./associationTable";
import { UNBOUNDED_PSI_ELEMENTS } from "./psiElementBounds";

export async function runLink(
  psiLibrary: PSILibrary,
  serverData: Array<Array<string | undefined>>,
  clientData: Array<Array<string | undefined>>,
) {
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

  const [serverResult, clientResult] = await Promise.all([
    linkViaPSI(
      { cardinality: "one-to-one" },
      server,
      serverConn,
      serverData,
      -1,
    ),
    linkViaPSI(
      { cardinality: "one-to-one" },
      client,
      clientConn,
      clientData,
      -1,
    ),
  ]);

  return {
    server: sortAssociationTable(serverResult),
    client: sortAssociationTable(clientResult, true),
  };
}
