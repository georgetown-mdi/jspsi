// The typed view of the ssh2 / ssh2-sftp-client internals the SFTP adapter
// reaches past their public APIs, plus the feature detection that resolves
// the transport-close seams off it. Everything here is a declaration or a
// pure resolver over one internals value: no adapter state, no server round
// trip, no severity decision -- each resolver function below documents its
// own contract. Re-verify the assumptions on any ssh2 / ssh2-sftp-client
// bump per docs/spec/DEPENDENCY_PINS.md ("Upgrading the SFTP Stack").

import { REPORT_LIBRARY_INCOMPATIBILITY } from "./libraryIncompatibility";

/**
 * A single entry as ssh2's SFTPWrapper.readdir reports it. Only the fields the
 * transport consumes are typed; ssh2 supplies more (longname, the rest of
 * attrs).
 */
export interface Ssh2DirEntry {
  filename: string;
  attrs: { mtime: number; size: number };
}

/**
 * ssh2 reports SFTP failures (including end-of-directory from readdir) as an
 * Error holding the numeric SFTP status code on `code`.
 */
export type Ssh2SftpError = Error & { code?: number };

/**
 * The ssh2 Client's underlying net.Socket, which the adapter reaches directly for
 * what ssh2 does not expose. Every member is optional so a relocated or
 * non-net.Socket transport reads undefined at each site; what that site does with
 * it differs -- setKeepAlive warns and continues, the members the
 * connection-per-poll release drives are verified at connect time and fail the
 * dial (see resolveTransportCloseSeams), and the one member the terminal close
 * drives is resolved lazily and warns rather than failing a dial over a
 * teardown-only mechanism (see resolveTerminalCloseSeam).
 */
export interface Ssh2ClientSocket {
  /**
   * ssh2 exposes setNoDelay but not setKeepAlive, so connect()'s kernel TCP
   * keepalive fallback reaches the socket for it.
   */
  setKeepAlive?(enable: boolean, initialDelay: number): void;
  /**
   * Node's own half-close flags, read by the connection-per-poll release to tell
   * WHO ended the transport. `readableEnded` is true once the peer's FIN has been
   * consumed (the peer began the teardown, so what follows is a server-side drop
   * rather than this adapter's release); `writableEnded` is true once this side has
   * ended it (ssh2's Client.end() calls _sock.end()), so BEFORE the release drives
   * its own end() it is a transport ended with no FIN back and not by this release
   * -- ssh2 answering a partner's SSH_MSG_DISCONNECT is the shape it is read for,
   * and what the reading establishes is only that the end was not this boundary's.
   * See releaseForIdle() and sessionTransportEnded().
   */
  readableEnded?: boolean;
  writableEnded?: boolean;
  /**
   * net.Socket's own unconditional teardown, which -- unlike end() -- needs nothing
   * from the peer. The connection-per-poll release drives it on a transport its
   * end() already ended but whose close the partner withheld, so the ssh2 Client's
   * 'close' fires and the session clears; the connection's terminal close drives it
   * on the same partner so the pending client.end() settles and no half-open socket
   * outlives teardown. See forceCloseEndedTransport() and
   * forceCloseTerminalTransport().
   */
  destroy?(): void;
  /**
   * Node's own post-destroy flag, read back by the terminal close to confirm the
   * socket it destroyed actually closed. Not part of the connect-time seam set:
   * an absent flag is treated as "did not close" and warns, rather than
   * failing a dial over a teardown-only read.
   */
  destroyed?: boolean;
}

/**
 * Typed interface for the internal ssh2 SFTPWrapper that ssh2-sftp-client
 * exposes as `this.sftp`. Defined at file scope so connect(), createExclusive(),
 * and list() can share it without repeating the declaration.
 */
