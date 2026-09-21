import type { Client as PSIClient } from "@openmined/psi.js/implementation/client.d.ts";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { Server as PSIServer } from "@openmined/psi.js/implementation/server.d.ts";

import { markNamedDiagnosis } from "../errors";
import {
  buildRequest,
  buildResponse,
  chunkRangesOfSize,
  concatChunkElements,
  mergeAssociationChunks,
  mergeResponseChunks,
  mergeSetupChunks,
  psiChunkRanges,
  serializeRequest,
  serializeResponse,
  serializeSetup,
} from "./psiChunks";

import type { PsiChunkRange } from "./psiChunks";
import type { Config } from "../types";

// The deserialized server setup the joiner holds between receiving it and matching
// against it (see PsiEngine.receiveServerSetup and the match that consumes it). A live
// library object, so it never crosses a worker boundary -- which is exactly why the
// engine, not its caller, holds it.
type DeserializedServerSetup = ReturnType<
  PSILibrary["serverSetup"]["deserializeBinary"]
>;

/**
 * Which disclosure a {@link PsiEngine} is built for.
 *
 * - `identifier-revealing` -- the `psi` construction: the round resolves to
 *   matched positions and an association table.
 * - `count-only` -- the psi-c construction (docs/spec/PROTOCOL.md, PSI-C): the
 *   round resolves to the intersection cardinality alone, and the operations that
 *   would name the matches refuse.
 *
 * The mode is fixed when the engine is constructed, never chosen per call: it is
 * the library's reveal-intersection flag, which rides the receiver's request and
 * which the sender enforces agreement on, so it is a property of the round both
 * parties ran rather than a local preference.
 */
export type PsiEngineMode = "identifier-revealing" | "count-only";

// Every mode decision in the engine derives from this one test, so an engine has
// exactly two states and never a hybrid third. TypeScript does not reach a JS caller
// of the published package, which can pass a string outside PsiEngineMode; deriving
// each decision here puts any such value wholly on the count-only side -- the
// nondisclosing one -- rather than clearing the reveal flag while leaving the
// contribution filter and the sorting permutation set for `psi`.
function modeRevealsIdentifiers(mode: PsiEngineMode): boolean {
  return mode === "identifier-revealing";
}

// Names an engine's mode back from that one boolean, so a refusal reports one of the
// two states rather than echoing whatever string constructed the engine.
function modeName(revealsIdentifiers: boolean): PsiEngineMode {
  return revealsIdentifiers ? "identifier-revealing" : "count-only";
}

// Every refusal the engine raises itself, as against a failure raised inside
// the PSI library: each states the condition it refused on, so the frame
// boundary above raises it unchanged rather than re-labeling it a decode
// failure (decodePsiBinaryFrame, psi/psiBinaryFrame.ts). Routing every throw
// through one constructor keeps a raise site from being added untagged.
function engineRefusal(message: string): Error {
  return markNamedDiagnosis(new Error(message));
}

/**
 * @internal
 *
 * The values a party contributes to a count-only round: those occurring
 * EXACTLY ONCE in its own dataset, in input order. Every occurrence of a
 * repeated value is dropped, not just the later ones -- an ambiguous match
 * cannot be attributed to a single record.
 *
 * Normative for psi-c (docs/spec/PROTOCOL.md, PSI-C), and not a filter the
 * library applies: its cardinality operation reports the size of the
 * MULTISET intersection, where a value repeated on both sides contributes
 * the smaller of the two multiplicities. A count-only round shows no
 * identifier that would contradict such a figure, so the filter is applied
 * here, at the point that owns the contribution, rather than left to a
 * caller.
 */
export function valuesContributedExactlyOnce(
  values: ReadonlyArray<string>,
): Array<string> {
  const occurrences = new Map<string, number>();
  for (const value of values)
    occurrences.set(value, (occurrences.get(value) ?? 0) + 1);
  return values.filter((value) => occurrences.get(value) === 1);
}

/**
 * Takes the running count of elements the operation now in flight has finished
 * masking or matching. Reported between chunks and never after the last one,
 * so the figure is always short of the operation's own element count, which
 * its settle report states. A count and nothing else crosses this boundary: no
 * element, no value, no index.
 */
export type PsiProcessedElementsReporter = (processed: number) => void;

