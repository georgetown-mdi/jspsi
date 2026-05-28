import * as z from "zod";

import type { AssociationTable, Config, Connection } from "./types";

import type { Client as PSIClient } from "@openmined/psi.js/implementation/client.d.ts";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { Server as PSIServer } from "@openmined/psi.js/implementation/server.d.ts";

import { getLoggerForVerbosity } from "./utils/logger";
import { runReceiveSequence } from "./utils/receiveSequence";
import type { ServerSetup } from "@openmined/psi.js/implementation/proto/psi_pb";

const statusCompletedMessage = z.object({
  status: z.literal("completed"),
});

const numberArrayMessage = z.array(z.number());
const associationTableMessage = z.array(z.array(z.number()));

const DEFAULT_VERBOSITY = 1;

export enum ProcessState {
  BeforeStart,
  Waiting,
  Working,
  Done,
}

function defineProtocol<
  const T extends Array<{ id: string; label: string; state: ProcessState }>,
>(stages: T) {
  return stages;
}
type ProtocolStageId<T extends Array<{ id: string }>> = T[number]["id"];

export const starterProtocolStages = defineProtocol([
  {
    id: "sending startup message",
    label: "Sending my encrypted data",
    state: ProcessState.Working,
  },
  {
    id: "waiting for client request",
    label: "Waiting for partner's encrypted data",
    state: ProcessState.Working,
  },
  {
    id: "processing client request",
    label: "Doubly-encrypting partner's data",
    state: ProcessState.Working,
  },
  {
    id: "sending response",
    label: "Sending partner's doubly-encrypted data",
    state: ProcessState.Working,
  },
  {
    id: "waiting for association table",
    label: "Waiting for shared elements",
    state: ProcessState.Working,
  },
  {
    id: "processing association table",
    label: "Cleaning result",
    state: ProcessState.Working,
  },
  { id: "done", label: "Done", state: ProcessState.Done },
] as const);

export const joinerProtocolStages = defineProtocol([
  {
    id: "waiting for startup message",
    label: "Waiting for partner's encrypted data",
    state: ProcessState.Working,
  },
  {
    id: "processing startup message",
    label: "Encrypting my data",
    state: ProcessState.Working,
  },
  {
    id: "sending client request",
    label: "Sending my encrypted data",
    state: ProcessState.Working,
  },
  {
    id: "waiting for response",
    label: "Waiting for my doubly-encrypted data",
    state: ProcessState.Working,
  },
  {
    id: "creating association table",
    label: "Identifying shared elements",
    state: ProcessState.Working,
  },
  {
    id: "sending association table",
    label: "Sending results",
    state: ProcessState.Working,
  },
  {
    id: "waiting for permutation",
    label: "Waiting for clean result",
    state: ProcessState.Working,
  },
  { id: "done", label: "Done", state: ProcessState.Done },
] as const);

type StarterProtocolStageId = ProtocolStageId<typeof starterProtocolStages>;
type JoinerProtocolStageId = ProtocolStageId<typeof joinerProtocolStages>;

type ProtocolId = StarterProtocolStageId | JoinerProtocolStageId;

export class PSIParticipant {
  id: string;
  private library: PSILibrary;
  config: Config;
  private setStage: (id: ProtocolId) => void;
  private stages:
    | typeof joinerProtocolStages
    | typeof starterProtocolStages
    | undefined;
  private log: ReturnType<typeof getLoggerForVerbosity>;

  private psi: { server?: PSIServer; client?: PSIClient } = {};

  constructor(
    id: string,
    library: PSILibrary,
    config: Config,
    setStage?: (id: ProtocolId) => void,
  ) {
    this.id = id;
    this.library = library;
    this.config = config;
    this.setStage = setStage ? setStage : () => {};

    if (this.config.verbose === undefined) {
      this.config.verbose = DEFAULT_VERBOSITY;
    }

    this.log = getLoggerForVerbosity("participant", this.config.verbose);

    if (this.config.role === "starter") {
      this.psi.server = library.server!.createWithNewKey(true);
    } else if (this.config.role === "joiner") {
      this.psi.client = library.client!.createWithNewKey(true);
    }

    this.setStages();
  }

  private setStages() {
    if (this.config.role === "starter") {
      this.stages = starterProtocolStages;
    } else {
      this.stages = joinerProtocolStages;
    }
  }

  getStages() {
    return this.stages;
  }