export interface Ssh2SftpClientInternals {
  /**
   * The underlying ssh2 Client instance. ssh2-sftp-client constructs it as
   * `this.client` and drives every connection through it; its public
   * setNoDelay(boolean) toggles TCP_NODELAY on the live socket, and `_sock` is the
   * socket beneath it ({@link Ssh2ClientSocket}). Both are optional so the guarded
   * calls in connect() can warn-and-continue (each is transport hygiene, not a
   * correctness requirement) if an upgrade relocates them.
   */
  client?: {
    setNoDelay(noDelay: boolean): void;
    _sock?: Ssh2ClientSocket;
    /**
     * The ssh2 Client is an EventEmitter; the adapter registers two persistent
     * listener sets on it -- 'keyboard-interactive' to answer a server that
     * authenticates that method (see attachKeyboardInteractive), and the
     * 'end'/'close' pair the recovery re-dial reads to tell a transport whose
     * lifecycle events have all been delivered from one still owing a 'close'
     * (see watchTransportLifecycle). Typed narrowly to the events the adapter
     * uses rather than the full ssh2 Client surface.
     */
    on?(
      event: "keyboard-interactive",
      listener: (
        name: string,
        instructions: string,
        lang: string,
        prompts: { prompt: string; echo?: boolean }[],
        finish: (answers: string[]) => void,
      ) => void,
    ): void;
    on?(event: "end" | "close", listener: () => void): void;
    /**
     * The connection-per-poll release drives the ssh2 Client's own end() (NOT
     * ssh2-sftp-client's end(), which latches endCalled and disables the
     * constructor's global 'close' listener that clears this.sftp on a later
     * server drop) and awaits its 'close' to know the session is torn down;
     * removeListener drops that wait when the close never lands, so the shared
     * Client does not accumulate one listener per released cycle. All three are on
     * the ssh2 Client's EventEmitter surface; typed optional so an upgrade that
     * relocates them fails the connect-time seam check rather than the type.
     * See resolveTransportCloseSeams().
     *
     * The same pair also takes 'ready', which ssh2 emits when authentication has
     * succeeded: it is what arms the dial's subsystem-open bound and what drops
     * that arming when the dial settles first (see ./sftpSubsystemOpen).
     */
    once?(event: "close" | "ready", listener: () => void): void;
    removeListener?(event: "close" | "ready", listener: () => void): void;
    /**
     * Node's own EventEmitter ceiling control, driven once at construction to
     * seat `SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS` (ssh2SftpAdapter.ts). Optional
     * on the same terms as the members above: an upgrade that relocates the Client
     * warns rather than failing a dial over a diagnostic threshold.
     */
    setMaxListeners?(n: number): void;
    end?(): void;
  };
  sftp: {
    open(
      path: string,
      flags: number,
      attrs: Record<string, unknown>,
      callback: (err: Error | null, handle: Buffer) => void,
    ): void;
    close(handle: Buffer, callback: (err: Error | null) => void): void;
    opendir(
      path: string,
      callback: (err: Error | null, handle: Buffer) => void,
    ): void;
    /**
     * Called with a directory handle, readdir returns ONE server batch per call
     * and reports end-of-directory as an error whose `code` is SSH_FX_EOF (not
     * as an empty list), the contract the batch loop in list() relies on. `list`
     * is supplied only on success: ssh2 omits it (passes undefined) whenever
     * `err` is set, including the EOF signal, hence the optional parameter.
     */
    readdir(
      handle: Buffer,
      callback: (err: Ssh2SftpError | null, list?: Ssh2DirEntry[]) => void,
    ): void;
    /**
     * The raw ssh2 SFTPWrapper is an EventEmitter: ssh2 emits a fatal 'error' on
     * it (via doFatalSFTPError) when the server returns a malformed SFTP packet.
     * The adapter attaches its own guarded listener in connect() so that emit
     * cannot crash the process; see the connect() comment for why no one else
     * does. `unknown` rather than the full Node listener type keeps this minimal
     * -- the adapter only registers and never inspects the listener set.
     */
    on(event: "error", listener: (err: Error) => void): unknown;
  } | null;
}

/**
 * The single ssh2 seam the connection's terminal close drives. Resolved on its
 * own, apart from the wider set below, so a relocated member the terminal close
 * never touches cannot disable its forced destroy -- which in the default
 * held-session mode would leave a completed run holding a ref'd half-open socket,
 * i.e. a process that never exits. See
 * resolveTerminalCloseSeam.
 */
export interface TerminalCloseSeam {
  destroy: () => void;
  socket: Ssh2ClientSocket;
}

/**
 * The ssh2 seams a FORCED close drives: the terminal close's socket destroy,
 * plus the ssh2 Client's 'close' subscription, which is what reports that
 * destroy landed -- and, on a transport whose session is still set, what fires
 * ssh2-sftp-client's global listener to clear it. Not `end()`: neither a
 * transport that has ended nor a dial being abandoned needs one. Resolved and
 * bound together so a caller cannot reach one without having checked all of
 * them. See resolveForcedCloseSeams.
 */
export interface ForcedCloseSeams extends TerminalCloseSeam {
  once: (event: "close", listener: () => void) => void;
  removeListener: (event: "close", listener: () => void) => void;
}

/**
 * The above plus the ssh2 Client's own end(), which is what the
 * connection-per-poll idle release drives to END the transport before the forced
 * close that may follow it. See
 * resolveTransportCloseSeams.
 */
export interface TransportCloseSeams extends ForcedCloseSeams {
  end: () => void;
}