/**
 * The CPU-bound PSI crypto core behind {@link ./participant.PSIParticipant}.
 * It owns the library's stateful `server` / `client` objects -- and thus
 * the secret key -- and performs the deserialize + elliptic-curve masking +
 * serialize for each protocol step, taking raw bytes / value lists and
 * returning raw bytes / index lists.
 *
 * The whole interface is bytes-in / bytes-out (or value-list-in) by design:
 * nothing that crosses it is a live library handle, so a worker-hosted
 * implementation can stand behind the same interface without the caller
 * changing. The one piece of cross-call state -- the joiner's deserialized
 * setup between {@link receiveServerSetup} and the match that consumes it
 * -- lives INSIDE the engine for the same reason: it cannot cross a worker
 * boundary, so the engine holds it rather than handing it back.
 *
 * The host-side, pre-deserialize element-count guards stay above this
 * boundary, in {@link ./participant.PSIParticipant}, which runs them on the
 * raw wire bytes before dispatching here, so the engine only ever
 * deserializes an already-bounded frame.
 *
 * An engine is built for exactly one {@link PsiEngineMode}, and the
 * operations of the other mode refuse rather than return: which disclosure
 * a round produces is fixed with the key it is produced under, not chosen
 * when the result is read.
 */
export interface PsiEngine {
  /**
   * Encrypts this party's values once under the server key, returning the
   * serialized setup message and the sorting permutation (see
   * {@link ./participant.PSIParticipant.createServerSetup}). Server role.
   *
   * A count-only engine contributes only the values occurring exactly once in
   * `values` and returns an EMPTY permutation: that round has no pairing to map
   * back to rows, and the library's permutation indexes the filtered contribution
   * rather than `values`, so it is not a correspondence a caller could use.
   */
  createServerSetup(
    values: ReadonlyArray<string>,
  ): Promise<{ setup: Uint8Array; permutation: Array<number> }>;
  /**
   * Doubly-encrypts a deserialized-from-`requestBytes` client request under the
   * server key, returning the serialized response. Server role.
   */
  processClientRequest(requestBytes: Uint8Array): Promise<Uint8Array>;
  /**
   * Encrypts this party's values once under the client key. Client role. A
   * count-only engine contributes only the values occurring exactly once in
   * `values`, and the request holds its cleared reveal flag, which the
   * partner's server enforces agreement on.
   */
  createClientRequest(values: ReadonlyArray<string>): Promise<Uint8Array>;
  /**
   * Deserializes the partner's server setup, verifies it is a Raw data structure,
   * and holds it for the match the engine's mode allows --
   * {@link computeAssociationTable} or {@link computeIntersectionCardinality}.
   * Client role.
   * Split from the match so the joiner can validate the setup the instant it
   * arrives (a fail-fast before it sends its own request), while the response it
   * matches against arrives a round trip later.
   */
  receiveServerSetup(setupBytes: Uint8Array): Promise<void>;
  /**
   * Removes this party's encryption layer from the partner's doubly-encrypted
   * response (deserialized from `responseBytes`) and compares it against the setup
   * held by the preceding {@link receiveServerSetup}, returning
   * `[localIndices, partnerIndices]`. Client role; throws if no setup is held.
   * Identifier-revealing mode only: a count-only engine refuses instead of
   * returning a pairing.
   */
  computeAssociationTable(
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]>;
  /**
   * Removes this party's encryption layer from the partner's doubly-encrypted
   * response and reports the SIZE of the intersection against the setup held by the
   * preceding {@link receiveServerSetup} -- no identifier, no pairing, no matched
   * position. Client role; throws if no setup is held. Count-only mode only: an
   * identifier-revealing engine refuses, so the disclosure a round produces stays
   * the one its key was created for.
   */
  computeIntersectionCardinality(responseBytes: Uint8Array): Promise<number>;
  /**
   * Register `report`, taking the running processed-element count while an
   * operation above is in flight. Optional: an engine that reports nothing
   * omits it, and the participant then shows an operation's element count and
   * elapsed time alone. One sink at a time -- a second registration replaces
   * the first.
   */
  observeProcessedElements?(report: PsiProcessedElementsReporter): void;
  /**
   * Release engine resources. The in-process engine frees the library's server /
   * client objects -- embind wrappers over WASM-heap C++ state, including the
   * generated secret key, which JS garbage collection does NOT reclaim (only their
   * explicit `delete()` does) -- bounding the key's lifetime to the exchange; the
   * worker-backed engine terminates its worker (which frees that state with the
   * whole isolate). Terminal: no other method may be called after dispose().
   */
  dispose(): void;
}

