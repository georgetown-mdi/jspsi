import * as z from "zod";

import type { AssociationTable, Config } from "./types";
import {
  receiveParsed,
  parseOrProtocolError,
  type MessageConnection,
} from "./connection/messageConnection";
import type { PsiElementBounds } from "./connection/frameSize";
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
// STACK overflow {@link associationTableMessage} faces -- but a far larger count
// (~millions of invalid elements, within MAX_FRAME_SIZE_BYTES) makes Zod throw a
// DIFFERENT RangeError ("Invalid string length", ~3.5M on Zod 4.4.3) building its
// error string from one issue per element. The single-issue validator caps issue
// accumulation at one regardless of count (see utils/singleIssueArray.ts), so a
// pathological-count frame fails as a clean bounded rejection. A count `.max()`
// is not an option: the legitimate count is the partner's original-index list,
// in the millions, bounded only by MAX_FRAME_SIZE_BYTES. Number.isFinite mirrors
// `z.number()` exactly (accepts every finite number, rejects NaN/Infinity and
// non-numbers). This frame is read by a direct `.parse()` (send-before-parse,
// below), wrapped via parseOrProtocolError so even a validator throw surfaces a
// clean ConnectionError("protocol") rather than escaping bare.
/** @internal exported for the pathological-count wire-message test. */
export const numberArrayMessage = singleIssueArray<number>(
  Number.isFinite,
  "must be an array of finite numbers",
);

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

