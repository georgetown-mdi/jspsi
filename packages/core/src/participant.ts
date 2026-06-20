import * as z from "zod";

import type { AssociationTable, Config } from "./types";
import {
  receiveParsed,
  type MessageConnection,
} from "./connection/messageConnection";
import { singleIssueArray } from "./utils/singleIssueArray";

import type { Client as PSIClient } from "@openmined/psi.js/implementation/client.d.ts";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { Server as PSIServer } from "@openmined/psi.js/implementation/server.d.ts";

import { getLoggerForVerbosity } from "./utils/logger";

const statusCompletedMessage = z.object({
  status: z.literal("completed"),
});

// A single flat array parsed as the whole received message (the root). With no
// enclosing array/record/tuple frame above the root, it cannot drive the ~130k
// STACK overflow {@link associationTableMessage} faces. It is not wholly
// RangeError-free: a far larger count (~millions of invalid elements, within
// MAX_FRAME_SIZE_BYTES) makes Zod throw building the error string
// (`RangeError: Invalid string length`). Unlike the receiveParsed sites, this is
// read by a direct `.parse()` (send-before-parse, below), so that residual
// surfaces as a bare RangeError rather than a clean ConnectionError("protocol").
// Low and pre-existing (this schema is unchanged); bounding the residual flat
// arrays uniformly is a follow-on. The legitimate count is the partner's
// original-index list, bounded by MAX_FRAME_SIZE_BYTES.
const numberArrayMessage = z.array(z.number());

// CONFIRMED-EXPOSED to Zod's issue-accumulation stack overflow: a partner can
// send a tuple whose inner index array holds hundreds of thousands of invalid
// (non-number) elements, and Zod overflows its call stack spreading one issue
// per element up through the inner-array and tuple frames (RangeError reproduced
// at ~130k on Zod 4.4.3). receiveParsed already caught that harmlessly; the
// single-issue validators below turn it into a clean, bounded rejection instead.
// A count `.max()` is not an option: the association table is the PSI
// intersection, legitimately in the millions (MAX_FRAME_SIZE_BYTES bounds it),
// so any overflow-forestalling count bound would reject a real result. Each
// validator mirrors `z.number()` exactly via Number.isFinite (which, like
// z.number(), accepts every finite number and rejects NaN/Infinity and
// non-numbers). See utils/singleIssueArray.ts.
/** @internal exported for the pathological-count wire-message test. */
export const associationTableMessage = z.tuple([
  singleIssueArray<number>(
    Number.isFinite,
    "must be an array of finite numbers",
  ),
  singleIssueArray<number>(
    Number.isFinite,
    "must be an array of finite numbers",
  ),
]);

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
    conn: MessageConnection,
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

      this.log.debug(
        `${this.id}: starting identify-intersection protocol; sending server ` +
          " data encrypted by server",
      );
      this.setStage("sending startup message");
      await conn.send(serverSetup.serializeBinary());

      this.log.debug(`${this.id}: waiting for client request`);
      this.setStage("waiting for client request");

      const clientRequestRaw = await conn.receive();
      this.log.debug(`${this.id}: received client data encrypted by client`);
      this.setStage("processing client request");

      const clientRequest = this.library.request.deserializeBinary(
        clientRequestRaw as Uint8Array,
      );
      const serverResponse = this.psi
        .server!.processRequest(clientRequest)
        .serializeBinary();

      this.log.debug(
        `${this.id}: sending client data encrypted by both server and client`,
      );
      this.setStage("sending response");

      await conn.send(serverResponse);

      this.setStage("waiting for association table");

      // note: what we receive is backwards, so this is correct
      const [partnerIndices, localIndices] = await receiveParsed(
        conn,
        associationTableMessage,
      );
      this.log.debug(`${this.id}: received association table`);
      this.setStage("processing association table");

      const result: Array<Array<number>> = [localIndices, partnerIndices];
      for (let i = 0; i < result[0].length; ++i) {
        result[0][i] = sortingPermutation[result[0][i]];
      }

      this.log.debug(`${this.id}: sending my original indices`);
      await conn.send(result[0]);

      this.log.debug(`${this.id}: waiting for status completed`);
      await receiveParsed(conn, statusCompletedMessage);

      this.setStage("done");

      return [result[0], result[1]];
    } else {
      this.setStage("waiting for startup message");
      this.log.debug(`${this.id}: starting identify-intersection protocol`);

      const serverSetupRaw = await conn.receive();
      this.log.debug(`${this.id}: receiving server data encrypted by server`);
      this.setStage("processing startup message");

      const serverSetup = this.library.serverSetup.deserializeBinary(
        serverSetupRaw as Uint8Array,
      );

      const clientRequest = this.psi.client!.createRequest(set);

      this.log.debug(`${this.id}: sending client data encrypted by client`);
      this.setStage("sending client request");

      await conn.send(clientRequest.serializeBinary());

      this.setStage("waiting for response");

      const serverResponseRaw = await conn.receive();
      this.log.debug(
        `${this.id}: receiving server data encrypted by both by server and ` +
          "client",
      );
      this.setStage("creating association table");

      const serverResponse = this.library.response.deserializeBinary(
        serverResponseRaw as Uint8Array,
      );
      /**
       * Association table is indices into client data mapped to the indices
       * given by the server (which are likely permuted).
       */
      const associationTable: Array<Array<number>> =
        this.psi.client!.getAssociationTable(serverSetup, serverResponse);
      const localIndices = associationTable[0];

      this.log.debug(
        `${this.id}: sending association table with permuted server indices`,
      );
      this.setStage("sending association table");

      await conn.send(associationTable);

      this.setStage("waiting for permutation");

      // Send-before-parse: receive the partner's original indices, acknowledge
      // with status:completed, then parse. Sending the acknowledgement before
      // validating ensures a malformed final frame does not strand the partner.
      const rawData = await conn.receive();
      this.log.debug(`${this.id}: receiving original server indices`);
      this.setStage("done");

      this.log.debug(`${this.id}: sending status completed`);
      await conn.send({ status: "completed" });

      return [localIndices, numberArrayMessage.parse(rawData)];
    }
  }
}
