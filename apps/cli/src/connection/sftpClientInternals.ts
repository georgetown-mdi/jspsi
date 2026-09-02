// The typed view of the ssh2 / ssh2-sftp-client internals the SFTP adapter
// reaches past their public APIs, and the feature detection that resolves the
// transport-close seams off it.
//
// Everything here is a declaration or a pure resolver over one internals value:
// nothing holds adapter state, issues a server round trip, or decides a
// severity. A resolver reports the FIRST seam the installed library no longer
// exposes and leaves the caller to choose what that costs -- the connect-time
// check and the idle release raise, the terminal close warns -- so one reading
// serves both. Resolution order is therefore part of the contract rather than an
// accident of how the checks are written: it decides which seam an operator is
// told about first.
//
// The unavailable-seam arms cannot be driven by any real server against the
// pinned library, so they are modeled in the unit file only; the resolved arms
// run on every real-server integration leg. Re-verify the premises on any ssh2 /
// ssh2-sftp-client bump per docs/spec/DEPENDENCY_PINS.md ("Upgrading the SFTP
// Stack").

// A single entry as ssh2's SFTPWrapper.readdir reports it. Only the fields the
// transport consumes are typed; ssh2 supplies more (longname, the rest of
// attrs).
export interface Ssh2DirEntry {
  filename: string;
  attrs: { mtime: number; size: number };
}

// ssh2 reports SFTP failures (including end-of-directory from readdir) as an
// Error carrying the numeric SFTP status code on `code`.
export type Ssh2SftpError = Error & { code?: number };

// The ssh2 Client's underlying net.Socket, which the adapter reaches directly for
// what ssh2 does not expose. Every member is optional so a relocated or
// non-net.Socket transport reads undefined at each site; what that site does with
// it differs -- setKeepAlive warns and continues, the members the
// connection-per-poll release drives are verified at connect time and fail the
// dial (see resolveTransportCloseSeams), and the one member the terminal close
// drives is resolved lazily and warns rather than failing a dial over a
// teardown-only mechanism (see resolveTerminalCloseSeam).
export interface Ssh2ClientSocket {
  // ssh2 exposes setNoDelay but not setKeepAlive, so connect()'s kernel TCP
  // keepalive backstop reaches the socket for it.
  setKeepAlive?(enable: boolean, initialDelay: number): void;
  // Node's own half-close flags, read by the connection-per-poll release to tell
  // WHO ended the transport. `readableEnded` is true once the peer's FIN has been
  // consumed (the peer began the teardown, so what follows is a server-side drop
  // rather than this adapter's release); `writableEnded` is true once this side has
  // ended it (ssh2's Client.end() calls _sock.end()), so BEFORE the release drives
  // its own end() it is a transport ended with no FIN back and not by this release
  // -- ssh2 answering a partner's SSH_MSG_DISCONNECT is the shape it is read for,
  // and what the reading establishes is only that the end was not this boundary's.
  // See releaseForIdle() and sessionTransportEnded().
  readableEnded?: boolean;
  writableEnded?: boolean;
  // net.Socket's own unconditional teardown, which -- unlike end() -- needs nothing
  // from the peer. The connection-per-poll release drives it on a transport its
  // end() already ended but whose close the partner withheld, so the ssh2 Client's
  // 'close' fires and the session clears; the connection's terminal close drives it
  // on the same partner so the pending client.end() settles and no half-open socket
  // outlives teardown. See forceCloseEndedTransport() and
  // forceCloseTerminalTransport().
  destroy?(): void;
  // Node's own post-destroy flag, read back by the terminal close to confirm the
  // socket it destroyed actually closed. Not part of the connect-time seam set:
  // an absent flag reads as "did not close" and warns, rather than failing a dial
  // over a teardown-only read.
  destroyed?: boolean;
}