/** @internal Settings only a test varies. */
export interface InProcessPsiEngineOptions {
  /**
   * @internal
   *
   * The chunk size each operation splits at, in place of the measured policy
   * in psiChunks.ts. The byte-identity suite sets it so the chunked path runs
   * over a set a unit test can afford, where the policy would take one chunk.
   */
  readonly chunkElements?: number;
}

// The false-positive rate and client-input count every setup message is built
// with. Both are what selects the Raw data structure the protocol sends and
// accepts: a rate of 0 admits no false positive, and -1 leaves the library to
// size the structure from the inputs it was handed.
const SETUP_FALSE_POSITIVE_RATE = 0.0;
const SETUP_CLIENT_INPUT_COUNT = -1;

/**
 * The default {@link PsiEngine}: runs the crypto synchronously on the
 * calling thread, wrapping the injected {@link PSILibrary}, extracted
 * behind the interface so a worker-backed engine can replace it without
 * disturbing {@link ./participant.PSIParticipant} or its callers. The
 * browser and every test use it directly; the CLI wraps a worker-backed
 * engine around the same per-thread logic.
 *
 * Each operation over a set large enough to split runs as a sequence of
 * chunks, reporting the running processed count between them, so a display has
 * a figure that moves through an operation the library would otherwise run as
 * one call lasting minutes. The chunk results reassemble into the bytes the
 * single call produces (psiChunks.ts states the merge rules and the sizing
 * policy); a set at or below the chunk floor takes one chunk and runs the
 * single call unchanged.
 */
export class InProcessPsiEngine implements PsiEngine {
  private readonly library: PSILibrary;
  private readonly id: string;
  private readonly revealsIdentifiers: boolean;
  private readonly server?: PSIServer;
  private readonly client?: PSIClient;
  // The joiner's deserialized setup, held between receiveServerSetup and the match
  // that consumes it. Undefined outside that window.
  private pendingSetup: DeserializedServerSetup | undefined;
  // Latched by dispose() so freeing the library objects is idempotent: their
  // embind delete() is not safe to call twice.
  private disposed = false;
  // The sink the running processed count goes to, undefined while nothing
  // watches (see observeProcessedElements).
  private onProcessed: PsiProcessedElementsReporter | undefined;
  private readonly chunkElements: number | undefined;

  constructor(
    library: PSILibrary,
    role: Config["role"],
    id: string,
    // Fixed here rather than per call: the reveal flag it sets is generated
    // into the key objects below and rides the request on the wire, so a
    // round's disclosure is fixed together with its key. Required rather
    // than defaulted, because a default is a disclosure a caller can reach
    // by forgetting: a revealing round run under count-only terms is the
    // substitution the mode exists to prevent.
    mode: PsiEngineMode,
    options: InProcessPsiEngineOptions = {},
  ) {
    this.library = library;
    this.id = id;
    this.revealsIdentifiers = modeRevealsIdentifiers(mode);
    this.chunkElements = options.chunkElements;
    // Generate the fresh secret key for this exchange, held inside the
    // library's server / client object. An unresolved ("either") role
    // creates neither; the role-guarded methods below then reject.
    if (role === "starter") {
      this.server = library.server!.createWithNewKey(this.revealsIdentifiers);
    } else if (role === "joiner") {
      this.client = library.client!.createWithNewKey(this.revealsIdentifiers);
    }
  }

  observeProcessedElements(report: PsiProcessedElementsReporter): void {
    this.onProcessed = report;
  }

  // How one operation over `total` elements is split: the measured policy,
  // unless a test set a chunk size of its own.
  private rangesFor(total: number): PsiChunkRange[] {
    return this.chunkElements === undefined
      ? psiChunkRanges(total)
      : chunkRangesOfSize(total, this.chunkElements);
  }