// The number of encrypted elements a deserialized PSI message declares -- the
// count that drives per-element curve-point materialization when the message is
// handed to the library (processRequest / getAssociationTable). deserializeBinary
// itself only materializes the JS byte-slice list (bounded by the frame bytes),
// so reading the count here is cheap and precedes the amplifying allocation. A Raw
// setup exposes the list on its RawInfo (pass `setup.getRaw()`); a Request or
// Response exposes it directly; a non-Raw setup (GCS/Bloom, which this protocol
// never produces) has no RawInfo and so declares no per-element list -> 0.
function declaredEncryptedElementCount(
  message:
    | { getEncryptedElementsList(): { readonly length: number } }
    | undefined,
): number {
  return message ? message.getEncryptedElementsList().length : 0;
}

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
  private elementBounds: PsiElementBounds;

  private psi: { server?: PSIServer; client?: PSIClient } = {};

  constructor(
    id: string,
    library: PSILibrary,
    config: Config,
    // Per-message caps on the encrypted-element count each inbound PSI frame may
    // declare, derived from authenticated session state (the agreed key count and
    // the two exchanged record counts; see psiElementBounds in frameSize.ts) and
    // enforced at every deserializeBinary seam below. Required, not defaulted: a
    // fail-open default would silently drop the amplification guard on a caller
    // that forgot it.
    elementBounds: PsiElementBounds,
    setStage?: (id: ProtocolId) => void,
  ) {
    this.id = id;
    this.library = library;
    this.config = config;
    this.elementBounds = elementBounds;
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

  // Reject a deserialized PSI message whose declared encrypted-element count
  // exceeds what the authenticated key and record counts permit, BEFORE the
  // element list is handed to the library and each entry becomes a curve point.
  // Without this a malicious partner could pack a setup / request / response with
  // many minimal (~2-byte) repeated entries -- within the frame byte cap, yet
  // declaring far more curve points than the cap's ~40-byte-per-value sizing
  // assumes -- and force the amplified allocation. The bound reads only
  // authenticated session state, never the inbound frame's own bytes, so it is
  // the same on both parties. Aborting here is the same clean protocol-error abort
  // the sibling count checks in link.ts use (decodeSinglePassReply, the sender
  // record-count check); it materializes nothing.
  private assertPsiElementCount(
    what: string,
    declared: number,
    maxElements: number,
  ): void {
    if (declared > maxElements) {
      throw new Error(
        `${this.id} protocol error: PSI ${what} declares ${declared} encrypted ` +
          `element(s), exceeding the authenticated bound of ${maxElements}`,
      );
    }
  }

  // Building-block PSI steps used by the single-pass strategy
  // (linkViaSinglePassPSI in link.ts). Unlike identifyIntersection below, which
  // runs the whole back-and-forth itself, single-pass calls these one at a time
  // and sequences the exchange on its own. Each wraps the underlying PSI library,
  // keeping the secret key and the library's server/client objects private to this
  // class; callers see only raw bytes and lists of indices.

  /**
   * Encrypts this party's values once under the server key, returning the
   * serialized setup message and a "permutation" -- a lookup that undoes the
   * reordering the library does internally. The library sorts the values before
   * encrypting; entry i of the lookup gives the original input position of the
   * value now in sorted slot i, so a match reported in sorted terms can be traced
   * back to the row it came from. Requires the `"starter"` role.
   */
  public createServerSetup(values: ReadonlyArray<string>): {
    setup: Uint8Array;
    permutation: Array<number>;
  } {
    const server = this.psi.server;
    if (!server)
      throw new Error(`${this.id}: createServerSetup requires the server role`);
    const permutation: Array<number> = [];
    const setup = server.createSetupMessage(
      0.0,
      -1,
      values,
      this.library.dataStructure.Raw,
      permutation,
    );
    return { setup: setup.serializeBinary(), permutation };
  }

  /**
   * Doubly-encrypts the partner's request under the server key, returning the
   * serialized response. Requires the `"starter"` role.
   */
  public processClientRequest(requestBytes: Uint8Array): Uint8Array {
    const server = this.psi.server;
    if (!server)
      throw new Error(
        `${this.id}: processClientRequest requires the server role`,
      );
    const request = this.library.request.deserializeBinary(requestBytes);
    this.assertPsiElementCount(
      "request",
      declaredEncryptedElementCount(request),
      this.elementBounds.request,
    );
    return server.processRequest(request).serializeBinary();
  }

  /**
   * Encrypts this party's set once under the client key, returning the serialized
   * request. Requires the `"joiner"` role.
   */
  public createClientRequest(values: ReadonlyArray<string>): Uint8Array {
    const client = this.psi.client;
    if (!client)
      throw new Error(
        `${this.id}: createClientRequest requires the client role`,
      );
    return client.createRequest(values).serializeBinary();
  }

  /**
   * Finishes the match for this party: removes its own encryption layer from the
   * partner's doubly-encrypted response and compares it against the partner's
   * setup, returning the list of value matches. Each pair is `[index among this
   * party's distinct values, index among the partner's values]`. WARNING: these
   * index de-duplicated VALUES, not data rows -- the cascade replay (link.ts) is
   * what turns them into record pairs. The partner's index is in the library's
   * internal sorted order; map it back to input order with the permutation from
   * {@link createServerSetup}. Requires the `"joiner"` role.
   */
  public computeValueMatches(
    setupBytes: Uint8Array,
    responseBytes: Uint8Array,
  ): [Array<number>, Array<number>] {
    const client = this.psi.client;
    if (!client)
      throw new Error(
        `${this.id}: computeValueMatches requires the client role`,
      );
    const setup = this.library.serverSetup.deserializeBinary(setupBytes);
    this.assertPsiElementCount(
      "server setup",
      declaredEncryptedElementCount(setup.getRaw()),
      this.elementBounds.setup,
    );
    const response = this.library.response.deserializeBinary(responseBytes);
    this.assertPsiElementCount(
      "response",
      declaredEncryptedElementCount(response),
      this.elementBounds.response,
    );
    const table = client.getAssociationTable(setup, response);
    return [table[0], table[1]];
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
      this.assertPsiElementCount(
        "request",
        declaredEncryptedElementCount(clientRequest),
        this.elementBounds.request,
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
      this.assertPsiElementCount(
        "server setup",
        declaredEncryptedElementCount(serverSetup.getRaw()),
        this.elementBounds.setup,
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
      this.assertPsiElementCount(
        "response",
        declaredEncryptedElementCount(serverResponse),
        this.elementBounds.response,
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

      return [localIndices, parseOrProtocolError(numberArrayMessage, rawData)];
    }
  }
}
