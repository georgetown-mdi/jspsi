import type { Client as PSIClient } from "@openmined/psi.js/implementation/client.d.ts";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { Server as PSIServer } from "@openmined/psi.js/implementation/server.d.ts";

import type { Config } from "./types";

// The deserialized server setup the joiner holds between receiving it and matching
// against it (see PsiEngine.receiveServerSetup / computeAssociationTable). A live
// library object, so it never crosses a worker boundary -- which is exactly why the
// engine, not its caller, holds it.
type DeserializedServerSetup = ReturnType<
  PSILibrary["serverSetup"]["deserializeBinary"]
>;

/**
 * The CPU-bound PSI crypto core behind {@link ./participant.PSIParticipant}. It
 * owns the library's stateful `server` / `client` objects -- and thus the secret
 * key -- and performs the deserialize + elliptic-curve masking + serialize for each
 * protocol step, taking raw bytes / value lists and returning raw bytes / index
 * lists.
 *
 * The whole surface is deliberately bytes-in / bytes-out (or value-list-in): nothing
 * that crosses it is a live library handle, so a worker-hosted implementation can
 * stand behind the same interface without the caller changing (board item
 * 208035324). The one piece of cross-call state -- the joiner's deserialized setup
 * between {@link receiveServerSetup} and {@link computeAssociationTable} -- lives
 * INSIDE the engine for the same reason: the deserialized setup cannot cross a
 * worker boundary, so the engine holds it rather than handing it back.
 *
 * The host-side, pre-deserialize element-count guards stay ABOVE this seam in
 * {@link ./participant.PSIParticipant}, which runs them on the raw wire bytes before
 * dispatching here, so the engine only ever deserializes an already-bounded frame.
 */
export interface PsiEngine {
  /**
   * Encrypts this party's values once under the server key, returning the
   * serialized setup message and the sorting permutation (see
   * {@link ./participant.PSIParticipant.createServerSetup}). Server role.
   */
  createServerSetup(
    values: ReadonlyArray<string>,
  ): Promise<{ setup: Uint8Array; permutation: Array<number> }>;
  /**
   * Doubly-encrypts a deserialized-from-`requestBytes` client request under the
   * server key, returning the serialized response. Server role.
   */
  processClientRequest(requestBytes: Uint8Array): Promise<Uint8Array>;
  /** Encrypts this party's values once under the client key. Client role. */
  createClientRequest(values: ReadonlyArray<string>): Promise<Uint8Array>;
  /**
   * Deserializes the partner's server setup, verifies it is a Raw data structure,
   * and holds it for the matching {@link computeAssociationTable}. Client role.
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
   */
  computeAssociationTable(
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]>;
  /**
   * Release engine resources. A no-op for the in-process engine (the library
   * objects are garbage-collected); the worker-backed engine terminates its worker.
   */
  dispose(): void;
}

/**
 * The default {@link PsiEngine}: runs the crypto synchronously on the calling
 * thread, wrapping the injected {@link PSILibrary}. This is today's behavior,
 * extracted behind the interface so a worker-backed engine can replace it without
 * disturbing {@link ./participant.PSIParticipant} or its callers. The browser and
 * every test use it directly; the CLI wraps a worker-backed engine around the same
 * per-thread logic.
 */
export class InProcessPsiEngine implements PsiEngine {
  private readonly library: PSILibrary;
  private readonly id: string;
  private readonly server?: PSIServer;
  private readonly client?: PSIClient;
  // The joiner's deserialized setup, held between receiveServerSetup and the
  // computeAssociationTable that consumes it. Undefined outside that window.
  private pendingSetup: DeserializedServerSetup | undefined;

  constructor(library: PSILibrary, role: Config["role"], id: string) {
    this.library = library;
    this.id = id;
    // Generate the fresh secret key for this exchange, held inside the library's
    // server / client object. An unresolved ("either") role creates neither; the
    // role-guarded methods below then reject, exactly as before this extraction.
    if (role === "starter") {
      this.server = library.server!.createWithNewKey(true);
    } else if (role === "joiner") {
      this.client = library.client!.createWithNewKey(true);
    }
  }

  createServerSetup(
    values: ReadonlyArray<string>,
  ): Promise<{ setup: Uint8Array; permutation: Array<number> }> {
    const server = this.server;
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
    return Promise.resolve({ setup: setup.serializeBinary(), permutation });
  }

  processClientRequest(requestBytes: Uint8Array): Promise<Uint8Array> {
    const server = this.server;
    if (!server)
      throw new Error(
        `${this.id}: processClientRequest requires the server role`,
      );
    const request = this.library.request.deserializeBinary(requestBytes);
    return Promise.resolve(server.processRequest(request).serializeBinary());
  }

  createClientRequest(values: ReadonlyArray<string>): Promise<Uint8Array> {
    const client = this.client;
    if (!client)
      throw new Error(
        `${this.id}: createClientRequest requires the client role`,
      );
    return Promise.resolve(client.createRequest(values).serializeBinary());
  }

  receiveServerSetup(setupBytes: Uint8Array): Promise<void> {
    const setup = this.library.serverSetup.deserializeBinary(setupBytes);
    // This protocol only ever sends a Raw server setup (createSetupMessage with
    // dataStructure.Raw), so a received setup whose data-structure oneof is anything
    // other than Raw -- or is unset -- is malformed: getRaw() reads undefined, and
    // the reveal-intersection path requires Raw and aborts on it with a cryptic
    // library error. Reject it here as a clean protocol abort. (The pre-deserialize
    // element scan in PSIParticipant already bounded the setup's allocation; a
    // non-Raw setup carries a single bounded byte blob, not a repeated element list,
    // so it does not amplify -- this is a correctness / fail-closed guard, not a
    // memory bound.)
    if (!setup.getRaw())
      throw new Error(
        `${this.id} protocol error: PSI server setup is not a Raw data structure`,
      );
    this.pendingSetup = setup;
    return Promise.resolve();
  }

  computeAssociationTable(
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]> {
    const client = this.client;
    if (!client)
      throw new Error(
        `${this.id}: computeValueMatches requires the client role`,
      );
    const setup = this.pendingSetup;
    if (setup === undefined)
      throw new Error(
        `${this.id}: computeAssociationTable called before receiveServerSetup`,
      );
    this.pendingSetup = undefined;
    const response = this.library.response.deserializeBinary(responseBytes);
    const table = client.getAssociationTable(setup, response);
    return Promise.resolve([table[0], table[1]]);
  }

  dispose(): void {
    this.pendingSetup = undefined;
  }
}
