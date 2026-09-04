import * as z from "zod";

import type { AssociationTable, Config } from "./types";
import {
  receiveParsed,
  parseOrProtocolError,
  type MessageConnection,
} from "./connection/messageConnection";
import {
  MAX_PSI_DECODE_ELEMENTS,
  type PsiElementBounds,
} from "./connection/frameSize";
import {
  countDeclaredPsiElements,
  type PsiMessageKind,
} from "./connection/psiElementScan";
import { singleIssueArray } from "./utils/singleIssueArray";
import {
  assertPartnerIndexCount,
  assertPartnerIndices,
  assertPartnerIndexTable,
} from "./utils/partnerIndices";
import { InProcessPsiEngine, type PsiEngine } from "./psiEngine";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { getLoggerForVerbosity } from "./utils/logger";

const statusCompletedMessage = z.object({
  status: z.literal("completed"),
});

// A single flat array parsed as the whole received message (the root). With
// no enclosing array/record/tuple frame above the root, it cannot drive the
// ~130k STACK overflow {@link associationTableMessage} faces -- but a far
// larger count (~millions of invalid elements, within
// MAX_FRAME_SIZE_BYTES) makes Zod throw a DIFFERENT RangeError ("Invalid
// string length", ~3.5M on Zod 4.4.3) building its error string from one
// issue per element. The single-issue validator caps issue accumulation at
// one regardless of count (see utils/singleIssueArray.ts), so a
// pathological-count frame fails as a clean bounded rejection. A count
// `.max()` is not an option: the legitimate count is the partner's
// original-index list, in the millions, bounded only by
// MAX_FRAME_SIZE_BYTES. Number.isFinite mirrors `z.number()` exactly
// (accepts every finite number, rejects NaN/Infinity and non-numbers). This
// frame is read by a direct `.parse()` (send-before-parse, below), wrapped
// via parseOrProtocolError so even a validator throw produces a clean
// ConnectionError("protocol") rather than escaping bare.
/** @internal */
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
/** @internal */
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

/**
 * How far along one step of an exchange is, for a progress display. The list of
 * steps belongs to the surface showing it -- each labels its own stages with one
 * of these states -- so this enum is the shared vocabulary, not a stage model.
 */
export enum ProcessState {
  BeforeStart,
  Waiting,
  Working,
  Done,
}

export class PSIParticipant {
  id: string;
  config: Config;
  private log: ReturnType<typeof getLoggerForVerbosity>;
  private elementBounds: PsiElementBounds;
  private engine: PsiEngine;

  constructor(
    id: string,
    library: PSILibrary,
    config: Config,
    // Per-message caps on the encrypted-element count each inbound PSI
    // frame may declare, derived from authenticated session state (the
    // agreed key count and the two exchanged record counts; see
    // psiElementBounds in frameSize.ts) and enforced at every
    // deserializeBinary call site below. Required, not defaulted: a
    // fail-open default would silently drop the amplification guard on a
    // caller that forgot it.
    elementBounds: PsiElementBounds,
    // The crypto engine backing this participant. Defaults to an
    // in-process engine built from `library`, with the masking running on
    // the calling thread. The CLI injects a worker-backed engine so the
    // masking runs off the event-loop-owning thread; that engine holds the
    // key objects in its worker, so `library` is used only to build the
    // default.
    engine?: PsiEngine,
  ) {
    this.id = id;
    this.config = config;
    this.elementBounds = elementBounds;

    if (this.config.verbose === undefined) {
      this.config.verbose = DEFAULT_VERBOSITY;
    }

    this.log = getLoggerForVerbosity("participant", this.config.verbose);

    this.engine =
      engine ??
      new InProcessPsiEngine(
        library,
        this.config.role,
        this.id,
        "identifier-revealing",
      );
  }

  /**
   * Release the crypto engine's resources (see {@link PsiEngine.dispose}). Call at
   * exchange teardown: a no-op for the default in-process engine, but the
   * worker-backed engine terminates its worker here so the process can exit.
   */
  dispose(): void {
    this.engine.dispose();
  }