  // Runs `maskChunk` over each range in turn, reporting the running processed
  // count BETWEEN chunks -- never after the last, whose figure is the one the
  // operation's own settle report states.
  private overChunks<T>(
    ranges: ReadonlyArray<PsiChunkRange>,
    maskChunk: (range: PsiChunkRange) => T,
  ): Array<T> {
    const results: Array<T> = [];
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index]!;
      results.push(maskChunk(range));
      if (index < ranges.length - 1) this.onProcessed?.(range.end);
    }
    return results;
  }

  // One chunk's masked setup. The Raw check reads back what the call above
  // asked for: without it, a setup that is not Raw reaches the merge as an
  // absent element list and fails as a type error rather than a named
  // condition.
  private maskSetupChunk(
    server: PSIServer,
    values: ReadonlyArray<string>,
  ): { elements: Array<Uint8Array>; permutation: Array<number> } {
    const permutation: Array<number> = [];
    const setup = server.createSetupMessage(
      SETUP_FALSE_POSITIVE_RATE,
      SETUP_CLIENT_INPUT_COUNT,
      values,
      this.library.dataStructure.Raw,
      permutation,
    );
    const raw = setup.getRaw();
    if (!raw)
      throw engineRefusal(
        `${this.id}: the PSI library returned a server setup that is not a Raw data structure`,
      );
    return { elements: raw.getEncryptedElementsList_asU8(), permutation };
  }

  createServerSetup(
    values: ReadonlyArray<string>,
  ): Promise<{ setup: Uint8Array; permutation: Array<number> }> {
    const server = this.server;
    if (!server)
      throw engineRefusal(
        `${this.id}: createServerSetup requires the server role`,
      );
    const countOnly = !this.revealsIdentifiers;
    const contributed = countOnly
      ? valuesContributedExactlyOnce(values)
      : values;
    const ranges = this.rangesFor(contributed.length);
    // One chunk is the single call this operation has always been: the
    // library's own message goes out as it serialized it, with no element list
    // materialized beside it and no merge to reproduce its sort.
    if (ranges.length === 1) {
      const sortingPermutation: Array<number> = [];
      const setup = server.createSetupMessage(
        SETUP_FALSE_POSITIVE_RATE,
        SETUP_CLIENT_INPUT_COUNT,
        contributed,
        this.library.dataStructure.Raw,
        sortingPermutation,
      );
      return Promise.resolve({
        setup: setup.serializeBinary(),
        permutation: countOnly ? [] : sortingPermutation,
      });
    }
    const merged = mergeSetupChunks(
      this.overChunks(ranges, (range) => ({
        start: range.start,
        ...this.maskSetupChunk(
          server,
          contributed.slice(range.start, range.end),
        ),
      })),
    );
    return Promise.resolve({
      setup: serializeSetup(this.library, merged.elements),
      permutation: countOnly ? [] : merged.permutation,
    });
  }

  processClientRequest(requestBytes: Uint8Array): Promise<Uint8Array> {
    const server = this.server;
    if (!server)
      throw engineRefusal(
        `${this.id}: processClientRequest requires the server role`,
      );
    const request = this.library.request.deserializeBinary(requestBytes);
    // The reveal flag rides the request, and the library refuses to serve a
    // request whose flag disagrees with the key this server was created
    // under -- the wire-enforced mode agreement (docs/spec/PROTOCOL.md,
    // PSI-C). Read the flag and name the condition here: the native addon
    // names it, but the WebAssembly build reports the same refusal as an
    // opaque embind marshalling error, indistinguishable from a malformed
    // frame. Fixed literals only: the request is partner-supplied.
    if (request.getRevealIntersection() !== this.revealsIdentifiers)
      throw engineRefusal(
        `${this.id} protocol error: the partner's PSI request ran the ` +
          `${modeName(request.getRevealIntersection())} mode, where this ` +
          `exchange runs ${modeName(this.revealsIdentifiers)}`,
      );
    const ranges = this.rangesFor(request.getEncryptedElementsList().length);
    // One chunk is the single call: the partner's request is re-encrypted as
    // the library deserialized it, so nothing materializes its element list.
    if (ranges.length === 1)
      return Promise.resolve(server.processRequest(request).serializeBinary());
    const inbound = request.getEncryptedElementsList_asU8();
    const masked = this.overChunks(ranges, (range) =>
      server
        .processRequest(
          buildRequest(
            this.library,
            inbound.slice(range.start, range.end),
            this.revealsIdentifiers,
          ),
        )
        .getEncryptedElementsList_asU8(),
    );
    return Promise.resolve(
      serializeResponse(
        this.library,
        mergeResponseChunks(masked, this.revealsIdentifiers),
      ),
    );
  }

  createClientRequest(values: ReadonlyArray<string>): Promise<Uint8Array> {
    const client = this.client;
    if (!client)
      throw engineRefusal(
        `${this.id}: createClientRequest requires the client role`,
      );
    const contributed = this.revealsIdentifiers
      ? values
      : valuesContributedExactlyOnce(values);
    const ranges = this.rangesFor(contributed.length);
    if (ranges.length === 1)
      return Promise.resolve(
        client.createRequest(contributed).serializeBinary(),
      );
    const masked = this.overChunks(ranges, (range) =>
      client
        .createRequest(contributed.slice(range.start, range.end))
        .getEncryptedElementsList_asU8(),
    );
    return Promise.resolve(
      serializeRequest(
        this.library,
        concatChunkElements(masked),
        this.revealsIdentifiers,
      ),
    );
  }

  receiveServerSetup(setupBytes: Uint8Array): Promise<void> {
    const setup = this.library.serverSetup.deserializeBinary(setupBytes);
    // This protocol only ever sends a Raw server setup (createSetupMessage
    // with dataStructure.Raw), so a received setup whose data-structure
    // oneof is anything other than Raw -- or is unset -- is malformed:
    // getRaw() reads undefined, and the reveal-intersection path requires
    // Raw and aborts on it with a cryptic library error. Reject it here as
    // a clean protocol abort. (A non-Raw setup holds a single bounded byte
    // blob, not a repeated element list, so this is a correctness /
    // fail-closed guard, not a memory bound -- the pre-deserialize element
    // scan in PSIParticipant already bounded the setup's allocation.)
    if (!setup.getRaw())
      throw engineRefusal(
        `${this.id} protocol error: PSI server setup is not a Raw data structure`,
      );
    this.pendingSetup = setup;
    return Promise.resolve();
  }

  // The client role, the mode, and the held setup each operation below requires,
  // checked in that order so a call the engine's construction rules out is refused
  // by name here rather than deep in the library -- which reports the same
  // condition as an opaque marshalling error on the WebAssembly build.
  private beginMatch(
    operation: string,
    requiredMode: PsiEngineMode,
  ): { client: PSIClient; setup: DeserializedServerSetup } {
    const client = this.client;
    if (!client)
      throw engineRefusal(`${this.id}: ${operation} requires the client role`);
    if (this.revealsIdentifiers !== modeRevealsIdentifiers(requiredMode))
      throw engineRefusal(
        `${this.id}: ${operation} requires a ${requiredMode} PSI engine; this one is ${modeName(this.revealsIdentifiers)}`,
      );
    const setup = this.pendingSetup;
    if (setup === undefined)
      throw engineRefusal(
        `${this.id}: ${operation} called before receiveServerSetup`,
      );
    this.pendingSetup = undefined;
    return { client, setup };
  }

  computeAssociationTable(
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]> {
    const { client, setup } = this.beginMatch(
      "computeAssociationTable",
      "identifier-revealing",
    );
    const response = this.library.response.deserializeBinary(responseBytes);
    const ranges = this.rangesFor(response.getEncryptedElementsList().length);
    if (ranges.length === 1) {
      const table = client.getAssociationTable(setup, response);
      return Promise.resolve([table[0], table[1]]);
    }
    const elements = response.getEncryptedElementsList_asU8();
    return Promise.resolve(
      mergeAssociationChunks(
        this.overChunks(ranges, (range) => {
          const table = client.getAssociationTable(
            setup,
            buildResponse(this.library, elements.slice(range.start, range.end)),
          );
          return {
            start: range.start,
            localIndices: table[0]!,
            partnerIndices: table[1]!,
          };
        }),
      ),
    );
  }

  computeIntersectionCardinality(responseBytes: Uint8Array): Promise<number> {
    const { client, setup } = this.beginMatch(
      "computeIntersectionCardinality",
      "count-only",
    );
    const response = this.library.response.deserializeBinary(responseBytes);
    const ranges = this.rangesFor(response.getEncryptedElementsList().length);
    if (ranges.length === 1)
      return Promise.resolve(client.getIntersectionSize(setup, response));
    const elements = response.getEncryptedElementsList_asU8();
    // Each response element is matched against the held setup on its own, and
    // a count-only round contributes values occurring exactly once, so no
    // element can be counted under two chunks and the chunk sizes add up.
    const sizes = this.overChunks(ranges, (range) =>
      client.getIntersectionSize(
        setup,
        buildResponse(this.library, elements.slice(range.start, range.end)),
      ),
    );
    return Promise.resolve(sizes.reduce((total, size) => total + size, 0));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingSetup = undefined;
    // Free the WASM-heap C++ state behind the embind server / client wrappers --
    // including the generated secret key -- which JS GC does not reclaim. dispose()
    // is terminal (the participant is not used past it; see exchange.ts), so no
    // later call can touch the freed objects, and the disposed guard above keeps a
    // repeated dispose() from a double delete().
    this.server?.delete();
    this.client?.delete();
  }
}