// Typed interface for the internal ssh2 SFTPWrapper that ssh2-sftp-client
// exposes as `this.sftp`. Defined at file scope so connect(), createExclusive(),
// and list() can share it without repeating the declaration.
export interface Ssh2SftpClientInternals {
  // The underlying ssh2 Client instance. ssh2-sftp-client constructs it as
  // `this.client` and drives every connection through it; its public
  // setNoDelay(boolean) toggles TCP_NODELAY on the live socket, and `_sock` is the
  // socket beneath it ({@link Ssh2ClientSocket}). Both are optional so the guarded
  // calls in connect() can warn-and-continue (each is transport hygiene, not a
  // correctness requirement) if an upgrade relocates them.
  client?: {
    setNoDelay(noDelay: boolean): void;
    _sock?: Ssh2ClientSocket;
    // The ssh2 Client is an EventEmitter; the adapter registers two persistent
    // listener sets on it -- 'keyboard-interactive' to answer a server that
    // authenticates that method (see attachKeyboardInteractive), and the
    // 'end'/'close' pair the recovery re-dial reads to tell a transport whose
    // lifecycle events have all been delivered from one still owing a 'close'
    // (see watchTransportLifecycle). Typed narrowly to the events the adapter
    // uses rather than the full ssh2 Client surface.
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
    // The connection-per-poll release drives the ssh2 Client's own end() (NOT
    // ssh2-sftp-client's end(), which latches endCalled and disables the
    // constructor's global 'close' listener that clears this.sftp on a later
    // server drop) and awaits its 'close' to know the session is torn down;
    // removeListener drops that wait when the close never lands, so the shared
    // Client does not accumulate one listener per released cycle. All three are on
    // the ssh2 Client's EventEmitter surface; typed optional so an upgrade that
    // relocates them fails the connect-time seam check rather than the type.
    // See resolveTransportCloseSeams().
    once?(event: "close", listener: () => void): void;
    removeListener?(event: "close", listener: () => void): void;
    // Node's own EventEmitter ceiling control, driven once at construction to
    // seat `SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS` (ssh2SftpAdapter.ts). Optional
    // on the same terms as the members above: an upgrade that relocates the Client
    // warns rather than failing a dial over a diagnostic threshold.
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
    // Called with a directory handle, readdir returns ONE server batch per call
    // and reports end-of-directory as an error whose `code` is SSH_FX_EOF (not
    // as an empty list), the contract the batch loop in list() relies on. `list`
    // is supplied only on success: ssh2 omits it (passes undefined) whenever
    // `err` is set, including the EOF signal, hence the optional parameter.
    readdir(
      handle: Buffer,
      callback: (err: Ssh2SftpError | null, list?: Ssh2DirEntry[]) => void,
    ): void;
    // The raw ssh2 SFTPWrapper is an EventEmitter: ssh2 emits a fatal 'error' on
    // it (via doFatalSFTPError) when the server returns a malformed SFTP packet.
    // The adapter attaches its own guarded listener in connect() so that emit
    // cannot crash the process; see the connect() comment for why no one else
    // does. `unknown` rather than the full Node listener type keeps this minimal
    // -- the adapter only registers and never inspects the listener set.
    on(event: "error", listener: (err: Error) => void): unknown;
  } | null;
}

// The single ssh2 seam the connection's terminal close drives. Resolved on its
// own, apart from the wider set below, so a relocated member the terminal close
// never touches cannot disable its forced destroy -- which in the default
// held-session mode would leave a completed run holding a ref'd half-open socket,
// i.e. a process that never exits. See
// resolveTerminalCloseSeam.
export interface TerminalCloseSeam {
  destroy: () => void;
  socket: Ssh2ClientSocket;
}

// The ssh2 seams a forced close of an ALREADY-ENDED transport drives: the
// terminal close's socket destroy, plus the ssh2 Client's 'close' subscription,
// which is what fires ssh2-sftp-client's global listener to clear the session.
// Not `end()`: a transport that has ended needs no second end. Resolved and bound
// together so a caller cannot reach one without having checked all of them. See
// resolveEndedTransportCloseSeams.
export interface EndedTransportCloseSeams extends TerminalCloseSeam {
  once: (event: "close", listener: () => void) => void;
  removeListener: (event: "close", listener: () => void) => void;
}