/**
 * The first seam the installed ssh2 / ssh2-sftp-client no longer exposes, named
 * as the adapter reaches it (e.g. `client._sock.destroy()`).
 */
export interface UnavailableTransportCloseSeam {
  missing: string;
}

/**
 * The one seam the connection's terminal close drives past the public API:
 * net.Socket's destroy() on the socket beneath the ssh2 Client. Resolved alone,
 * and required alone, because that close drives nothing else -- it reads back
 * `destroyed` but treats an absent flag as "did not close" rather than as a
 * missing mechanism. Requiring the wider set below would let a relocated
 * once/removeListener/writableEnded, none of which this path calls, disable the
 * forced destroy and leave a completed run holding a half-open socket.
 */
export function resolveTerminalCloseSeam(
  internals: Ssh2SftpClientInternals,
): TerminalCloseSeam | UnavailableTransportCloseSeam {
  const socket = internals.client?._sock;
  if (typeof socket?.destroy !== "function")
    return { missing: "client._sock.destroy()" };
  return { destroy: socket.destroy.bind(socket), socket };
}

/**
 * The seams a forced close drives past the public API: the ssh2 Client's own
 * once()/removeListener() for the 'close' the destroy drives, plus the terminal
 * close's socket seam. Every caller resolves them where it uses them -- the
 * abandoned dial's close, the mid-exchange recovery's, and the
 * connection-per-poll release's through the wider set below (verified at dial
 * time). Re-verify on any ssh2 / ssh2-sftp-client upgrade per
 * docs/spec/DEPENDENCY_PINS.md.
 */
export function resolveForcedCloseSeams(
  internals: Ssh2SftpClientInternals,
): ForcedCloseSeams | UnavailableTransportCloseSeam {
  const client = internals.client;
  if (typeof client?.once !== "function") return { missing: "client.once()" };
  if (typeof client.removeListener !== "function")
    return { missing: "client.removeListener()" };
  const terminal = resolveTerminalCloseSeam(internals);
  if ("missing" in terminal) return terminal;
  return {
    once: client.once.bind(client),
    removeListener: client.removeListener.bind(client),
    ...terminal,
  };
}

/**
 * The above plus Node's writableEnded flag on the same socket, which the
 * connection-per-poll release reads to tell WHO ended the transport. Required
 * only where a close meets a transport that has already ended: a close that
 * reads the flag nowhere resolves the narrower set above instead, so a bump
 * that relocated the flag alone cannot disable a destroy that never read it.
 */
export function resolveEndedTransportCloseSeams(
  internals: Ssh2SftpClientInternals,
): ForcedCloseSeams | UnavailableTransportCloseSeam {
  const seams = resolveForcedCloseSeams(internals);
  if ("missing" in seams) return seams;
  if (typeof seams.socket.writableEnded !== "boolean")
    return { missing: "client._sock.writableEnded" };
  return seams;
}

/**
 * The seams the connection-per-poll idle release drives past the public API: the
 * ssh2 Client's own end(), which ENDS the transport, plus everything the forced
 * close that may follow it needs. In this mode connect() resolves them once so an
 * upgrade that relocates any of them fails the dial with one actionable error
 * rather than silently changing what an idle boundary does, and the release
 * resolves them again where it uses them. Going through this one site is what
 * keeps the check and the uses from drifting apart.
 */
export function resolveTransportCloseSeams(
  internals: Ssh2SftpClientInternals,
): TransportCloseSeams | UnavailableTransportCloseSeam {
  const client = internals.client;
  if (typeof client?.end !== "function") return { missing: "client.end()" };
  const ended = resolveEndedTransportCloseSeams(internals);
  if ("missing" in ended) return ended;
  return { end: client.end.bind(client), ...ended };
}

/**
 * Reported as an unavailable seam rather than a thrown error so each caller
 * decides its own severity from the same reading: the connect-time check and the
 * idle release raise it (a boundary that silently stopped meaning anything is
 * worse than a failed dial), while the terminal close warns and returns.
 *
 * The message names no ssh2 internal: the caller logs the missing seam at debug,
 * and the assumptions are re-verified per the "Upgrading the SFTP Stack" checklist
 * in docs/spec/DEPENDENCY_PINS.md.
 */
export function transportCloseSeamError(): Error {
  return new Error(
    `this exchange closes the SFTP connection from this side at every poll ` +
      `boundary, which the installed SFTP library does not support, so the ` +
      `exchange cannot run. This build of psilink is not compatible with ` +
      `that library; ${REPORT_LIBRARY_INCOMPATIBILITY}`,
  );
}