  /**
   * Returns an association table with elements [localIndices, partnerIndices]
   */
  public async identifyIntersection(
    conn: Connection,
    set: Array<string>,
  ): Promise<AssociationTable> {
    if (this.config.role === "starter") {
      const sortingPermutation: Array<number> = [];

      const serverSetup = this.psi.server!.createSetupMessage(
        0.0,
        -1,
        set,
        this.library.dataStructure.Raw,
        sortingPermutation,
      );

      let result: [Array<number>, Array<number>] | undefined;

      this.log.debug(
        `${this.id}: starting identify-intersection protocol; sending server ` +
          " data encrypted by server",
      );
      this.setStage("sending startup message");

      await runReceiveSequence(
        conn,
        [
          async (rawData: unknown) => {
            this.log.debug(
              `${this.id}: received client data encrypted by client`,
            );
            this.setStage("processing client request");

            const clientRequest = this.library.request.deserializeBinary(
              rawData as Uint8Array,
            );
            const serverResponse = this.psi
              .server!.processRequest(clientRequest)
              .serializeBinary();

            this.log.debug(
              `${this.id}: sending client data encrypted by both server ` +
                "and client",
            );
            this.setStage("sending response");

            await conn.send(serverResponse);

            this.setStage("waiting for association table");
          },
          async (rawData: unknown) => {
            this.log.debug(`${this.id}: received association table`);
            this.setStage("processing association table");
            // note: what we receive is backwards, so this is correct
            const [partnerIndices, localIndices] =
              associationTableMessage.parse(rawData);

            result = [localIndices, partnerIndices] as [Array<number>, Array<number>];
            for (let i = 0; i < result[0].length; ++i) {
              result[0][i] = sortingPermutation[result[0][i]];
            }

            this.log.debug(`${this.id}: sending my original indices`);
            await conn.send(result[0]);

            this.log.debug(`${this.id}: waiting for status completed`);
          },
          (rawData: unknown) => {
            statusCompletedMessage.parse(rawData);
            this.setStage("done");
          },
        ],
        async () => {
          await conn.send(serverSetup.serializeBinary());
          this.setStage("waiting for client request");
        },
      );

      if (result === undefined)
        throw new Error("invariant: PSI result was not set by handlers");
      return result;
    } else {
      let serverSetup: ServerSetup | undefined = undefined;
      let localIndices: Array<number> | undefined;
      let partnerIndices: Array<number> | undefined;

      this.setStage("waiting for startup message");
      this.log.debug(`${this.id}: starting identify-intersection protocol`);

      await runReceiveSequence(conn, [
        async (rawData: unknown) => {
          this.log.debug(
            `${this.id}: receiving server data encrypted by server`,
          );
          this.setStage("processing startup message");

          serverSetup = this.library.serverSetup.deserializeBinary(
            rawData as Uint8Array,
          );

          const clientRequest = this.psi.client!.createRequest(set);

          this.log.debug(`${this.id}: sending client data encrypted by client`);
          this.setStage("sending client request");

          await conn.send(clientRequest.serializeBinary());

          this.setStage("waiting for response");
        },
        async (rawData: unknown) => {
          this.log.debug(
            `${this.id}: receiving server data encrypted by both by server ` +
              "and client",
          );
          this.setStage("creating association table");

          const serverResponse = this.library.response.deserializeBinary(
            rawData as Uint8Array,
          );
          /**
           * Association table is indices into client data mapped to the
           * indices given by the server (which are likely permuted).
           */
          const associationTable: Array<Array<number>> =
            this.psi.client!.getAssociationTable(serverSetup!, serverResponse);
          localIndices = associationTable[0];

          this.log.debug(
            `${this.id}: sending association table with permuted server ` +
              "indices",
          );
          this.setStage("sending association table");

          await conn.send(associationTable);

          this.setStage("waiting for permutation");
        },
        async (rawData: unknown) => {
          this.log.debug(`${this.id}: receiving original server indices`);
          this.setStage("done");

          partnerIndices = numberArrayMessage.parse(rawData);

          // The "completed" status is a courtesy ack so the starter stops
          // waiting; we already hold our result, so failure to deliver it must
          // not fail our side.
          this.log.debug(`${this.id}: sending status completed`);
          try {
            await conn.send({ status: "completed" });
          } catch (err) {
            this.log.debug(
              `${this.id}: best-effort status-completed send failed:`,
              err,
            );
          }
        },
      ]);

      if (localIndices === undefined || partnerIndices === undefined)
        throw new Error("invariant: PSI result was not set by handlers");
      return [localIndices, partnerIndices] as [Array<number>, Array<number>];
    }
  }
}