// The above plus the ssh2 Client's own end(), which is what the
// connection-per-poll idle release drives to END the transport before the forced
// close that may follow it. See
// resolveTransportCloseSeams.
export interface TransportCloseSeams extends EndedTransportCloseSeams {
  end: () => void;
}

// The first seam the installed ssh2 / ssh2-sftp-client no longer exposes, named
// as the adapter reaches it (e.g. `client._sock.destroy()`).
export interface UnavailableTransportCloseSeam {
  missing: string;
}

// The one seam the connection's terminal close drives past the public API:
// net.Socket's destroy() on the socket beneath the ssh2 Client. Resolved alone,
// and required alone, because that close drives nothing else -- it reads back
// `destroyed` but treats an absent flag as "did not close" rather than as a
// missing mechanism. Requiring the wider set below would let a relocated
// once/removeListener/writableEnded, none of which this path calls, disable the
// forced destroy and leave a completed run holding a half-open socket.
export function resolveTerminalCloseSeam(
  internals: Ssh2SftpClientInternals,
): TerminalCloseSeam | UnavailableTransportCloseSeam {
  const socket = internals.client?._sock;
  if (typeof socket?.destroy !== "function")
    return { missing: "client._sock.destroy()" };
  return { destroy: socket.destroy.bind(socket), socket };
}

// The seams a forced close of an already-ended transport drives past the public
// API: the ssh2 Client's own once()/removeListener() for the 'close' that clears
// the session, plus the terminal close's socket seam above and Node's
// writableEnded flag on that same socket. Both forced closes resolve them where
// they use them -- the connection-per-poll release through the wider set below,
// which connect() verifies at dial time in that mode, and the mid-exchange
// recovery on its own, which does not (its severity is a warning and the
// operation's own terminal failure, not a failed dial). Re-verify on any ssh2 /
// ssh2-sftp-client upgrade per docs/spec/DEPENDENCY_PINS.md.
export function resolveEndedTransportCloseSeams(
  internals: Ssh2SftpClientInternals,
): EndedTransportCloseSeams | UnavailableTransportCloseSeam {
  const client = internals.client;
  if (typeof client?.once !== "function") return { missing: "client.once()" };
  if (typeof client.removeListener !== "function")
    return { missing: "client.removeListener()" };
  const terminal = resolveTerminalCloseSeam(internals);
  if ("missing" in terminal) return terminal;
  if (typeof terminal.socket.writableEnded !== "boolean")
    return { missing: "client._sock.writableEnded" };
  return {
    once: client.once.bind(client),
    removeListener: client.removeListener.bind(client),
    ...terminal,
  };
}

// The seams the connection-per-poll idle release drives past the public API: the
// ssh2 Client's own end(), which ENDS the transport, plus everything the forced
// close that may follow it needs. In this mode connect() resolves them once so an
// upgrade that relocates any of them fails the dial with one actionable error
// rather than silently changing what an idle boundary does, and the release
// resolves them again where it uses them. Going through this one site is what
// keeps the check and the uses from drifting apart.
export function resolveTransportCloseSeams(
  internals: Ssh2SftpClientInternals,
): TransportCloseSeams | UnavailableTransportCloseSeam {
  const client = internals.client;
  if (typeof client?.end !== "function") return { missing: "client.end()" };
  const ended = resolveEndedTransportCloseSeams(internals);
  if ("missing" in ended) return ended;
  return { end: client.end.bind(client), ...ended };
}

// Reported as an unavailable seam rather than a thrown error so each caller
// decides its own severity from the same reading: the connect-time check and the
// idle release raise it (a boundary that silently stopped meaning anything is
// worse than a failed dial), while the terminal close warns and returns.
export function transportCloseSeamError(seam: string): Error {
  return new Error(
    `closing an SFTP connection from this side drives ssh2's ${seam}, which ` +
      `is not available after connect(); the installed ssh2 / ` +
      `ssh2-sftp-client version may have renamed, relocated, or removed it - ` +
      `re-verify the internal premises per the "Upgrading the SFTP Stack" ` +
      `checklist in docs/spec/DEPENDENCY_PINS.md`,
  );
}