  // Reject a partner-supplied PSI frame that DECLARES more encrypted
  // elements than allowed, by scanning the protobuf wire format before
  // handing the bytes to deserializeBinary -- which allocates one heap
  // object (~211 bytes, measured) per declared repeated entry. Without a
  // pre-scan, a malicious partner could pack many minimal (~2-byte)
  // repeated entries within the frame byte cap -- declaring up to
  // ~frameBytes/2 elements -- and exhaust memory (tens of GiB) inside
  // deserializeBinary itself, before any post-deserialize count could read
  // it. The ceiling is the tighter of the authenticated
  // `keyCount * recordCount` bound (both parties compute it identically
  // from authenticated session state) and the absolute
  // {@link MAX_PSI_DECODE_ELEMENTS}, which binds a cascade frame whose
  // partner over-declares its record count. The scan stops as soon as the
  // count exceeds the ceiling, so an over-declared frame costs O(ceiling),
  // not O(frame); a malformed frame is a clean protocol abort too. See
  // connection/psiElementScan.ts.
  private assertInboundElementBound(
    kind: PsiMessageKind,
    bytes: Uint8Array,
    authenticatedBound: number,
  ): void {
    const ceiling = Math.min(authenticatedBound, MAX_PSI_DECODE_ELEMENTS);
    let declared: number;
    try {
      declared = countDeclaredPsiElements(bytes, kind, ceiling);
    } catch {
      throw new Error(
        `${this.id} protocol error: malformed inbound PSI ${kind} frame`,
      );
    }
    if (declared > ceiling)
      throw new Error(
        `${this.id} protocol error: inbound PSI ${kind} declares more than ` +
          `${ceiling} encrypted element(s)`,
      );
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
  public async createServerSetup(values: ReadonlyArray<string>): Promise<{
    setup: Uint8Array;
    permutation: Array<number>;
  }> {
    return this.engine.createServerSetup(values);
  }

  /**
   * Doubly-encrypts the partner's request under the server key, returning the
   * serialized response. Requires the `"starter"` role.
   */
  public async processClientRequest(
    requestBytes: Uint8Array,
  ): Promise<Uint8Array> {
    this.assertInboundElementBound(
      "request",
      requestBytes,
      this.elementBounds.request,
    );
    return this.engine.processClientRequest(requestBytes);
  }

  /**
   * Encrypts this party's set once under the client key, returning the serialized
   * request. Requires the `"joiner"` role.
   */
  public async createClientRequest(
    values: ReadonlyArray<string>,
  ): Promise<Uint8Array> {
    return this.engine.createClientRequest(values);
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
  public async computeValueMatches(
    setupBytes: Uint8Array,
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]> {
    await this.receiveServerSetup(setupBytes);
    return this.computeAssociationTable(responseBytes);
  }

  // Host-side element-count guard, then hand the setup to the engine to
  // deserialize, Raw-check, and hold. Split from the match (below) so the
  // cascade joiner can validate the setup the instant it arrives -- a
  // fail-fast before it sends its own request -- while the response it
  // matches against arrives a round trip later. The guard runs here, above
  // the engine boundary, so the engine only ever deserializes an
  // already-bounded frame.
  private receiveServerSetup(setupBytes: Uint8Array): Promise<void> {
    this.assertInboundElementBound(
      "serverSetup",
      setupBytes,
      this.elementBounds.setup,
    );
    return this.engine.receiveServerSetup(setupBytes);
  }

  private computeAssociationTable(
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]> {
    this.assertInboundElementBound(
      "response",
      responseBytes,
      this.elementBounds.response,
    );
    return this.engine.computeAssociationTable(responseBytes);
  }

  // The count-only leg's counterpart to the guard above: the response is
  // partner-supplied bytes the engine deserializes, so it gets the same
  // pre-deserialize element-count bound the association-table leg gets. Which of the
  // two matches runs is fixed by the engine's mode, but the amplification defense is
  // a property of the frame, not of the disclosure it resolves to.
  private computeIntersectionCardinality(
    responseBytes: Uint8Array,
  ): Promise<number> {
    this.assertInboundElementBound(
      "response",
      responseBytes,
      this.elementBounds.response,
    );
    return this.engine.computeIntersectionCardinality(responseBytes);
  }

  /**
   * Runs the count-only (psi-c) round and resolves to the intersection SIZE on the
   * receiver and to `undefined` on the sender, which computes nothing and learns
   * nothing about the count from the round (docs/spec/PROTOCOL.md, PSI-C).
   *
   * Three frames, against {@link identifyIntersection}'s five: the sender's setup,
   * the receiver's request, the sender's response. There is no association-table
   * round-trip and no completion acknowledgement, because there is no pairing for
   * the two parties to translate into each other's row space -- the round produces
   * no position either party could name.
   *
   * Requires a participant whose engine was built count-only: the identifier-
   * revealing engine refuses the cardinality operation rather than returning one, so
   * a round mis-built for the disclosure its terms agreed aborts instead of
   * resolving to the other mode's answer.
   */
  public async countIntersection(
    conn: MessageConnection,
    set: Array<string>,
  ): Promise<number | undefined> {
    if (this.config.role === "starter") {
      const { setup } = await this.createServerSetup(set);
      this.log.debug(
        `${this.id}: starting count-only protocol; sending server data ` +
          "encrypted by server",
      );
      await conn.send(setup);

      this.log.debug(`${this.id}: waiting for client request`);
      const clientRequestRaw = await conn.receive();

      const serverResponse = await this.processClientRequest(
        clientRequestRaw as Uint8Array,
      );
      this.log.debug(
        `${this.id}: sending client data encrypted by both server and client`,
      );
      await conn.send(serverResponse);

      // The sender's round ends here: it holds no count, and whether one reaches it
      // at all is the entitlement question the caller answers (see protocolSetup's
      // count-report leg), not something this round produces.
      return undefined;
    }

    this.log.debug(`${this.id}: starting count-only protocol`);
    const serverSetupRaw = await conn.receive();
    this.log.debug(`${this.id}: receiving server data encrypted by server`);
    await this.receiveServerSetup(serverSetupRaw as Uint8Array);

    const clientRequest = await this.createClientRequest(set);
    this.log.debug(`${this.id}: sending client data encrypted by client`);
    await conn.send(clientRequest);

    const serverResponseRaw = await conn.receive();
    this.log.debug(
      `${this.id}: receiving server data encrypted by both server and client`,
    );
    return this.computeIntersectionCardinality(serverResponseRaw as Uint8Array);
  }

  /**
   * Returns an association table with elements [localIndices, partnerIndices]
   */
  public async identifyIntersection(
    conn: MessageConnection,
    set: Array<string>,
  ): Promise<AssociationTable> {
    if (this.config.role === "starter") {
      const { setup, permutation } = await this.createServerSetup(set);

      this.log.debug(
        `${this.id}: starting identify-intersection protocol; sending server ` +
          " data encrypted by server",
      );
      await conn.send(setup);

      this.log.debug(`${this.id}: waiting for client request`);

      const clientRequestRaw = await conn.receive();
      this.log.debug(`${this.id}: received client data encrypted by client`);

      const serverResponse = await this.processClientRequest(
        clientRequestRaw as Uint8Array,
      );

      this.log.debug(
        `${this.id}: sending client data encrypted by both server and client`,
      );

      await conn.send(serverResponse);

      // The partner sends [theirIndices, ourIndices]; the swapped names
      // restore our-first order.
      const [partnerIndices, localIndices] = await receiveParsed(
        conn,
        associationTableMessage,
      );
      this.log.debug(`${this.id}: received association table`);

      // The round's matches, as computed by the partner: our half indexes the
      // set we just encrypted (so `permutation` bounds it exactly), the partner
      // half indexes the set it encrypted (bounded by the element count its
      // masked set may declare -- authenticated session state, since it is
      // derived from the agreed key count and the exchanged record counts). Both
      // are checked before the remap below turns our half into this party's
      // matched set for the round.
      assertPartnerIndexTable(
        this.id,
        {
          what: "the round's association table, local half",
          indices: localIndices,
          exclusiveBound: permutation.length,
        },
        {
          what: "the round's association table, partner half",
          indices: partnerIndices,
          exclusiveBound: this.elementBounds.request,
        },
      );

      for (let i = 0; i < localIndices.length; ++i) {
        localIndices[i] = permutation[localIndices[i]];
      }

      this.log.debug(`${this.id}: sending my original indices`);
      await conn.send(localIndices);

      this.log.debug(`${this.id}: waiting for status completed`);
      await receiveParsed(conn, statusCompletedMessage);

      return [localIndices, partnerIndices];
    } else {
      this.log.debug(`${this.id}: starting identify-intersection protocol`);

      const serverSetupRaw = await conn.receive();
      this.log.debug(`${this.id}: receiving server data encrypted by server`);

      // Validate and hold the server setup the instant it arrives -- a fail-fast
      // before we send our own request -- while the response we match it against
      // arrives a round trip later.
      await this.receiveServerSetup(serverSetupRaw as Uint8Array);

      const clientRequest = await this.createClientRequest(set);

      this.log.debug(`${this.id}: sending client data encrypted by client`);

      await conn.send(clientRequest);

      const serverResponseRaw = await conn.receive();
      this.log.debug(
        `${this.id}: receiving server data encrypted by both by server and ` +
          "client",
      );

      // Association table: indices into client data mapped to the (likely permuted)
      // indices given by the server, matched against the setup held above.
      const associationTable = await this.computeAssociationTable(
        serverResponseRaw as Uint8Array,
      );
      const localIndices = associationTable[0];

      this.log.debug(
        `${this.id}: sending association table with permuted server indices`,
      );

      await conn.send(associationTable);

      // Send-before-parse: receive the partner's original indices, acknowledge
      // with status:completed, then parse. Sending the acknowledgement before
      // validating ensures a malformed final frame does not strand the partner.
      const rawData = await conn.receive();
      this.log.debug(`${this.id}: receiving original server indices`);

      this.log.debug(`${this.id}: sending status completed`);
      await conn.send({ status: "completed" });

      // The partner's own matched records, in its input order: one per pair we
      // reported, each indexing the set it encrypted -- bounded by the element
      // count its masked set may declare, which is authenticated session state.
      const partnerIndices = parseOrProtocolError(numberArrayMessage, rawData);
      assertPartnerIndexCount(
        this.id,
        "the partner's original-index list",
        partnerIndices.length,
        localIndices.length,
      );
      assertPartnerIndices(
        this.id,
        "the partner's original-index list",
        partnerIndices,
        this.elementBounds.setup,
      );

      return [localIndices, partnerIndices];
    }
  }
}
