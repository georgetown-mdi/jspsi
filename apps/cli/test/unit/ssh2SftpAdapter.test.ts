import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  DirectoryListingBoundsError,
  FileTransportClient,
  FrameSizeExceededError,
  TransportOperationStalledError,
  TransportPublishIndeterminateError,
  UsageError,
  sanitizeErrorForDisplay,
} from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import {
  MAX_DEFERRED_CLEANUP_DELETES,
  MAX_DEFERRED_CLEANUP_REISSUES,
} from "../../src/connection/sftpDeferredCleanup";
import {
  SFTP_REDIAL_WARN_INTERVAL,
  SftpAdapterLedger,
} from "../../src/connection/sftpAdapterLedger";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_LENGTH,
  MAX_LISTING_READDIR_BATCHES,
} from "../../src/connection/listingGuard";
import {
  SFTP_PUT_PROGRESS_CHUNK_BYTES,
  SFTP_SLOW_OPERATION_WARNING_MS,
  SFTP_STALL_DEADLINE_MS,
} from "../../src/connection/sftpLivenessGuard";
import {
  SFTP_HEARTBEAT_INTERVAL_MS,
  SFTP_TCP_KEEPALIVE_DELAY_MS,
} from "../../src/connection/sftpHeartbeat";

// Models ssh2-sftp-client exposing the underlying ssh2 Client on `.client`.
// connect() calls setNoDelay(true) on it to disable Nagle and setKeepAlive(true,
// delay) on its underlying net.Socket (`_sock`) to enable kernel TCP keepalive; a
// mock that omits either makes connect() warn that the setting is unavailable on
// every successful connect. Provide no-ops so the faithful mock matches the real
// client and neither warning fires.
const noDelayClient = () => ({
  setNoDelay: () => {},
  _sock: { setKeepAlive: () => {} },
});

// The same stand-in plus the seams the connection-per-poll idle release drives,
// which connect() verifies in that mode: the ssh2 Client's EventEmitter surface
// and its socket's destroy() and half-close flag. Also what a faithful stand-in
// for the pinned ssh2 Client looks like anywhere a recovery re-dial runs -- that
// EventEmitter surface is what its transport-lifecycle watch attaches to, and a
// Client without one puts the re-dial on its degraded branch.
const releasableClient = () =>
  Object.assign(new EventEmitter(), {
    setNoDelay: () => {},
    _sock: { setKeepAlive: () => {}, writableEnded: false, destroy: () => {} },
    end: () => {},
  });

// The record of cleanup deletes the adapter is holding for re-issue. Private
// state with no public surface: what it holds decides whether a later
// re-establishment re-issues the delete, and its size is the bound the cap
// enforces, neither of which is observable from outside until the drain runs.
const deferredCleanupRecord = (
  adapter: SSH2SFTPClientAdapter,
): ReadonlyMap<string, number> =>
  (
    adapter as unknown as {
      deferredCleanupDeletes: { recorded: ReadonlyMap<string, number> };
    }
  ).deferredCleanupDeletes.recorded;

// The recorded paths, in record order.
const deferredCleanupPaths = (adapter: SSH2SFTPClientAdapter): string[] => [
  ...deferredCleanupRecord(adapter).keys(),
];

// The re-issues each recorded path has left, in record order: the budget that
// decides whether a cleanup delete the server will never let succeed is retried
// again or given up on.
const deferredCleanupBudgets = (adapter: SSH2SFTPClientAdapter): number[] => [
  ...deferredCleanupRecord(adapter).values(),
];

// A remote path naming the protocol's own in-flight write, temp-<uuidv4()>.tmp:
// the ONLY shape the record admits, so a case about the record must use a real
// one rather than a readable stand-in. randomUUID() emits the same canonical
// lowercase v4 form uuidv4() does in send()/writeAck().
const protocolTempPath = (dir = "/remote"): string =>
  `${dir}/temp-${randomUUID()}.tmp`;

// Replaces the adapter's logger with a warn-swallowing stub. The deadline /
// idle-window tests advance past SFTP_SLOW_OPERATION_WARNING_MS (30 s) on the
// way to the 60 s deadline, so the non-fatal slow-operation warning fires
// incidentally; this keeps it off the console. That warning's content is
// asserted by the "slow-operation warning" describe block, so suppressing it
// here loses no coverage (this.log.warn is the adapter's only WARN sink).
function stubAdapterLog(adapter: SSH2SFTPClientAdapter): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).log = { warn: vi.fn() };
}

// Replaces a client's exists() with one the test answers by hand, so the
// existence probe a rename re-issue fires can be left ON THE WIRE while
// something else happens to the session. `issued` resolves the moment the probe
// reaches the client, which is the only signal a caller has that the round trip
// it wants to interrupt has actually started.
function pendingExists(client: object) {
  let answerProbe!: (present: boolean) => void;
  let markIssued!: () => void;
  const issued = new Promise<void>((resolve) => {
    markIssued = resolve;
  });
  const exists = vi.fn(() => {
    markIssued();
    return new Promise<boolean>((resolve) => {
      answerProbe = resolve;
    });
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).exists = exists;
  return { exists, issued, answer: (present: boolean) => answerProbe(present) };
}

// --- connect retry -----------------------------------------------------------

describe("connect retry", () => {
  test("retries and succeeds within maxReconnectAttempts", async () => {
    vi.useFakeTimers();
    const adapter = new SSH2SFTPClientAdapter();
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      // `on` models the raw wrapper's EventEmitter surface: connect() attaches a
      // guarded fatal-'error' listener to it (so a malformed server reply cannot
      // crash the process), so the mock must expose it like the real wrapper does.
      sftp: {
        open: vi.fn(),
        close: vi.fn(),
        opendir: vi.fn(),
        readdir: vi.fn(),
        on: vi.fn(),
      },
      connect: vi.fn().mockImplementation(async () => {
        if (++calls < 3) throw new Error("connection refused");
      }),
      client: noDelayClient(),
    };

    try {
      const p = adapter.connect({
        host: "sftp.example.org",
        maxReconnectAttempts: 2,
      });
      // Advance past two 1 s retry delays; the third attempt succeeds.
      await vi.advanceTimersByTimeAsync(2_001);
      await p;
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("counts each connect re-attempt as a reconnect for the metrics summary", async () => {
    vi.useFakeTimers();
    const adapter = new SSH2SFTPClientAdapter();
    // A clean adapter has re-dialed zero times.
    expect(adapter.reconnectCount).toBe(0);
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: {
        open: vi.fn(),
        close: vi.fn(),
        opendir: vi.fn(),
        readdir: vi.fn(),
        on: vi.fn(),
      },
      connect: vi.fn().mockImplementation(async () => {
        if (++calls < 3) throw new Error("connection refused");
      }),
      client: noDelayClient(),
    };

    try {
      const p = adapter.connect({
        host: "sftp.example.org",
        maxReconnectAttempts: 2,
      });
      await vi.advanceTimersByTimeAsync(2_001);
      await p;
      // Two re-dials past the initial attempt are reported as reconnects; the
      // per-operation transport-retry counter is untouched by connect.
      expect(adapter.reconnectCount).toBe(2);
      expect(adapter.transportRetryCount).toBe(0);
      // Connect-time retries are NOT mid-exchange re-dials, so the sub-count the
      // summary reports apart from the total stays zero.
      expect(adapter.midExchangeReconnectCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("throws after exhausting maxReconnectAttempts", async () => {
    vi.useFakeTimers();
    const adapter = new SSH2SFTPClientAdapter();
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      connect: vi.fn().mockImplementation(async () => {
        calls++;
        throw new Error("connection refused");
      }),
    };

    try {
      const p = adapter.connect({
        host: "sftp.example.org",
        maxReconnectAttempts: 1,
      });
      // Attach before advancing so the mid-advance rejection is not unhandled.
      const assertion = expect(p).rejects.toThrow("connection refused");
      // 2 total attempts (initial + 1 reconnect) with 1 s delay between each.
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not retry a 'Host denied' host-key rejection (terminal, one attempt)", async () => {
    // The connect-retry predicate treats a host-key verification rejection as
    // terminal by matching the `Host denied` message fragment. The two tests
    // above pin the other direction -- a transient `connection refused` IS
    // retried up to maxReconnectAttempts -- so the three together prove the
    // predicate discriminates rather than disabling retry wholesale. A
    // regression here (a renamed fatal message, a typo) would silently retry a
    // host-key failure maxReconnectAttempts times before failing with the same
    // outcome; the "Upgrading the SFTP Stack" checklist in
    // docs/spec/DEPENDENCY_PINS.md names confirming this fragment as a per-bump
    // obligation, which this pins.
    vi.useFakeTimers();
    const adapter = new SSH2SFTPClientAdapter();
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      connect: vi.fn().mockImplementation(async () => {
        calls++;
        // The fatal handshake message ssh2 raises on a host-key rejection
        // (hostVerifier calling verify(false)): "Host denied (verification
        // failed)", from node_modules/ssh2/lib/protocol/kex.js. ssh2 sets no
        // machine-readable `code` on it, so the predicate keys on the message
        // fragment. Keep this string in sync with that same kex.js source named
        // in docs/spec/DEPENDENCY_PINS.md ("Upgrading the SFTP Stack"); if a
        // future bump renames it, that checklist and this string move together.
        throw new Error("Host denied (verification failed)");
      }),
    };

    try {
      const p = adapter.connect({
        host: "sftp.example.org",
        // A non-zero reconnect budget is what makes the single-attempt
        // assertion meaningful: a working predicate must refuse to spend it on a
        // host-key rejection, where retrying only re-runs the key exchange
        // against the same untrusted host.
        maxReconnectAttempts: 3,
      });
      // Attach before advancing so the rejection is not unhandled.
      const assertion = expect(p).rejects.toThrow("Host denied");
      // Advance well past several 1 s retry windows: a regressed (always-true)
      // predicate would have armed a retry timer in this span, lifting the count
      // above one. The assertion is the observed attempt count via the stub, not
      // a wall-clock bound on how long the rejection takes.
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("strips maxReconnectAttempts from options passed to ssh2", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    let capturedOptions: Record<string, unknown> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: {
        open: vi.fn(),
        close: vi.fn(),
        opendir: vi.fn(),
        readdir: vi.fn(),
        on: vi.fn(),
      },
      connect: vi
        .fn()
        .mockImplementation(async (opts: Record<string, unknown>) => {
          capturedOptions = opts;
        }),
      client: noDelayClient(),
    };

    // 0 retries = 1 total attempt.
    await adapter.connect({
      host: "sftp.example.org",
      maxReconnectAttempts: 0,
    });
    expect(capturedOptions).toHaveProperty("host", "sftp.example.org");
    expect(capturedOptions).not.toHaveProperty("maxReconnectAttempts");
  });

  test("rejects at connect time when the internal SFTP API drops a method it drives", async () => {
    // createExclusive()/list() call open/close/opendir/readdir on the internal
    // SFTPWrapper directly. The connect-time guard must catch an upstream
    // rename or removal of any of them and surface one actionable error here,
    // rather than letting a TypeError surface at the first send()/poll.
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      // `readdir` is absent, as if a future ssh2 version renamed it; the
      // session property itself is present, so the bare null check would pass.
      sftp: { open: vi.fn(), close: vi.fn(), opendir: vi.fn() },
      connect: vi.fn().mockResolvedValue(undefined),
      client: noDelayClient(),
    };
    await expect(
      adapter.connect({ host: "sftp.example.org", maxReconnectAttempts: 0 }),
    ).rejects.toThrow("readdir");
  });
});

// --- keyboard-interactive authentication -------------------------------------

describe("keyboard-interactive", () => {
  // A mock of the underlying ssh2 Client (ssh2-sftp-client's `.client`) that
  // records the listeners the adapter registers on it, so a test can invoke the
  // keyboard-interactive handler the adapter attaches. setNoDelay/_sock are the
  // no-ops connect() also calls (see noDelayClient).
  function keyboardClient(): {
    client: {
      setNoDelay: () => void;
      _sock: { setKeepAlive: () => void };
      on: ReturnType<typeof vi.fn>;
    };
    listeners: Record<string, ((...args: unknown[]) => void)[]>;
  } {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const on = vi.fn(
      (event: string, listener: (...args: unknown[]) => void) => {
        (listeners[event] ??= []).push(listener);
      },
    );
    return {
      client: { setNoDelay: () => {}, _sock: { setKeepAlive: () => {} }, on },
      listeners,
    };
  }

  // Keyboard-interactive attaches only. connect() also registers the adapter's
  // persistent transport-lifecycle listeners on this same Client (see
  // watchTransportLifecycle), so a bare call count would answer a different
  // question than the one these cases ask.
  function keyboardAttaches(client: { on: ReturnType<typeof vi.fn> }): number {
    return client.on.mock.calls.filter(
      (call) => call[0] === "keyboard-interactive",
    ).length;
  }

  // Install a mock ssh2-sftp-client on the adapter whose underlying ssh2 Client
  // is `ssh2Client`, so connect() drives the real keyboard-interactive attach.
  function installClient(
    adapter: SSH2SFTPClientAdapter,
    ssh2Client: unknown,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: {
        open: vi.fn(),
        close: vi.fn(),
        opendir: vi.fn(),
        readdir: vi.fn(),
        on: vi.fn(),
      },
      connect: vi.fn().mockResolvedValue(undefined),
      client: ssh2Client,
    };
  }

  test("answers the server's prompts with the password when tryKeyboard is set", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const { client, listeners } = keyboardClient();
    installClient(adapter, client);

    await adapter.connect({
      host: "sftp.example.org",
      password: "hunter2",
      tryKeyboard: true,
      maxReconnectAttempts: 0,
    });

    expect(client.on).toHaveBeenCalledWith(
      "keyboard-interactive",
      expect.any(Function),
    );
    const handler = listeners["keyboard-interactive"]?.[0];
    expect(handler).toBeDefined();
    // Drive the handler as ssh2 would: two password prompts, expecting one answer
    // each, all the configured password.
    const finish = vi.fn();
    handler!(
      "name",
      "instructions",
      "en",
      [
        { prompt: "Password:", echo: false },
        { prompt: "Verification:", echo: false },
      ],
      finish,
    );
    expect(finish).toHaveBeenCalledWith(["hunter2", "hunter2"]);
  });

  test("does not attach a handler when tryKeyboard is not set", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const { client } = keyboardClient();
    installClient(adapter, client);

    await adapter.connect({
      host: "sftp.example.org",
      password: "hunter2",
      maxReconnectAttempts: 0,
    });

    // connect() registers no keyboard-interactive answer handler unless the method
    // is enabled (the fatal-error listener goes on the SFTPWrapper).
    expect(keyboardAttaches(client)).toBe(0);
  });

  test("does not attach a handler when tryKeyboard is set but no password is present", async () => {
    // Defensive: core only sets tryKeyboard alongside a password, but a direct
    // caller could pass tryKeyboard with no password; with nothing to answer
    // prompts with, the handler is skipped rather than answering empty.
    const adapter = new SSH2SFTPClientAdapter();
    const { client } = keyboardClient();
    installClient(adapter, client);

    await adapter.connect({
      host: "sftp.example.org",
      tryKeyboard: true,
      maxReconnectAttempts: 0,
    });

    expect(keyboardAttaches(client)).toBe(0);
  });

  test("does not attach a handler when tryKeyboard is set but the password is not a string", async () => {
    // The answer handler reads this.options.password and answers "" for anything
    // that is not a string, which would put an empty password to the server. The
    // connect() gate is what keeps that arm out of reach, and it tests the TYPE
    // rather than mere presence: connect() takes a Record<string, unknown>, so a
    // direct adapter caller -- the only caller the config schema's string-typed
    // password does not already constrain -- reaches the same skip an absent
    // password takes.
    const adapter = new SSH2SFTPClientAdapter();
    const { client } = keyboardClient();
    installClient(adapter, client);

    await adapter.connect({
      host: "sftp.example.org",
      password: 1234,
      tryKeyboard: true,
      maxReconnectAttempts: 0,
    });

    expect(keyboardAttaches(client)).toBe(0);
  });

  test("attaches the handler exactly once across repeated connects", async () => {
    // The ssh2 Client is reused across reconnects; the handler must be attached
    // once, or repeated connects would stack duplicate listeners.
    const adapter = new SSH2SFTPClientAdapter();
    const { client } = keyboardClient();
    installClient(adapter, client);

    const opts = {
      host: "sftp.example.org",
      password: "hunter2",
      tryKeyboard: true,
      maxReconnectAttempts: 0,
    };
    await adapter.connect({ ...opts });
    await adapter.connect({ ...opts });

    expect(keyboardAttaches(client)).toBe(1);
  });

  test("answers with the current password after a reconnect, not a stale captured one", async () => {
    // Read-fresh: the once-attached listener reads this.options.password at answer
    // time, so a later connect() carrying a different password is answered with
    // the new one. A closure that captured the password at attach time would
    // answer the first password -- this pins the read-fresh invariant as a check.
    const adapter = new SSH2SFTPClientAdapter();
    const { client, listeners } = keyboardClient();
    installClient(adapter, client);

    await adapter.connect({
      host: "sftp.example.org",
      password: "first",
      tryKeyboard: true,
      maxReconnectAttempts: 0,
    });
    await adapter.connect({
      host: "sftp.example.org",
      password: "second",
      tryKeyboard: true,
      maxReconnectAttempts: 0,
    });

    // Still attached exactly once, but answering with the latest password.
    expect(keyboardAttaches(client)).toBe(1);
    const handler = listeners["keyboard-interactive"]?.[0];
    const finish = vi.fn();
    handler!("n", "i", "en", [{ prompt: "Password:", echo: false }], finish);
    expect(finish).toHaveBeenCalledWith(["second"]);
  });

  test("fails loudly when the ssh2 client cannot register the handler", async () => {
    // Without on(), a keyboard-interactive request would silently stall the
    // handshake to readyTimeout; the connect-time guard surfaces it instead.
    const adapter = new SSH2SFTPClientAdapter();
    installClient(adapter, noDelayClient()); // no on()

    await expect(
      adapter.connect({
        host: "sftp.example.org",
        password: "hunter2",
        tryKeyboard: true,
        maxReconnectAttempts: 0,
      }),
    ).rejects.toThrow("keyboard-interactive");
  });
});

// --- rename retry ------------------------------------------------------------

describe("rename retry", () => {
  // rename() wraps client.rename in retryPromise, but -- unlike the idempotent
  // put() -- gates the retry on the generic SSH_FX_FAILURE (status 4): the
  // "operation did not take effect" code that surfaced as the `_rename: Failure`
  // crashing the mixed-connection rendezvous joiner under load. These tests pin
  // that contract: a transient status-4 failure is absorbed within a bounded
  // budget, a persistent one still surfaces after the bound, and a non-status-4
  // failure (e.g. SSH_FX_NO_SUCH_FILE) is terminal and is NOT retried, so a
  // succeeded-but-lost-reply rename cannot be amplified into a spurious error.

  // An error shaped like the one ssh2-sftp-client surfaces: the raw numeric SFTP
  // status on `code` (passed through fmtError).
  const sftpError = (message: string, code: number) =>
    Object.assign(new Error(message), { code });

  test("retries a transient SSH_FX_FAILURE and resolves", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let calls = 0;
      const rename = vi.fn().mockImplementation(async () => {
        // Fail the first two attempts with the server's generic failure, then
        // succeed -- the shape of the observed transient flake.
        if (++calls < 3) throw sftpError("_rename: Failure", 4);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // rename reads this.options!.retries; an empty object falls back to 5.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { rename };

      const renaming = adapter.rename("/remote/a.json", "/remote/b.json");
      // Advance past the two 100 ms retry delays; the third attempt succeeds.
      await vi.advanceTimersByTimeAsync(250);
      await expect(renaming).resolves.toBeUndefined();
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("counts each rename re-issue as a transport retry for the metrics summary", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // A clean adapter has re-issued no operations.
      expect(adapter.transportRetryCount).toBe(0);
      let calls = 0;
      const rename = vi.fn().mockImplementation(async () => {
        if (++calls < 3) throw sftpError("_rename: Failure", 4);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { rename };

      const renaming = adapter.rename("/remote/a.json", "/remote/b.json");
      await vi.advanceTimersByTimeAsync(250);
      await renaming;
      // Two re-issues past the initial attempt are reported as transport
      // retries; connect re-dials are counted separately and stay zero here.
      expect(adapter.transportRetryCount).toBe(2);
      expect(adapter.reconnectCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects after exhausting the bounded retries on persistent SSH_FX_FAILURE", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let calls = 0;
      const rename = vi.fn().mockImplementation(async () => {
        calls++;
        throw sftpError("_rename: Failure", 4);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // Bound the retries explicitly so the attempt count is asserted, not the
      // default: 2 retries == 3 total attempts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = { retries: 2 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { rename };

      const renaming = adapter.rename("/remote/a.json", "/remote/b.json");
      // Attach before advancing so the mid-advance rejection is not unhandled.
      const assertion = expect(renaming).rejects.toThrow("_rename: Failure");
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not retry a non-SSH_FX_FAILURE error (NO_SUCH_FILE surfaces at once)", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let calls = 0;
      const rename = vi.fn().mockImplementation(async () => {
        calls++;
        // SSH_FX_NO_SUCH_FILE (2): the code a second attempt would see if the
        // first rename had actually succeeded but its reply was lost. Retrying
        // it would manufacture a spurious failure from a successful rename, so
        // it must be terminal -- one attempt, no re-issue.
        throw sftpError("_rename: No such file or directory", 2);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { rename };

      const renaming = adapter.rename("/remote/a.json", "/remote/b.json");
      const assertion = expect(renaming).rejects.toThrow("No such file");
      // Advancing well past several retry windows proves no retry was scheduled.
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("honors an explicit retries: 0 (no retry even on SSH_FX_FAILURE)", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let calls = 0;
      const rename = vi.fn().mockImplementation(async () => {
        calls++;
        throw sftpError("_rename: Failure", 4);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // retries: 0 must disable the retry, not be coerced to the default of 5 --
      // the `?? 5` (not `|| 5`) guard. A status-4 failure that would otherwise be
      // retried is surfaced after the single attempt.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = { retries: 0 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { rename };

      const renaming = adapter.rename("/remote/a.json", "/remote/b.json");
      const assertion = expect(renaming).rejects.toThrow("_rename: Failure");
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops retrying when a fatal session error lands between attempts", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let calls = 0;
      const rename = vi.fn().mockImplementation(async () => {
        calls++;
        // A fatal protocol error lands in the inter-attempt window: it sets
        // fatalSftpError (as the guarded wrapper 'error' listener would), but
        // this attempt still rejects with the status-4 the server already sent.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).fatalSftpError = new Error("Malformed DATA packet");
        throw sftpError("_rename: Failure", 4);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { rename };

      const renaming = adapter.rename("/remote/a.json", "/remote/b.json");
      // The status-4 reply alone would be retried, but the next attempt's
      // dead-session re-check rejects promptly with the terminal stalled error
      // (not status 4) rather than buffering a request on the dead channel.
      const assertion = expect(renaming).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      // Only the first attempt reached the server; the second short-circuited.
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- createExclusive ---------------------------------------------------------

describe("createExclusive", () => {
  let adapter: SSH2SFTPClientAdapter;
  let mockOpen: ReturnType<typeof vi.fn>;
  let mockClose: ReturnType<typeof vi.fn>;
  let mockExists: ReturnType<typeof vi.fn>;

  function injectSftpSession(sftpOpen: boolean) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: sftpOpen ? { open: mockOpen, close: mockClose } : null,
      // exists() is called by createExclusive when SFTPv3 FAILURE (code 4)
      // is received, to resolve the ambiguity between a genuine race and a
      // real I/O error. Default: returns false (file not present).
      exists: mockExists,
    };
  }

  beforeEach(() => {
    adapter = new SSH2SFTPClientAdapter();
    mockOpen = vi
      .fn()
      .mockImplementation(
        (
          _path: string,
          _flags: number,
          _attrs: object,
          cb: (err: Error | null, handle: Buffer) => void,
        ) => cb(null, Buffer.alloc(4)),
      );
    mockClose = vi
      .fn()
      .mockImplementation((_handle: Buffer, cb: (err: Error | null) => void) =>
        cb(null),
      );
    mockExists = vi.fn().mockResolvedValue(false);
    injectSftpSession(true);
  });

  test("resolves when the server creates the file", async () => {
    await expect(
      adapter.createExclusive("/remote/new.txt"),
    ).resolves.toBeUndefined();
    expect(mockOpen).toHaveBeenCalledOnce();
    // SSH_FXF_WRITE (0x02) | SSH_FXF_CREAT (0x08) | SSH_FXF_EXCL (0x20) = 0x2A
    expect(mockOpen).toHaveBeenCalledWith(
      "/remote/new.txt",
      0x2a,
      {},
      expect.any(Function),
    );
    expect(mockClose).toHaveBeenCalledOnce();
  });

  test("rejects with the original server error when open fails with an unrecognized code", async () => {
    const serverErr = new Error("SSH_FX_FILE_ALREADY_EXISTS");
    mockOpen.mockImplementation(
      (
        _path: string,
        _flags: number,
        _attrs: object,
        cb: (err: Error | null, handle: Buffer) => void,
      ) => cb(serverErr, Buffer.alloc(0)),
    );
    await expect(adapter.createExclusive("/remote/existing.txt")).rejects.toBe(
      serverErr,
    );
    // close must not be called when open fails
    expect(mockClose).not.toHaveBeenCalled();
  });

  test("normalizes SFTPv3 FAILURE (numeric 4) to code === 'EEXIST' when the file exists (genuine race)", async () => {
    // SFTPv3 SSH_FX_FAILURE (4) is ambiguous. When exists() confirms the file
    // is present, the exclusive-create lost a genuine lock-file race and the
    // adapter must normalize to EEXIST so FileSyncConnection's race handler
    // fires.
    const sftpV3Err = Object.assign(new Error("Failure"), { code: 4 });
    mockOpen.mockImplementation(
      (
        _path: string,
        _flags: number,
        _attrs: object,
        cb: (err: Error | null, handle: Buffer) => void,
      ) => cb(sftpV3Err, Buffer.alloc(0)),
    );
    mockExists.mockResolvedValue(true);
    const err = await adapter
      .createExclusive("/remote/existing.txt")
      .catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("EEXIST");
    expect(mockExists).toHaveBeenCalledWith("/remote/existing.txt");
  });

  test("wraps SFTPv3 FAILURE (numeric 4) with a diagnostic hint when the file does not exist (real I/O error)", async () => {
    // When exists() reports the file is absent, code 4 indicates a genuine I/O
    // failure (disk full, permissions, etc.) rather than a race. The error is
    // wrapped with an actionable message that points the user at the SFTP
    // server logs before retrying; the original error is available as
    // err.cause.
    const sftpV3Err = Object.assign(new Error("Failure"), { code: 4 });
    mockOpen.mockImplementation(
      (
        _path: string,
        _flags: number,
        _attrs: object,
        cb: (err: Error | null, handle: Buffer) => void,
      ) => cb(sftpV3Err, Buffer.alloc(0)),
    );
    // mockExists defaults to false (file not present), which is the I/O-error path.
    const err = await adapter
      .createExclusive("/remote/new.txt")
      .catch((e: unknown) => e);
    expect(err).not.toBe(sftpV3Err);
    expect((err as Error).cause).toBe(sftpV3Err);
    expect((err as Error).message).toContain("SSH_FX_FAILURE");
    // The wrap must steer users toward diagnosis (server logs) before any
    // retry, since the file is absent and the cause is therefore server-side.
    expect((err as Error).message).toContain("server logs");
    expect(mockExists).toHaveBeenCalledWith("/remote/new.txt");
  });

  test("normalizes SFTPv4+ FILE_ALREADY_EXISTS (numeric 11) to code === 'EEXIST'", async () => {
    const sftpV4Err = Object.assign(new Error("File already exists"), {
      code: 11,
    });
    mockOpen.mockImplementation(
      (
        _path: string,
        _flags: number,
        _attrs: object,
        cb: (err: Error | null, handle: Buffer) => void,
      ) => cb(sftpV4Err, Buffer.alloc(0)),
    );
    const err = await adapter
      .createExclusive("/remote/existing.txt")
      .catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("EEXIST");
  });

  test("passes through an error that already has code === 'EEXIST' without re-wrapping", async () => {
    // If a future ssh2 version normalizes the error to "EEXIST" before we see
    // it, we should pass it through unchanged rather than wrapping it in a new
    // Error (which would add noise to the error chain).
    const alreadyNormalized = Object.assign(new Error("file exists"), {
      code: "EEXIST",
    });
    mockOpen.mockImplementation(
      (
        _path: string,
        _flags: number,
        _attrs: object,
        cb: (err: Error | null, handle: Buffer) => void,
      ) => cb(alreadyNormalized, Buffer.alloc(0)),
    );
    const err = await adapter
      .createExclusive("/remote/existing.txt")
      .catch((e: unknown) => e);
    // Same object reference -- not re-wrapped.
    expect(err).toBe(alreadyNormalized);
    expect((err as NodeJS.ErrnoException).code).toBe("EEXIST");
  });

  test("does not normalize other SFTP error codes (e.g. PERMISSION_DENIED = 3)", async () => {
    const permErr = Object.assign(new Error("Permission denied"), { code: 3 });
    mockOpen.mockImplementation(
      (
        _path: string,
        _flags: number,
        _attrs: object,
        cb: (err: Error | null, handle: Buffer) => void,
      ) => cb(permErr, Buffer.alloc(0)),
    );
    const err = await adapter
      .createExclusive("/remote/noperm.txt")
      .catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe(3);
  });

  test("rejects with the close error when close fails after a successful open", async () => {
    const closeErr = new Error("sftp close error");
    mockClose.mockImplementation(
      (_handle: Buffer, cb: (err: Error | null) => void) => cb(closeErr),
    );
    await expect(adapter.createExclusive("/remote/new.txt")).rejects.toBe(
      closeErr,
    );
  });

  test("propagates original SFTPv3 FAILURE (4) when exists() itself rejects", async () => {
    // When the secondary exists() call fails (e.g., a second network error
    // immediately after the exclusive-open failure), the ambiguity between a
    // genuine race and a real I/O error cannot be resolved. The original
    // openErr is propagated unchanged so callers see the first error rather
    // than a confusing secondary one.
    const sftpV3Err = Object.assign(new Error("Failure"), { code: 4 });
    mockOpen.mockImplementation(
      (
        _path: string,
        _flags: number,
        _attrs: object,
        cb: (err: Error | null, handle: Buffer) => void,
      ) => cb(sftpV3Err, Buffer.alloc(0)),
    );
    mockExists.mockRejectedValue(new Error("network timeout during exists()"));
    const err = await adapter
      .createExclusive("/remote/path.txt")
      .catch((e: unknown) => e);
    expect(err).toBe(sftpV3Err);
    expect((err as NodeJS.ErrnoException).code).toBe(4);
    expect(mockExists).toHaveBeenCalledWith("/remote/path.txt");
  });

  test("rejects with a diagnostic error when the SFTP session is not open", async () => {
    injectSftpSession(false);
    const err = await adapter
      .createExclusive("/remote/new.txt")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("SFTP session is not open");
    expect(message).toMatch(/closed or dropped/);
    expect(message).not.toMatch(/API/i);
    expect(mockOpen).not.toHaveBeenCalled();
  });

  test("bounds an open() whose callback is never invoked via the operation deadline", async () => {
    // The withheld-response liveness class: the server accepts the request but
    // never invokes the open callback, so the exclusive create would await
    // forever. The whole-operation deadline must fail it with the typed error.
    vi.useFakeTimers();
    try {
      stubAdapterLog(adapter);
      mockOpen.mockImplementation(() => {
        // Deliberately never invokes the callback.
      });
      const creating = adapter.createExclusive("/remote/lock.json");
      // Attach before advancing so the mid-advance rejection is not unhandled.
      const assertion = expect(creating).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
      expect(mockClose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds a close() whose callback is never invoked via the operation deadline", async () => {
    // open succeeds (default mock) but the server withholds the close callback;
    // the deadline still fails the operation rather than hanging after the file
    // was created.
    vi.useFakeTimers();
    try {
      stubAdapterLog(adapter);
      mockClose.mockImplementation(() => {
        // Deliberately never invokes the callback.
      });
      const creating = adapter.createExclusive("/remote/lock.json");
      const assertion = expect(creating).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
      expect(mockClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- bounded metadata write/stat/delete --------------------------------------
//
// rename/delete/exists are single metadata round-trips (no payload), so each is
// bounded by the same flat 60 s withSftpOperationDeadline that createExclusive
// uses: a server that accepts the request but withholds the callback fast-fails
// with the typed terminal TransportOperationStalledError rather than riding the
// ~1 h whole-exchange budget. Each op needs its own case (a single op's test does
// not prove the others are wrapped). The dead-session short-circuit for the same
// four ops is covered by the fatal-wrapper-error guard tests below.
//
// Each stall reason is read off the RENDERED chain rather than the raw message:
// the builder gives every fragment beyond the operation's own label a cause link
// of its own, so the rendering boundary is where the operator meets the reason
// and the only place asserting it says anything about what they read.

describe("bounded metadata write/stat/delete", () => {
  test("bounds a withheld rename by the operation deadline", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // rename reads this.options!.retries; an empty object falls back to 5.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        // Accepts the call but never settles: the server withholds the rename ack.
        rename: vi.fn().mockImplementation(() => new Promise(() => {})),
      };
      const renaming = adapter.rename("/remote/a.json", "/remote/b.json");
      // Capture before advancing so the mid-advance rejection is not unhandled.
      const captured = renaming.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      const err = await captured;
      expect(err).toBeInstanceOf(TransportOperationStalledError);
      expect(sanitizeErrorForDisplay(err)).toContain(
        "withheld the rename response",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds a withheld delete by the operation deadline", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        delete: vi.fn().mockImplementation(() => new Promise(() => {})),
      };
      const deleting = adapter.delete("/remote/x.json");
      const captured = deleting.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      const err = await captured;
      expect(err).toBeInstanceOf(TransportOperationStalledError);
      expect(sanitizeErrorForDisplay(err)).toContain(
        "withheld the delete response",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds a withheld exists by the operation deadline", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        exists: vi.fn().mockImplementation(() => new Promise(() => {})),
      };
      const checking = adapter.exists("/remote/lock.json");
      const captured = checking.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      const err = await captured;
      expect(err).toBeInstanceOf(TransportOperationStalledError);
      expect(sanitizeErrorForDisplay(err)).toContain(
        "withheld the stat response",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not deadline a metadata op that completes promptly", async () => {
    // The deadline must not penalize a normal sub-second round-trip: a delete
    // that resolves at once settles on its own result, leaving no pending timer.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        delete: vi.fn().mockResolvedValue(undefined),
      };
      await expect(adapter.delete("/remote/x.json")).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- bounded safeDelete (best-effort, never rejects) -------------------------
//
// safeDelete gets the same 60 s per-op deadline as delete(), so a hostile server
// withholding the delete callback during teardown can no longer stall to the
// coarse whole-exchange budget -- but it must keep its never-reject contract, so
// both the delete's own error AND the deadline's stall error are swallowed: it
// always resolves, just within 60 s.

describe("bounded safeDelete", () => {
  test("bounds a withheld safeDelete by the deadline and still resolves (never rejects)", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        // Withholds the delete callback: the inner promise never settles, so only
        // the deadline can end it.
        delete: vi.fn().mockImplementation(() => new Promise(() => {})),
      };
      const deleting = adapter.safeDelete("/remote/x.json");
      // Resolves (not rejects) once the deadline fires -- the stall error is
      // swallowed to honor the never-reject contract.
      const assertion = expect(deleting).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("swallows a safeDelete error and resolves without waiting the deadline", async () => {
    // A delete that fails for its own reason (e.g. permissions) settles at once;
    // safeDelete swallows it and resolves promptly, never arming a lingering wait.
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      delete: vi.fn().mockRejectedValue(new Error("permission denied")),
    };
    await expect(adapter.safeDelete("/remote/x.json")).resolves.toBeUndefined();
  });

  test("records a withheld safeDelete for re-issue in connection-per-poll mode and still resolves", async () => {
    // The deadline's own expiry is one of the two readings that record a cleanup
    // for re-issue (the other is the session boundary at issue time): the server
    // never answered, so nothing says the file went away. The record must not cost
    // the contract -- the call still resolves within the deadline rather than
    // rejecting.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn(), debug: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        delete: vi.fn().mockImplementation(() => new Promise(() => {})),
      };
      const withheld = protocolTempPath();
      const deleting = adapter.safeDelete(withheld);
      const assertion = expect(deleting).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
      expect(deferredCleanupPaths(adapter)).toEqual([withheld]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("records only the protocol's own temp write, never another file safeDelete is handed", async () => {
    // safeDelete is a public transport method core calls with the shared
    // rendezvous lock path and with names read back from a listing of the
    // directory the PEER writes into, not just with this party's own temp. A
    // record is keyed on a PATH and re-issued at an arbitrary later point, so
    // admitting one of those would let a transiently-failed delete remove
    // whatever has since come to occupy that name. The temp shape's per-file v4
    // UUID is what makes deferral sound, so it is the only shape admitted --
    // every other path keeps the issued-once best-effort behavior it had before
    // the record existed.
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn: vi.fn(), debug: vi.fn() };
    const del = vi.fn().mockRejectedValue(new Error("permission denied"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = { delete: del };

    const refused = [
      // The shared lock path, and the two peer-written names an entry sweep
      // reads out of a directory listing.
      "/remote/peerA-peerB-lock.json",
      "/remote/peerB-abort.json",
      "/remote/peerB-hello.json",
      "/remote/peerB-1700000000-001-42.json",
      // A foreign temp whose stem is not a v4 UUID, which the protocol's own
      // sweeps also decline to treat as theirs.
      "/remote/temp-export.tmp",
      // A valid v4 UUID in the uppercase form uuidv4() never emits.
      `/remote/temp-${randomUUID().toUpperCase()}.tmp`,
      // The temp shape as a DIRECTORY component rather than the file being
      // deleted: the basename is what decides.
      `/remote/temp-${randomUUID()}.tmp/peerB-abort.json`,
    ];
    for (const path of refused)
      await expect(adapter.safeDelete(path)).resolves.toBeUndefined();
    expect(deferredCleanupPaths(adapter)).toEqual([]);

    const ownTemp = protocolTempPath();
    await expect(adapter.safeDelete(ownTemp)).resolves.toBeUndefined();
    expect(deferredCleanupPaths(adapter)).toEqual([ownTemp]);
  });

  test("the default held-session mode records nothing for a safeDelete that fails", async () => {
    // The record and the drain are connection-per-poll machinery: the default mode
    // holds one session for the whole exchange, so a cleanup delete never lands in
    // a gap with no session, and it keeps no state and issues no re-delete.
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn: vi.fn(), debug: vi.fn() };
    const del = vi.fn().mockRejectedValue(new Error("permission denied"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = { delete: del };

    await expect(
      adapter.safeDelete(protocolTempPath()),
    ).resolves.toBeUndefined();

    expect(deferredCleanupPaths(adapter)).toEqual([]);
    // ensureConnected is a no-op in this mode, so nothing re-issues and the one
    // attempt above is the only round trip.
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(del).toHaveBeenCalledTimes(1);
  });
});

// --- capped get --------------------------------------------------------------

describe("capped get", () => {
  test("refuses an over-cap file even when get() resolves before the sink error settles", async () => {
    // Regression: ssh2-sftp-client resolves a stream destination via the read
    // stream's 'end' listener while the sink's cap-exceeded error rejects via a
    // separate listener. For a file that finishes in one or two chunks the
    // 'end' can win the race and resolve(wtr) with the under-cap prefix before
    // the rejection settles. createCappedSink settles its own `result` at the
    // point of detection (inside the sink's write handler), so the adapter
    // surfaces a FrameSizeExceededError regardless of which listener fired or
    // how get() ultimately settles.
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      get: vi.fn().mockImplementation((_path: string, sink: Writable) => {
        // No sink.on('error') here: createCappedSink attaches its own no-op
        // listener, so the cap-fire error is handled without the caller's help.
        sink.write(Buffer.alloc(20)); // under cap (maxBytes 32): retained
        sink.write(Buffer.alloc(20)); // crosses cap: rejects result at detection
        return Promise.resolve(sink); // mimic 'end' winning the race
      }),
    };
    await expect(
      adapter.get("/remote/oversize.bin", { maxBytes: 32 }),
    ).rejects.toBeInstanceOf(FrameSizeExceededError);
  });

  test("rejects at the point of detection without waiting for get() to settle", async () => {
    // The structural guarantee: the over-cap refusal is owned by the sink and
    // does not depend on whether/how ssh2-sftp-client's get() promise settles.
    // Here get() never settles at all; the adapter must still reject as soon as
    // the running total crosses the cap.
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      get: vi.fn().mockImplementation((_path: string, sink: Writable) => {
        // No sink.on('error'): createCappedSink self-handles the cap-fire error.
        sink.write(Buffer.alloc(40)); // crosses cap (maxBytes 32) immediately
        return new Promise<void>(() => {}); // never settles
      }),
    };
    await expect(
      adapter.get("/remote/oversize.bin", { maxBytes: 32 }),
    ).rejects.toBeInstanceOf(FrameSizeExceededError);
  });

  test("returns the buffer for an under-cap file", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      get: vi.fn().mockImplementation((_path: string, sink: Writable) => {
        sink.write(Buffer.from("hello"));
        return Promise.resolve(sink);
      }),
    };
    const buf = await adapter.get("/remote/ok.bin", { maxBytes: 32 });
    expect(buf.toString()).toBe("hello");
  });

  test("bounds a capped read whose transfer never delivers data via the idle deadline", async () => {
    // The withheld-transfer liveness class: the server opens the read stream but
    // writes nothing and never ends it, so `result` would never settle. The size
    // cap cannot catch this (no bytes accumulate); the idle deadline must.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      stubAdapterLog(adapter);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        get: vi.fn().mockImplementation(() => new Promise<Writable>(() => {})),
      };
      const reading = adapter.get("/remote/silent.bin", { maxBytes: 32 });
      const assertion = expect(reading).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not stall a slow but progressing transfer (idle window resets on each chunk)", async () => {
    // The idle bound must not penalize a legitimately large, slow transfer: it
    // resets on every chunk, so a transfer whose chunk gaps stay under the
    // window completes even though its TOTAL time exceeds the window -- which a
    // whole-operation deadline would have wrongly failed.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      stubAdapterLog(adapter);
      let resolveGet!: (s: Writable) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        get: vi.fn().mockImplementation((_path: string, sink: Writable) => {
          sink.write(Buffer.from("a"));
          // Next chunk and completion each land under one idle window after the
          // previous event, but the total span (1.2x the window) exceeds it.
          setTimeout(
            () => sink.write(Buffer.from("b")),
            SFTP_STALL_DEADLINE_MS * 0.6,
          );
          setTimeout(() => resolveGet(sink), SFTP_STALL_DEADLINE_MS * 1.2);
          return new Promise<Writable>((res) => {
            resolveGet = res;
          });
        }),
      };
      const reading = adapter.get("/remote/slow.bin", { maxBytes: 32 });
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS * 1.2 + 1);
      expect((await reading).toString()).toBe("ab");
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds an uncapped read whose transfer never settles via the operation deadline", async () => {
    // The uncapped path returns the library's get() promise directly and has no
    // counting sink (hence no per-chunk progress signal), so it is bounded by a
    // coarse whole-operation deadline. The transport always passes maxBytes, so
    // this path is the defensive backstop.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      stubAdapterLog(adapter);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        get: vi.fn().mockImplementation(() => new Promise(() => {})),
      };
      const reading = adapter.get("/remote/silent.bin"); // no maxBytes: uncapped
      const assertion = expect(reading).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- bounded put (idle window) -----------------------------------------------
//
// Unlike the metadata ops, put carries a payload whose legitimate transfer can
// exceed a flat 60 s deadline over a slow link, so it is bounded by a
// progress-based idle window (createBoundedPutSource): the payload is streamed in
// chunks, and the window resets on each chunk pulled under the write stream's
// ack-driven backpressure. A withheld/stalled (no-progress) upload trips the
// window; a slow-but-progressing one keeps resetting it and is never false-failed.
// Both cases need their own test (one is not sufficient for the other).

describe("bounded put (idle window)", () => {
  test("bounds a put that progresses then stalls via the idle window", async () => {
    // The server accepts and acks the first couple of chunks, then withholds all
    // further acks (stops consuming the source). The idle window, reset by those
    // chunks, then fires on the no-progress gap with the typed terminal error --
    // proving the bound catches a transfer that genuinely started and then stalled,
    // not merely one that never began.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        put: vi.fn().mockImplementation((source: Readable) => {
          // Never resolves: the stall is what settles the adapter's promise.
          return new Promise<never>(() => {
            let consumed = 0;
            source.on("data", () => {
              consumed += 1;
              // Consume two chunks, then withhold acks entirely by pausing -- no
              // further chunks are pulled, so progress stops.
              if (consumed >= 2) source.pause();
            });
          });
        }),
      };
      const payload = Buffer.alloc(3 * SFTP_PUT_PROGRESS_CHUNK_BYTES, 7);
      const writing = adapter.put(payload, "/remote/out.bin");
      const captured = writing.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      const err = await captured;
      expect(err).toBeInstanceOf(TransportOperationStalledError);
      expect(sanitizeErrorForDisplay(err)).toContain("made no upload progress");
    } finally {
      vi.useRealTimers();
    }
  });

  test("stall destroys the source, rejecting the underlying put() onto the no-op fail with no unhandled rejection", async () => {
    // The other stall mocks never settle, so they skip the production ordering:
    // on the idle-stall path the source is destroyed WITH an error, ssh2-sftp-client's
    // rdr.on('error') then rejects its put() promise, and that rejection lands on
    // the adapter's no-op `fail` (the source already settled `result`). This mock
    // mirrors that rdr.on('error') so the ordering is exercised: `result` must still
    // carry the typed terminal error, and the put() rejection must be handled (a
    // missing handler would surface as an unhandled rejection vitest fails on).
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        put: vi.fn().mockImplementation((source: Readable) => {
          // Mirror ssh2-sftp-client _put: reject when the piped source errors
          // (a destroy-with-error included). Never consumes the source, so the
          // idle window fires and drives the destroy.
          return new Promise<string>((_resolve, reject) => {
            source.on("error", (err) => reject(err));
          });
        }),
      };
      const writing = adapter.put(Buffer.from("x"), "/remote/out.bin");
      const captured = writing.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      const err = await captured;
      expect(err).toBeInstanceOf(TransportOperationStalledError);
      expect(sanitizeErrorForDisplay(err)).toContain("made no upload progress");
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not stall a slow but progressing upload (window resets on each chunk)", async () => {
    // The idle bound must not penalize a legitimately large, slow upload: each
    // chunk consumed resets the window, so an upload whose chunk gaps stay under
    // the window completes even though its TOTAL time spans several windows --
    // which a flat whole-operation deadline would have wrongly failed.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // Consume one chunk per half-window: each gap stays under the 60 s window,
      // but the six-chunk total spans ~3 windows.
      const gap = SFTP_STALL_DEADLINE_MS / 2;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        put: vi.fn().mockImplementation((source: Readable) => {
          return new Promise<string>((resolve) => {
            source.on("data", () => {
              source.pause();
              setTimeout(() => source.resume(), gap);
            });
            source.on("end", () => resolve("uploaded data stream"));
          });
        }),
      };
      const payload = Buffer.alloc(6 * SFTP_PUT_PROGRESS_CHUNK_BYTES, 7);
      const writing = adapter.put(payload, "/remote/big.bin");
      let settled: "resolved" | "rejected" | "pending" = "pending";
      void writing.then(
        () => (settled = "resolved"),
        () => (settled = "rejected"),
      );
      // Past a full window, still uploading (not stalled, not yet done): the
      // window has been reset by intervening chunks rather than firing.
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      expect(settled).toBe("pending");
      // Drive the remaining paced chunks and completion.
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS * 3);
      await expect(writing).resolves.toBe("uploaded data stream");
    } finally {
      vi.useRealTimers();
    }
  });

  test("uploads the exact payload bytes through the chunked source", async () => {
    // The chunked source must reassemble to the original payload byte-for-byte --
    // chunking for the progress signal must not corrupt or reorder the upload.
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).options = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn: vi.fn() };
    const received: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      put: vi.fn().mockImplementation((source: Readable) => {
        return new Promise<string>((resolve) => {
          source.on("data", (c: Buffer) => received.push(c));
          source.on("end", () => resolve("uploaded data stream"));
        });
      }),
    };
    // A payload that is not a whole multiple of the chunk size, so the final
    // short chunk is exercised too.
    const payload = Buffer.alloc(SFTP_PUT_PROGRESS_CHUNK_BYTES + 123);
    for (let i = 0; i < payload.length; i += 1)
      payload[i] = (i * 31 + 7) & 0xff;
    await adapter.put(payload, "/remote/exact.bin");
    expect(Buffer.concat(received).equals(payload)).toBe(true);
  });

  test("uploads a [header, payload] chunk list byte-for-byte without concatenation", async () => {
    // The send path hands put() a [header, payload] chunk list instead of one
    // pre-concatenated buffer. The chunked source must stream the parts
    // back-to-back so the on-disk bytes equal header || payload exactly, with the
    // 10-byte header first (byte 0 is the version marker the receiver keys on).
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).options = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn: vi.fn() };
    const received: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      put: vi.fn().mockImplementation((source: Readable) => {
        return new Promise<string>((resolve) => {
          source.on("data", (c: Buffer) => received.push(c));
          source.on("end", () => resolve("uploaded data stream"));
        });
      }),
    };
    const header = Buffer.from([1, 1, 0, 0, 0, 0, 0, 0, 0, 5]);
    // A plain Uint8Array payload (not a Buffer) that crosses a chunk boundary,
    // exercising the zero-copy Buffer-view path and multi-part streaming.
    const payload = new Uint8Array(SFTP_PUT_PROGRESS_CHUNK_BYTES + 40);
    for (let i = 0; i < payload.length; i += 1)
      payload[i] = (i * 17 + 3) & 0xff;
    await adapter.put([header, payload], "/remote/framed.bin");
    expect(
      Buffer.concat(received).equals(Buffer.concat([header, payload])),
    ).toBe(true);
    // The header's first byte reached the server first (parts not reordered).
    expect(received[0][0]).toBe(1);
  });

  test("bounds a stalled [header, payload] chunk-list put via the idle window", async () => {
    // The idle/stall window (and its typed terminal error) must cover the chunk
    // list exactly as it covers a lone Buffer -- this is the hottest (largest)
    // binary send path, so losing the stall guard here would be the regression the
    // task guards against.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        put: vi.fn().mockImplementation((source: Readable) => {
          return new Promise<never>(() => {
            let consumed = 0;
            source.on("data", () => {
              consumed += 1;
              if (consumed >= 2) source.pause();
            });
          });
        }),
      };
      const header = Buffer.alloc(10, 9);
      const payload = Buffer.alloc(3 * SFTP_PUT_PROGRESS_CHUNK_BYTES, 7);
      const writing = adapter.put([header, payload], "/remote/out.bin");
      const captured = writing.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      const err = await captured;
      expect(err).toBeInstanceOf(TransportOperationStalledError);
      expect(sanitizeErrorForDisplay(err)).toContain("made no upload progress");
    } finally {
      vi.useRealTimers();
    }
  });

  test("retries a [header, payload] chunk-list put on transient failure (source rebuilt per attempt)", async () => {
    // The chunk list is re-iterable, so a failed attempt rebuilds the bounded
    // source from the retained parts and re-streams the identical bytes -- the
    // retry the one-shot stream branch cannot offer. Each successful attempt must
    // deliver the full header || payload.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = { retries: 2 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      let calls = 0;
      let delivered: Buffer | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        put: vi.fn().mockImplementation((source: Readable) => {
          calls += 1;
          if (calls < 3) {
            // Consume nothing and reject: the retryable transient failure.
            return Promise.reject(new Error("transient write failure"));
          }
          const received: Buffer[] = [];
          return new Promise<string>((resolve) => {
            source.on("data", (c: Buffer) => received.push(c));
            source.on("end", () => {
              delivered = Buffer.concat(received);
              resolve("uploaded");
            });
          });
        }),
      };
      const header = Buffer.from([1, 1, 0, 0, 0, 0, 0, 0, 0, 3]);
      const payload = Buffer.from([0xaa, 0xbb, 0xcc]);
      const writing = adapter.put([header, payload], "/remote/out.json");
      await vi.advanceTimersByTimeAsync(250);
      await expect(writing).resolves.toBe("uploaded");
      expect(calls).toBe(3);
      expect(delivered?.equals(Buffer.concat([header, payload]))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops retrying when a fatal session error lands between put attempts", async () => {
    // Mirrors the rename() between-attempts case. The first attempt fails with a
    // retryable (non-stall) error while a fatal protocol error lands in the
    // inter-attempt window. The next attempt's dead-session re-check must reject
    // promptly with the terminal stalled error -- without it, that attempt would
    // issue put() on the dead channel and wait out the full idle window before the
    // typed (non-retryable) error ended the retry. The re-check makes it prompt.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      let calls = 0;
      const put = vi.fn().mockImplementation(() => {
        calls += 1;
        // A fatal protocol error lands in the inter-attempt window (as the guarded
        // wrapper 'error' listener would set it), but this attempt still rejects
        // with the retryable transient failure the server already returned.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).fatalSftpError = new Error("Malformed DATA packet");
        return Promise.reject(new Error("transient write failure"));
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { put };
      const writing = adapter.put(Buffer.from("x"), "/remote/out.json");
      const captured = writing.catch((e: unknown) => e);
      // Advance past the 100 ms retry delay; the second attempt's re-check runs and
      // rejects at once, with no need for the 60 s idle window.
      await vi.advanceTimersByTimeAsync(200);
      const err = await captured;
      expect(err).toBeInstanceOf(TransportOperationStalledError);
      expect(sanitizeErrorForDisplay(err)).toContain("Malformed DATA packet");
      // Only the first attempt reached the server; the second short-circuited.
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not retry a one-shot ReadableStream put (single attempt)", async () => {
    // A provided stream is one-shot: a failed attempt half-drains it, so retrying
    // would re-pipe an already-consumed stream and silently upload nothing. The
    // non-Buffer branch must therefore attempt a stream exactly once, never retry.
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).options = {}; // retries falls back to the default of 5
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn: vi.fn() };
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      put: vi.fn().mockImplementation(() => {
        calls += 1;
        return Promise.reject(new Error("transient write failure"));
      }),
    };
    const stream = Readable.from([Buffer.from("x")]);
    await expect(adapter.put(stream, "/remote/out.json")).rejects.toThrow(
      "transient write failure",
    );
    expect(calls).toBe(1);
  });

  test("retries a string-path put (re-runnable source) on transient failure", async () => {
    // A string src is re-runnable -- ssh2-sftp-client opens a fresh read stream per
    // attempt -- so the retry is preserved for it (only the one-shot stream loses it).
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = { retries: 2 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      let calls = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        put: vi.fn().mockImplementation(() => {
          calls += 1;
          if (calls < 3) return Promise.reject(new Error("transient"));
          return Promise.resolve("uploaded");
        }),
      };
      const writing = adapter.put("/local/file.bin", "/remote/out.json");
      // Advance past the two 100 ms retry delays; the third attempt succeeds.
      await vi.advanceTimersByTimeAsync(250);
      await expect(writing).resolves.toBe("uploaded");
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops retrying a string-path put when a fatal session error lands between attempts", async () => {
    // The non-Buffer (string) branch re-checks the dead-session guard before each
    // attempt, mirroring the Buffer branch: a fatal error in the inter-attempt
    // window short-circuits the next attempt with the terminal stalled error
    // instead of issuing put() on the dead channel.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn: vi.fn() };
      let calls = 0;
      const put = vi.fn().mockImplementation(() => {
        calls += 1;
        // A fatal protocol error lands in the inter-attempt window; this attempt
        // still rejects with the retryable transient failure the server returned.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).fatalSftpError = new Error("Malformed DATA packet");
        return Promise.reject(new Error("transient write failure"));
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { put };
      const writing = adapter.put("/local/file.bin", "/remote/out.json");
      const captured = writing.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(200);
      const err = await captured;
      expect(err).toBeInstanceOf(TransportOperationStalledError);
      expect(sanitizeErrorForDisplay(err)).toContain("Malformed DATA packet");
      // Only the first attempt reached the server; the second short-circuited.
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- bounded list ------------------------------------------------------------

interface MockDirEntry {
  filename: string;
  attrs: { mtime: number; size: number };
}

// A stand-in for the internal ssh2 SFTPWrapper that serves a directory through
// the handle-based opendir/readdir/close protocol the adapter's list() drives.
// readdir hands back one batch of `batchSize` entries per call and reports
// end-of-directory as an error whose `code` is SSH_FX_EOF (1) -- ssh2's actual
// contract -- and the mock generates entries lazily so a test can model a flood
// far larger than the cap while recording how many entries were actually
// produced (proving the walk stops early) and that the handle is closed exactly
// once.
function makeBatchedSftp(opts: {
  totalEntries: number;
  batchSize: number;
  makeName?: (i: number) => string;
}) {
  const makeName = opts.makeName ?? ((i: number) => `f${i}.json`);
  let produced = 0;
  let readdirCalls = 0;
  let closeCalls = 0;
  const sftp = {
    opendir: (_path: string, cb: (err: Error | null, handle: Buffer) => void) =>
      cb(null, Buffer.from("handle")),
    readdir: (
      _handle: Buffer,
      cb: (
        err: (Error & { code?: number }) | null,
        list?: MockDirEntry[],
      ) => void,
    ) => {
      readdirCalls += 1;
      if (produced >= opts.totalEntries) {
        cb(Object.assign(new Error("EOF"), { code: 1 }));
        return;
      }
      const batch: MockDirEntry[] = [];
      for (
        let i = 0;
        i < opts.batchSize && produced < opts.totalEntries;
        i += 1
      ) {
        batch.push({
          filename: makeName(produced),
          attrs: { mtime: 7, size: produced },
        });
        produced += 1;
      }
      cb(null, batch);
    },
    close: (_handle: Buffer, cb: (err: Error | null) => void) => {
      closeCalls += 1;
      cb(null);
    },
  };
  return {
    sftp,
    get produced() {
      return produced;
    },
    get readdirCalls() {
      return readdirCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
  };
}

describe("bounded list", () => {
  test("maps a normal directory's entries and closes the handle", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const mock = makeBatchedSftp({ totalEntries: 3, batchSize: 2 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = { sftp: mock.sftp };

    const result = await adapter.list("/remote/dir");
    expect(result.map((e) => e.name)).toEqual([
      "f0.json",
      "f1.json",
      "f2.json",
    ]);
    // ssh2 reports mtime in seconds; FileInfo.modifyTime is ms.
    expect(result[0].modifyTime).toBe(7000);
    expect(result[2].size).toBe(2);
    expect(mock.closeCalls).toBe(1);
    // A legitimate listing completes in a small, fixed number of round-trips
    // (here 2 batches + the EOF read) -- far under the liveness round-trip cap,
    // so the bound never rejects normal exchange traffic.
    expect(mock.readdirCalls).toBeLessThan(MAX_LISTING_READDIR_BATCHES);
  });

  test("refuses a directory with more entries than the cap without enumerating it all", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const batchSize = 4096;
    // A flood far larger than the cap: list() must refuse it after at most the
    // cap plus one batch, never producing the whole set -- otherwise the SFTP
    // adapter (the path with the in-scope adversary) allocates proportional to
    // the attacker-chosen entry count.
    const mock = makeBatchedSftp({
      totalEntries: MAX_DIRECTORY_ENTRIES + 100_000,
      batchSize,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = { sftp: mock.sftp };

    await expect(adapter.list("/remote/hostile")).rejects.toBeInstanceOf(
      DirectoryListingBoundsError,
    );
    expect(mock.produced).toBeLessThanOrEqual(
      MAX_DIRECTORY_ENTRIES + batchSize,
    );
    expect(mock.produced).toBeLessThan(MAX_DIRECTORY_ENTRIES + 100_000);
    // The handle is closed despite the refusal, and not double-closed.
    expect(mock.closeCalls).toBe(1);
  });

  test("rejects an entry whose filename exceeds the maximum length", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const longName = `${"x".repeat(MAX_FILENAME_LENGTH + 1)}.json`;
    const mock = makeBatchedSftp({
      totalEntries: 1,
      batchSize: 1,
      makeName: () => longName,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = { sftp: mock.sftp };

    await expect(adapter.list("/remote/hostile")).rejects.toBeInstanceOf(
      DirectoryListingBoundsError,
    );
    expect(mock.closeCalls).toBe(1);
  });

  test("accepts a directory at exactly the entry cap", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const mock = makeBatchedSftp({
      totalEntries: MAX_DIRECTORY_ENTRIES,
      batchSize: 4096,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = { sftp: mock.sftp };

    const result = await adapter.list("/remote/dir");
    expect(result).toHaveLength(MAX_DIRECTORY_ENTRIES);
    expect(mock.closeCalls).toBe(1);
  });

  test("propagates a non-EOF readdir error and closes the handle", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const ioErr = Object.assign(new Error("permission denied"), { code: 3 });
    let closeCalls = 0;
    const sftp = {
      opendir: (_path: string, cb: (err: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("handle")),
      readdir: (
        _handle: Buffer,
        cb: (err: (Error & { code?: number }) | null) => void,
      ) => cb(ioErr),
      close: (_handle: Buffer, cb: (err: Error | null) => void) => {
        closeCalls += 1;
        cb(null);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = { sftp };

    await expect(adapter.list("/remote/dir")).rejects.toBe(ioErr);
    expect(closeCalls).toBe(1);
  });

  test("rejects with a diagnostic error when the SFTP session is not open", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = { sftp: null };
    const err = await adapter.list("/remote/dir").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("SFTP session is not open");
    expect(message).toMatch(/closed or dropped/);
    expect(message).not.toMatch(/API/i);
  });

  test("bounds a server that returns empty non-EOF batches forever and closes the handle", async () => {
    // The liveness DoS: a hostile server returns valid but empty (count = 0)
    // non-EOF readdir batches without end. Each advances neither the entry-count
    // nor the filename-length size bound and never carries the EOF status, so
    // the batch loop would recurse forever. The round-trip cap must fail it with
    // the typed terminal error and still close the open handle. Fake timers keep
    // the test purely about the round-trip cap: list()'s wall-clock deadline is
    // cleared by the cap's settle() before list() rejects, but faking setTimeout
    // means it is never even registered with the real event loop.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      let readdirCalls = 0;
      let closeCalls = 0;
      const sftp = {
        opendir: (_path: string, cb: (err: Error | null, h: Buffer) => void) =>
          cb(null, Buffer.from("handle")),
        readdir: (
          _handle: Buffer,
          cb: (
            err: (Error & { code?: number }) | null,
            list?: unknown[],
          ) => void,
        ) => {
          readdirCalls += 1;
          // Deliver the empty batch asynchronously so the bounded recursion
          // unwinds the stack each round, mirroring ssh2's per-batch
          // socket-event dispatch; a synchronous callback would recurse to the
          // cap in one frame. queueMicrotask is not faked, so the flood still
          // drives to the cap without advancing timers.
          queueMicrotask(() => cb(null, []));
        },
        close: (_handle: Buffer, cb: (err: Error | null) => void) => {
          closeCalls += 1;
          cb(null);
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { sftp };

      await expect(adapter.list("/remote/hang")).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      // Stopped at the round-trip cap rather than looping forever.
      expect(readdirCalls).toBe(MAX_LISTING_READDIR_BATCHES);
      // Handle closed on the bounded-failure path, exactly once.
      expect(closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds a server that never invokes the readdir callback via the wall-clock deadline", async () => {
    // The other liveness DoS: the server accepts the opendir but withholds the
    // readdir callback entirely, so the call would await an unresolved promise
    // forever. No batch ever arrives, so only the wall-clock deadline can fail
    // it -- and it must still close the open handle.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      stubAdapterLog(adapter);
      let readdirCalls = 0;
      let closeCalls = 0;
      const sftp = {
        opendir: (_path: string, cb: (err: Error | null, h: Buffer) => void) =>
          cb(null, Buffer.from("handle")),
        // Never calls back: the directory read hangs.
        readdir: () => {
          readdirCalls += 1;
        },
        close: (_handle: Buffer, cb: (err: Error | null) => void) => {
          closeCalls += 1;
          cb(null);
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { sftp };

      const listing = adapter.list("/remote/silent");
      // Attach before advancing so the mid-advance rejection is not unhandled.
      const assertion = expect(listing).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
      // Tried readdir once, then hung; the deadline, not the round-trip cap,
      // bounded it.
      expect(readdirCalls).toBe(1);
      // Handle closed on the bounded-failure path, exactly once.
      expect(closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("settles on the deadline even when the close callback is also withheld", async () => {
    // Regression: settle() must not gate the listing's settlement on the close
    // callback. A server can withhold close exactly as it withholds a readdir,
    // so if settle() awaited close() the deadline would fire, clear its own
    // timer, then hang forever inside the un-returning close -- restoring the
    // unbounded wait the deadline exists to defeat. The listing must reject on
    // the deadline regardless of whether close ever calls back; the handle close
    // is attempted best-effort but does not block the rejection.
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      stubAdapterLog(adapter);
      let closeCalls = 0;
      const sftp = {
        opendir: (_path: string, cb: (err: Error | null, h: Buffer) => void) =>
          cb(null, Buffer.from("handle")),
        // Withholds the readdir callback, so the deadline -- not a batch -- ends
        // the operation.
        readdir: () => {},
        // Attempted, but its own callback is never delivered.
        close: (_handle: Buffer, _cb: (err: Error | null) => void) => {
          closeCalls += 1;
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = { sftp };

      const listing = adapter.list("/remote/silent-close");
      // Attach before advancing so the mid-advance rejection is not unhandled.
      const assertion = expect(listing).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      await assertion;
      // close was attempted as best-effort cleanup even though its callback
      // never arrived; the settlement did not wait on it.
      expect(closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- slow-operation warning (observability) ----------------------------------
//
// The non-fatal warning fires at SFTP_SLOW_OPERATION_WARNING_MS (below the 60 s
// read fast-fail) and reports observed progress where a cheap signal exists:
// bytes-so-far for a capped get, entries-so-far for a list, the payload size for a
// put, and elapsed-only for the atomic ops. It never alters the result. The
// adapter's log is replaced with a spy so the warning line can be asserted without
// touching the console. (withSlowOperationWarning's own contract -- threshold,
// non-fatal passthrough, no-warn-when-fast -- is covered in
// sftpLivenessGuard.test.ts; these tests pin the per-operation wiring.)

describe("slow-operation warning", () => {
  test("reports bytes-so-far for a slow capped get and still resolves (non-fatal)", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn };
      let resolveGet!: (s: Writable) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        get: vi.fn().mockImplementation((_path: string, sink: Writable) => {
          // 100 bytes arrive up front, then the transfer completes after the
          // warning threshold but before the idle deadline.
          sink.write(Buffer.alloc(100));
          setTimeout(
            () => resolveGet(sink),
            SFTP_SLOW_OPERATION_WARNING_MS + 5_000,
          );
          return new Promise<Writable>((res) => {
            resolveGet = res;
          });
        }),
      };
      const reading = adapter.get("/remote/big.bin", { maxBytes: 1_000 });
      await vi.advanceTimersByTimeAsync(SFTP_SLOW_OPERATION_WARNING_MS + 1);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain("file read");
      expect(message).toContain("/remote/big.bin");
      expect(message).toContain("100 bytes received so far");
      // Non-fatal: the read still completes with its bytes.
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await reading).length).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports the payload size for a slow put and still resolves (non-fatal)", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      const warn = vi.fn();
      let resolvePut!: () => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn };
      // put reads this.options!.retries; an empty object falls back to the default.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).options = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        put: vi.fn().mockImplementation(
          () =>
            new Promise<void>((res) => {
              resolvePut = res;
            }),
        ),
      };
      const writing = adapter.put(Buffer.alloc(2048), "/remote/out.tmp");
      await vi.advanceTimersByTimeAsync(SFTP_SLOW_OPERATION_WARNING_MS + 1);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain("file write");
      expect(message).toContain("/remote/out.tmp");
      expect(message).toContain("2048 byte payload");
      resolvePut();
      await expect(writing).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports entries-so-far for a slow list while the read deadline still bounds it", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn };
      let readdirCalls = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        sftp: {
          opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
            cb(null, Buffer.from("handle")),
          readdir: (
            _h: Buffer,
            cb: (
              e: (Error & { code?: number }) | null,
              list?: unknown[],
            ) => void,
          ) => {
            // First batch delivers two entries; the next readdir callback is
            // withheld, so the listing is bounded by the 60 s deadline -- but the
            // 30 s warning fires first, reporting the two entries already read.
            if (++readdirCalls === 1)
              cb(null, [
                { filename: "a.json", attrs: { mtime: 1, size: 1 } },
                { filename: "b.json", attrs: { mtime: 1, size: 1 } },
              ]);
          },
          close: (_h: Buffer, cb: () => void) => cb(),
        },
      };
      const listing = adapter.list("/remote/dir");
      const assertion = expect(listing).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(SFTP_SLOW_OPERATION_WARNING_MS + 1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("2 entries read so far");
      // The terminal deadline still fires; the warning did not displace it.
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("warns elapsed-only (no progress snippet) for a slow atomic exists and still resolves", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      const warn = vi.fn();
      let resolveExists!: (value: boolean) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = {
        exists: vi.fn().mockImplementation(
          () =>
            new Promise<boolean>((res) => {
              resolveExists = res;
            }),
        ),
      };
      const checking = adapter.exists("/remote/lock");
      await vi.advanceTimersByTimeAsync(SFTP_SLOW_OPERATION_WARNING_MS + 1);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain("existence check");
      expect(message).toContain("/remote/lock");
      // No payload, so elapsed-only: no parenthesized progress snippet.
      expect(message).not.toContain("(");
      resolveExists(true);
      await expect(checking).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- fatal wrapper-error guard -----------------------------------------------

// A stand-in for the raw ssh2 SFTPWrapper as a real EventEmitter, so the guarded
// 'error' listener and Node's zero-listener throw semantics are exercised
// faithfully. It carries the handle-based methods connect()'s presence guard
// requires plus the EventEmitter surface (`on`), and tracks whether the
// directory methods were invoked so a test can prove a post-crash operation
// rejects WITHOUT issuing a request to the dead session.
function makeWrapper() {
  const wrapper = new EventEmitter() as EventEmitter & {
    open: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    opendir: ReturnType<typeof vi.fn>;
    readdir: ReturnType<typeof vi.fn>;
  };
  wrapper.open = vi.fn();
  wrapper.close = vi.fn();
  wrapper.opendir = vi.fn();
  wrapper.readdir = vi.fn();
  return wrapper;
}

describe("fatal wrapper-error guard", () => {
  test("connect attaches exactly one 'error' listener to the raw wrapper", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const wrapper = makeWrapper();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: wrapper,
      connect: vi.fn().mockResolvedValue(undefined),
      client: noDelayClient(),
    };
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    expect(wrapper.listenerCount("error")).toBe(1);
  });

  test("a repeated connect on the same wrapper does not duplicate the listener", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const wrapper = makeWrapper();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: wrapper,
      connect: vi.fn().mockResolvedValue(undefined),
      client: noDelayClient(),
    };
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // Idempotent on the same wrapper instance: no second listener, because the
    // wrapper identity is unchanged. Accumulation would climb against the
    // WRAPPER's own default ceiling; the raise the constructor applies is on the
    // shared ssh2 Client, a different emitter.
    expect(wrapper.listenerCount("error")).toBe(1);
  });

  test("a fresh wrapper after a reconnect gets its own listener", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const first = makeWrapper();
    const client = {
      sftp: first as EventEmitter,
      connect: vi.fn().mockResolvedValue(undefined),
      client: noDelayClient(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = client;
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    // Model ssh2-sftp-client handing back a new wrapper after an end()/connect()
    // cycle: a different object identity. The guard must attach to it too.
    const second = makeWrapper();
    client.sftp = second;
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    expect(first.listenerCount("error")).toBe(1);
    expect(second.listenerCount("error")).toBe(1);
  });

  test("an operation after a fatal wrapper error rejects promptly with the terminal cause", async () => {
    // The captured-cause nice-to-have: once a fatal 'error' has killed the
    // session, the next operation rejects at once with the typed terminal error
    // (carrying the real cause) instead of issuing a request to the dead wrapper
    // and waiting out the 60 s liveness deadline.
    const adapter = new SSH2SFTPClientAdapter();
    const wrapper = makeWrapper();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: wrapper,
      connect: vi.fn().mockResolvedValue(undefined),
      client: noDelayClient(),
    };
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    wrapper.emit("error", new Error("Malformed NAME packet"));

    const listErr = await adapter.list("/remote/dir").catch((e: unknown) => e);
    expect(listErr).toBeInstanceOf(TransportOperationStalledError);
    expect(listErr).toBeInstanceOf(UsageError);
    expect(sanitizeErrorForDisplay(listErr)).toContain("Malformed NAME packet");
    // It did not even attempt to drive the dead session.
    expect(wrapper.opendir).not.toHaveBeenCalled();

    // Same terminal, prompt rejection on the lock path.
    const createErr = await adapter
      .createExclusive("/remote/lock.json")
      .catch((e: unknown) => e);
    expect(createErr).toBeInstanceOf(TransportOperationStalledError);
    expect(wrapper.open).not.toHaveBeenCalled();
  });

  test("the remaining server-driven methods short-circuit after a fatal error", async () => {
    // The crash fix's entry guard covers list/get/createExclusive, but put,
    // delete, rename, exists, and the uncapped get() also drive the server and
    // must short-circuit too. After a fatal error the SFTP channel is destroyed
    // while the TCP/SSH socket stays up (a hostile server keeps it alive), so a
    // request buffered on the closing channel never calls back -- it HANGS rather
    // than erroring. Each guarded method must instead reject promptly with the
    // typed terminal error WITHOUT issuing a request to the dead session; the
    // catch + the never-called mock together prove both. safeDelete is the
    // exception: it MUST honor its never-reject contract (callers run it in catch
    // blocks), so on a dead session it RESOLVES promptly as a best-effort no-op.
    const adapter = new SSH2SFTPClientAdapter();
    const wrapper = makeWrapper();
    // The ssh2-sftp-client surface put/delete/rename/exists/get delegate to. None
    // may be called once the session is dead; a call would buffer on the closing
    // channel and hang.
    const put = vi.fn();
    const del = vi.fn();
    const rename = vi.fn();
    const exists = vi.fn();
    const get = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: wrapper,
      connect: vi.fn().mockResolvedValue(undefined),
      put,
      delete: del,
      rename,
      exists,
      get,
      client: noDelayClient(),
    };
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    wrapper.emit("error", new Error("Malformed DATA packet"));

    const putErr = await adapter
      .put(Buffer.from("x"), "/remote/out.json")
      .catch((e: unknown) => e);
    expect(putErr).toBeInstanceOf(TransportOperationStalledError);
    expect(putErr).toBeInstanceOf(UsageError);
    expect(sanitizeErrorForDisplay(putErr)).toContain("Malformed DATA packet");
    expect(put).not.toHaveBeenCalled();

    const deleteErr = await adapter
      .delete("/remote/out.json")
      .catch((e: unknown) => e);
    expect(deleteErr).toBeInstanceOf(TransportOperationStalledError);
    expect(del).not.toHaveBeenCalled();

    const renameErr = await adapter
      .rename("/remote/a.json", "/remote/b.json")
      .catch((e: unknown) => e);
    expect(renameErr).toBeInstanceOf(TransportOperationStalledError);
    expect(rename).not.toHaveBeenCalled();

    const existsErr = await adapter
      .exists("/remote/out.json")
      .catch((e: unknown) => e);
    expect(existsErr).toBeInstanceOf(TransportOperationStalledError);
    expect(exists).not.toHaveBeenCalled();

    // The uncapped get() path (maxBytes === undefined) is guarded at get()'s
    // entry alongside the capped path; assert it rejects terminally and never
    // drives the dead stream.
    const getErr = await adapter
      .get("/remote/out.json")
      .catch((e: unknown) => e);
    expect(getErr).toBeInstanceOf(TransportOperationStalledError);
    expect(get).not.toHaveBeenCalled();

    // safeDelete honors its never-reject contract: on a dead session it RESOLVES
    // (best-effort no-op) rather than rejecting, and does not drive the dead
    // session. Promptness is implicit -- the default test timeout would catch a
    // hang on the still-alive socket.
    await expect(
      adapter.safeDelete("/remote/out.json"),
    ).resolves.toBeUndefined();
    expect(del).not.toHaveBeenCalled();
  });
});

// --- session heartbeat and TCP keepalive -------------------------------------
//
// connect() enables kernel TCP keepalive on the underlying socket (a transport-
// layer backstop) and arms the application heartbeat that issues a periodic no-op
// realPath (which, unlike a transport keepalive, resets the server's SFTP-command
// idle timer). The heartbeat must fire on the interval when the session is idle,
// and must stop on every terminal path -- end() and a fatal wrapper error -- so
// nothing keeps beating on a torn-down or dead session. The interval/idle/
// in-flight-suppression logic itself is unit-tested against SftpHeartbeat; these
// pin the adapter's wiring of it.

describe("session heartbeat and TCP keepalive", () => {
  // A faithful connected-client mock: the raw wrapper (for the fatal-'error'
  // guard), the ssh2 Client with setNoDelay + a socket carrying setKeepAlive, and
  // realPath (the heartbeat's no-op) + end (teardown).
  function connectMock() {
    const setKeepAlive = vi.fn();
    const realPath = vi.fn().mockResolvedValue("/remote");
    const end = vi.fn().mockResolvedValue(true);
    const wrapper = makeWrapper();
    const client = {
      sftp: wrapper,
      connect: vi.fn().mockResolvedValue(undefined),
      client: { setNoDelay: vi.fn(), _sock: { setKeepAlive } },
      realPath,
      end,
    };
    return { client, wrapper, setKeepAlive, realPath, end };
  }

  test("connect enables kernel TCP keepalive on the underlying socket", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const { client, setKeepAlive } = connectMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = client;
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    expect(setKeepAlive).toHaveBeenCalledWith(
      true,
      SFTP_TCP_KEEPALIVE_DELAY_MS,
    );
  });

  test("connect warns (and continues) when the socket's setKeepAlive is unavailable", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn() };
    const { client } = connectMock();
    // Model an ssh2 upgrade that relocated the socket: no _sock. connect must
    // still succeed (keepalive is transport hygiene, not a correctness need).
    delete (client.client as { _sock?: unknown })._sock;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = client;
    await expect(
      adapter.connect({ host: "h", maxReconnectAttempts: 0 }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("setKeepAlive"));
  });

  test("arms a heartbeat that issues a realPath keepalive once the session goes idle", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      stubAdapterLog(adapter);
      const { client, realPath } = connectMock();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = client;
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      // Nothing yet just before the interval; the no-op fires once it elapses.
      await vi.advanceTimersByTimeAsync(SFTP_HEARTBEAT_INTERVAL_MS - 1);
      expect(realPath).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(realPath).toHaveBeenCalledWith(".");
    } finally {
      vi.useRealTimers();
    }
  });

  test("end() stops the heartbeat so no keepalive fires after teardown", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      stubAdapterLog(adapter);
      const { client, realPath } = connectMock();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = client;
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      await adapter.end();
      // However long the (now closed) session sits, no keepalive is issued.
      await vi.advanceTimersByTimeAsync(SFTP_HEARTBEAT_INTERVAL_MS * 3);
      expect(realPath).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a fatal wrapper error stops the heartbeat", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SSH2SFTPClientAdapter();
      stubAdapterLog(adapter);
      const { client, wrapper, realPath } = connectMock();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).client = client;
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      // The session dies: the heartbeat must not keep pinging a dead channel that
      // can never answer.
      wrapper.emit("error", new Error("Malformed NAME packet"));
      await vi.advanceTimersByTimeAsync(SFTP_HEARTBEAT_INTERVAL_MS * 3);
      expect(realPath).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- out-of-band ssh2 Client event routing -----------------------------------

describe("out-of-band client event callbacks", () => {
  // The adapter passes explicit error/end/close callbacks to the
  // ssh2-sftp-client constructor so the library's globalListener routes an
  // out-of-band ssh2 Client event to the project logger instead of its default
  // console.error/console.log. The library stores those callbacks on the client
  // as `eventCallbacks` (the same 2nd-positional-arg coupling the "Upgrading the
  // SFTP Stack" checklist tracks); invoke them directly to pin the routing and
  // -- security-relevant -- the escaping of the server-controlled error message.
  function eventCallbacks(adapter: SSH2SFTPClientAdapter): {
    error: (err: unknown) => void;
    end: () => void;
    close: () => void;
  } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (adapter as any).client.eventCallbacks;
  }

  test("an out-of-band client error logs at error level with the message escaped", () => {
    const adapter = new SSH2SFTPClientAdapter();
    const error = vi.fn();
    const trace = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { error, trace };

    // A hostile SSH_MSG_DISCONNECT description: ANSI escape + bidi override +
    // newline. ssh2 reads it straight off the wire onto err.message, so logging
    // it raw would let a hostile server spoof a log line or smuggle a terminal
    // escape into an operator's console or --log-file.
    eventCallbacks(adapter).error(new Error("\x1b[31mbad\u202e\nFORGED"));

    expect(error).toHaveBeenCalledTimes(1);
    const line = error.mock.calls[0][0] as string;
    // The escaped form is present; the raw control/ANSI/bidi/newline bytes are
    // gone. Teeth: dropping sanitizeForDisplay surfaces the raw bytes here.
    expect(line).toContain("\\x1b[31mbad\\u202e\\x0aFORGED");
    expect(line).not.toContain("\x1b");
    expect(line).not.toContain("\u202e");
    expect(line).not.toContain("\n");
    expect(trace).not.toHaveBeenCalled();
  });

  test("a private-key block in an out-of-band client error is redacted", () => {
    const adapter = new SSH2SFTPClientAdapter();
    const error = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { error, trace: vi.fn() };

    // Defense in depth: should a future ssh2 path ever interpolate key material
    // into a Client-level error, sanitizeErrorForDisplay's redaction backstop
    // must strip the PEM block before it can persist to a --log-file -- not merely
    // escape it (plain escaping would leave the key bytes readable). Teeth:
    // routing through sanitizeForDisplay instead of sanitizeErrorForDisplay fails
    // this.
    eventCallbacks(adapter).error(
      new Error(
        "auth failed: -----BEGIN OPENSSH PRIVATE KEY-----\n" +
          "SECRETKEYBYTES\n-----END OPENSSH PRIVATE KEY-----",
      ),
    );

    const line = error.mock.calls[0][0] as string;
    expect(line).toContain("[redacted private key]");
    expect(line).not.toContain("SECRETKEYBYTES");
    expect(line).not.toContain("BEGIN OPENSSH");
  });

  test("out-of-band end and close events log at trace level, not error", () => {
    const adapter = new SSH2SFTPClientAdapter();
    const error = vi.fn();
    const trace = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { error, trace };

    eventCallbacks(adapter).end();
    eventCallbacks(adapter).close();

    expect(trace).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
  });
});

// --- session recovery (mid-exchange re-dial) ---------------------------------
//
// On a CLEAN session loss (the ssh2-sftp-client `sftp` property cleared, no fatal
// protocol error, no liveness stall) the adapter transparently re-dials through
// connect() -- reusing the retained full connect options (pinned host key, stored
// credentials, reconnect bound) -- and re-issues the operation ONCE. A fatal
// error, a stall, a memory bound, or a host-key mismatch on the re-dial stays
// terminal. These pin the trigger, the bound, the per-op idempotency resolvers,
// and the teardown suppression, all driven by a mock whose `sftp` property toggles
// to model a server dropping the one long-lived session mid-exchange.

describe("session recovery", () => {
  // A raw SFTPWrapper stand-in carrying the four methods connect()'s presence
  // guard checks plus the EventEmitter `on` the fatal-'error' guard attaches to.
  function sessionWrapper(overrides: Record<string, unknown> = {}) {
    return {
      open: vi.fn(),
      close: vi.fn(),
      opendir: vi.fn(),
      readdir: vi.fn(),
      on: vi.fn(),
      ...overrides,
    };
  }

  // A mock ssh2-sftp-client whose `sftp` property is live until `state.live` is
  // flipped false (a mid-exchange drop) and restored to `wrapper` by connect() (a
  // re-dial). High-level ops are attached per test and read `state.live` to model
  // ssh2-sftp-client's ERR_NOT_CONNECTED rejection on a cleared session.
  //
  // The raw ssh2 Client under it is an EventEmitter, as the pinned ssh2's is: the
  // recovery re-dial watches its 'end'/'close' pair to tell a transport that still
  // owes its 'close' from one whose events have all been delivered, and a Client
  // that cannot be watched puts the re-dial on a different branch entirely. Here
  // no lifecycle event is emitted at all, which is the drop these tests model --
  // the raw-wrapper class, whose whole sequence has run by the time recovery is
  // entered.
  function droppable(wrapper: ReturnType<typeof sessionWrapper>) {
    const state = { live: true };
    const connect = vi.fn().mockImplementation(async () => {
      state.live = true;
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    return { client, connect, state };
  }

  // The exact error ssh2-sftp-client's haveConnection() raises on a cleared
  // session: message "<name>: No SFTP connection available", code
  // "ERR_NOT_CONNECTED" (node_modules/ssh2-sftp-client/src/utils.js +
  // constants.js). Pinned here rather than matched by a loose string so a library
  // bump that changes the identity is caught, per DEPENDENCY_PINS.md exact-pinning.
  const notConnected = (name: string) =>
    Object.assign(new Error(`${name}: No SFTP connection available`), {
      code: "ERR_NOT_CONNECTED",
    });

  const stub = (adapter: SSH2SFTPClientAdapter) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      error: vi.fn(),
    };
  };
  const install = (adapter: SSH2SFTPClientAdapter, client: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = client;
  };

  test("recovers from a clean drop on list() and completes via one re-dial", async () => {
    const wrapper = sessionWrapper({
      // Serve a two-entry directory: one batch, then EOF on the next readdir.
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (() => {
        let served = false;
        return (
          _h: Buffer,
          cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
        ) => {
          if (served) return cb(Object.assign(new Error("EOF"), { code: 1 }));
          served = true;
          cb(null, [
            { filename: "a.json", attrs: { mtime: 1, size: 1 } },
            { filename: "b.json", attrs: { mtime: 1, size: 2 } },
          ]);
        };
      })(),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, connect, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    expect(connect).toHaveBeenCalledTimes(1);

    // Mid-exchange clean drop: the next list() finds the session cleared.
    state.live = false;
    const result = await adapter.list("/remote/dir");

    expect(result.map((e) => e.name)).toEqual(["a.json", "b.json"]);
    // Exactly one recovery re-dial (initial connect + one).
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("recovers on createExclusive() and resolves a re-issued own-EEXIST as success", async () => {
    // The pre-drop create landed, so the re-issue sees its OWN lock file: the
    // server returns FILE_ALREADY_EXISTS (11), createExclusiveOnce normalizes it to
    // code "EEXIST", and the reissue resolver treats that as success rather than a
    // spurious lock conflict.
    const wrapper = sessionWrapper({
      open: vi
        .fn()
        .mockImplementation(
          (
            _p: string,
            _f: number,
            _a: object,
            cb: (e: Error | null, h: Buffer) => void,
          ) =>
            cb(
              Object.assign(new Error("exists"), { code: 11 }),
              Buffer.alloc(0),
            ),
        ),
      close: vi.fn((_h: Buffer, cb: (e: Error | null) => void) => cb(null)),
    });
    const { client, connect, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    await expect(
      adapter.createExclusive("/remote/lock.json"),
    ).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2);
    // Only the re-issue reached open(); the first attempt short-circuited on the
    // cleared session.
    expect(wrapper.open).toHaveBeenCalledOnce();
  });

  test("fails terminally with no re-dial when max_reconnect_attempts is 0", async () => {
    // The mid-exchange reconnection budget IS max_reconnect_attempts in the default
    // held-session mode: a value of 0 permits zero reconnections, so the very first
    // drop fails terminally and no re-dial is even attempted. Terminal (a
    // UsageError) so the caller maps it to a non-zero exit, never a silent resolve
    // or hang. The message describes THIS case rather than the exhausted-budget one:
    // an allowance of zero lost sessions is not an allowance this exchange spent,
    // so quoting one would misdescribe an exchange that never reconnected at all.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    state.live = false;

    const err = await adapter.list("/remote/dir").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain(
      "max_reconnect_attempts=0 permits no mid-exchange reconnection",
    );
    expect((err as Error).message).toContain("this first drop is terminal");
    expect((err as Error).message).not.toContain("0 lost sessions");
    // Both remedies are still named by their operator-reachable names.
    expect((err as Error).message).toContain("--connection-per-poll");
    // No re-dial: the budget permits none, so only the initial connect ran.
    expect(connect).toHaveBeenCalledTimes(1);
    // The session was still lost, and the budget bounds sessions lost rather than
    // re-dials made, so the drop the budget refused is counted like any other.
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  // A client that dials once and refuses every dial after it, so a drop's recovery
  // is stranded. That is what leaves an arm at the cumulative budget's check with
  // the session still gone, which is the only state the check refuses in: an arm
  // arriving over a session a re-dial restored finds it live and re-issues on it
  // without reaching the check at all.
  function undialableAfterFirst() {
    const wrapper = sessionWrapper();
    const state = { live: true };
    let dials = 0;
    const connect = vi.fn().mockImplementation(async () => {
      dials += 1;
      if (dials > 1) throw new Error("connection refused");
      state.live = true;
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    return { client, connect, state };
  }

  test("refuses a sibling arm at the cap boundary, on the unit their shared drop spent", async () => {
    // The cap boundary reached by a FAN rather than a serial run. One drop tears
    // two operations; the arm that reaches the transition first charges the loss
    // and takes the last unit, and when its re-dial fails the sibling behind it
    // arrives with no session to re-issue on and reads the budget its own loss
    // just filled. The refusal is fail-closed: the sibling raises the terminal
    // error rather than being given a dial the budget cannot pay for, so the whole
    // fan buys exactly the one re-dial their single lost session paid for. The
    // reading and what it costs an operator are in docs/spec/CHANNEL_SECURITY.md,
    // "What the accounting counts"; the case below is its serial counterpart.
    vi.useFakeTimers();
    const { client, connect, state } = undialableAfterFirst();
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    try {
      // A budget of one puts the boundary at the first drop: charging it leaves
      // nothing for the sibling.
      await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
      state.live = false;

      // Both arms are torn by the one drop and enter recovery over it; the
      // transition queue admits them one at a time.
      const arms = Promise.all([
        adapter.list("/remote/a").catch((e: unknown) => e),
        adapter.list("/remote/b").catch((e: unknown) => e),
      ]);
      // Past the 1 s dialing-retry delay of BOTH arms, so an arm the budget let
      // dial would settle inside this window too and be read as an outcome rather
      // than as a test that ran out of time.
      await vi.advanceTimersByTimeAsync(5_000);
      const outcomes = await arms;

      const refused = outcomes.filter((o) => o instanceof UsageError);
      expect(refused).toHaveLength(1);
      expect((refused[0] as Error).message).toContain(
        "the mid-exchange reconnection budget is exhausted",
      );
      // The arm that charged fails with its dial, not with the budget: it spent
      // the unit and got the re-dial the unit bought.
      const charging = outcomes.filter((o) => !(o instanceof UsageError));
      expect(charging).toHaveLength(1);
      expect((charging[0] as Error).message).toContain("connection refused");
      // One session lost is one unit, however many arms it tore: the sibling's
      // refusal charges nothing of its own.
      expect(adapter.midExchangeReconnectCount).toBe(1);
      // The initial dial plus the charging arm's two attempts. The refused
      // sibling adds none: no dial is issued past the budget.
      expect(connect).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reaches that boundary serially on the same loss and with the same dials", async () => {
    // The serial counterpart of the fan above, and what says the sibling's
    // refusal costs the operator nothing: with the last unit charged and its
    // re-dial failed, the NEXT operation raises the same terminal error over that
    // same charged loss and dials nothing further. Both shapes therefore end the
    // exchange on the loss the budget's last unit paid for, having spent the same
    // dials; what the fan changes is only which operation hears it.
    vi.useFakeTimers();
    const { client, connect, state } = undialableAfterFirst();
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    try {
      await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
      state.live = false;

      const charging = adapter.list("/remote/a").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      const chargingError = await charging;
      expect(chargingError).not.toBeInstanceOf(UsageError);
      expect((chargingError as Error).message).toContain("connection refused");
      expect(adapter.midExchangeReconnectCount).toBe(1);
      const dialsSpent = connect.mock.calls.length;
      expect(dialsSpent).toBe(3);

      const next = adapter.list("/remote/b").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      const nextError = await next;
      expect(nextError).toBeInstanceOf(UsageError);
      expect((nextError as Error).message).toContain(
        "the mid-exchange reconnection budget is exhausted",
      );
      // The same lost session, charged once and no more, and no dial past the
      // budget: the operation that hears the refusal buys nothing either.
      expect(adapter.midExchangeReconnectCount).toBe(1);
      expect(connect).toHaveBeenCalledTimes(dialsSpent);
    } finally {
      vi.useRealTimers();
    }
  });

  test("fails immediately on a host-key mismatch during the recovery re-dial", async () => {
    // A host-key mismatch on the re-dial is terminal for free via connect()'s
    // existing "Host denied" retry predicate: it must not spend the reconnect
    // budget re-running the key exchange against the same untrusted host.
    const wrapper = sessionWrapper();
    const state = { live: true };
    let calls = 0;
    const connect = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        state.live = true;
        return;
      }
      throw new Error("Host denied (verification failed)");
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn().mockResolvedValue(true),
    };
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    // A non-zero reconnect budget makes the single-attempt assertion meaningful: a
    // working predicate refuses to spend it on a host-key rejection.
    await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
    state.live = false;

    await expect(adapter.list("/remote/dir")).rejects.toThrow("Host denied");
    // Initial connect + exactly one terminal re-dial attempt (budget untouched).
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("resolves a re-issued delete whose source is already absent", async () => {
    // A pre-drop delete that landed returns SSH_FX_NO_SUCH_FILE (code 2) on the
    // re-issue; the resolver maps it to success so poll()'s consume-delete poller
    // is not stopped by a delete that in fact succeeded.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    let deleteCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("delete");
      deleteCalls += 1;
      throw Object.assign(new Error("No such file"), { code: 2 });
    });
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    await expect(adapter.delete("/remote/x.json")).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2);
    // Only the re-issue reached the server; the first attempt saw the cleared
    // session.
    expect(deleteCalls).toBe(1);
  });

  test("resolves a re-issued rename whose destination already exists", async () => {
    // A pre-drop rename that landed leaves the source gone (code 2) on the
    // re-issue; because every rename destination is self-prefixed, a present
    // destination is unambiguously our own landed attempt, so the resolver
    // confirms it via exists(dest) and resolves as success.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    let renameCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("rename");
      renameCalls += 1;
      throw Object.assign(new Error("No such file From: a To: b"), { code: 2 });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).exists = vi.fn().mockResolvedValue(true);
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    await expect(
      adapter.rename("/remote/id-joining.json", "/remote/id-hello.json"),
    ).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(renameCalls).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).exists).toHaveBeenCalledWith(
      "/remote/id-hello.json",
    );
  });

  test("re-dials on the exact ERR_NOT_CONNECTED clean-loss identity", async () => {
    // Pin the trigger against ssh2-sftp-client's high-level clean-loss rejection:
    // the first delete rejects with the exact ERR_NOT_CONNECTED identity while the
    // session is cleared, and recovery re-dials and re-issues to success.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("delete");
      // The re-issue succeeds cleanly (the file was still present).
    });
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    await expect(adapter.delete("/remote/x.json")).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("does NOT re-dial on a liveness stall even with the session cleared", async () => {
    // A TransportOperationStalledError is terminal, never a reconnect trigger:
    // re-dialing on a stall would hand a withholding server a free liveness reset.
    // Even with the session property cleared, a stall must propagate without a
    // re-dial.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = vi
      .fn()
      .mockRejectedValue(new TransportOperationStalledError("withheld"));
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    await expect(adapter.delete("/remote/x.json")).rejects.toBeInstanceOf(
      TransportOperationStalledError,
    );
    // No re-dial: the stall is terminal.
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("does not re-dial once teardown has begun", async () => {
    // end() latches `closing`, so an op racing a clean close fails terminally
    // rather than launching a re-dial whose readyTimeout would slow the close and
    // whose fresh session would outlive teardown. The refusal is at the
    // classifier, before the recovery path is entered at all: with no
    // reconnection budget left, an op admitted to that path would surface the
    // budget-exhausted error instead of the session diagnostic, so the diagnostic
    // is what says recovery was refused rather than merely thwarted.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await adapter.end();
    state.live = false;

    await expect(adapter.list("/remote/dir")).rejects.toThrow(
      "SFTP session is not open",
    );
    // No re-dial during teardown.
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("does not re-dial before any connect (no retained options)", async () => {
    // A server-driven op reaching the recovery path before connect() ran has
    // nothing to re-dial with; the original diagnostic must surface unchanged
    // rather than a re-dial or the retained-options invariant error.
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    const connect = vi.fn();
    install(adapter, { sftp: null, connect });

    await expect(adapter.list("/remote/dir")).rejects.toThrow(
      "SFTP session is not open",
    );
    expect(connect).not.toHaveBeenCalled();
  });

  test("recovers from a clean drop on get() via one re-dial", async () => {
    // get() is wired to withSessionRecovery identically to list/createExclusive:
    // the first attempt finds the session cleared, the re-dial re-establishes it,
    // and the re-issued read returns the file (the capped sink is rebuilt per call).
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).get = vi
      .fn()
      .mockImplementation((_p: string, sink: Writable) => {
        if (!state.live) return Promise.reject(notConnected("get"));
        sink.write(Buffer.from("hello"));
        return Promise.resolve(sink);
      });
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const buf = await adapter.get("/remote/f.bin", { maxBytes: 32 });
    expect(buf.toString()).toBe("hello");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("recovers from a clean drop on exists() via one re-dial", async () => {
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).exists = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("exists");
      return true;
    });
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    await expect(adapter.exists("/remote/lock.json")).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("recovers a re-runnable put (Buffer) via one re-dial", async () => {
    // A Buffer source is re-runnable: the re-issue rebuilds it and re-streams the
    // identical payload. retries: 0 keeps put()'s inner retry loop from burning
    // attempts on the dropped session before the recovery re-dial takes over.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    let putCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).put = vi.fn().mockImplementation(() => {
      if (!state.live) return Promise.reject(notConnected("put"));
      putCalls += 1;
      return Promise.resolve("ok");
    });
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", retries: 0, maxReconnectAttempts: 2 });
    state.live = false;

    await expect(
      adapter.put(Buffer.from("payload"), "/remote/out.tmp", { flags: "w" }),
    ).resolves.toBe("ok");
    expect(connect).toHaveBeenCalledTimes(2);
    // Only the re-issue reached the server; the first attempt saw the cleared
    // session.
    expect(putCalls).toBe(1);
  });

  test("does NOT recovery-wrap a one-shot stream put (terminal, no re-pipe)", async () => {
    // A provided ReadableStream is one-shot: a first attempt half-drains it, so a
    // recovery re-issue would re-pipe an already-consumed stream and silently
    // upload nothing. put() must bypass withSessionRecovery for it, so a clean drop
    // fails terminally with no re-dial rather than re-piping a drained stream.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).put = vi
      .fn()
      .mockImplementation(() => Promise.reject(notConnected("put")));
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", retries: 0, maxReconnectAttempts: 2 });
    state.live = false;

    const stream = Readable.from([Buffer.from("one-shot")]);
    await expect(adapter.put(stream, "/remote/out.tmp")).rejects.toThrow(
      "No SFTP connection available",
    );
    // No re-dial: the one-shot stream path never enters recovery.
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("does NOT recovery-wrap an append-mode put even from a re-runnable source", async () => {
    // flags:"a" is not re-issue-idempotent: a recovery re-issue would double-write
    // the payload. So an append put is never recovery-wrapped even from a Buffer,
    // and a clean drop fails it terminally with no re-dial. (Every caller passes
    // "w" today; this pins the gate against a future append caller.)
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).put = vi
      .fn()
      .mockImplementation(() => Promise.reject(notConnected("put")));
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", retries: 0, maxReconnectAttempts: 2 });
    state.live = false;

    await expect(
      adapter.put(Buffer.from("payload"), "/remote/out.log", { flags: "a" }),
    ).rejects.toThrow("No SFTP connection available");
    // No re-dial: append mode bypasses recovery, so a clean drop is terminal.
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("counts a successful recovery re-dial in reconnectCount", async () => {
    // A one-shot successful recovery re-dial re-establishes the session, so it must
    // register in the operator's reconnect metric even though connect()'s own
    // counter (which bumps only on an internal retry past the first) stays at zero.
    const wrapper = sessionWrapper({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    state.live = false;

    await adapter.list("/remote/dir");
    // The recovery re-dial's connect() succeeded on its first attempt, so connect()
    // added zero; the recovery increment is what surfaces the survived drop. It
    // registers in BOTH the merged reconnect total and the mid-exchange sub-count,
    // which the end-of-run summary reports apart from connect-time retries.
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("warns the operator on the first mid-exchange re-dial, naming cause and remedy", async () => {
    // A silent recovery would hide a partner whose server caps session lifetime,
    // exactly the case this feature exists for. The first re-dial must WARN, and
    // the line must name the drop, the likely (partner-side, unchangeable) cause,
    // and the remedy so the operator can act.
    const wrapper = sessionWrapper({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;
    await adapter.list("/remote/dir");

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    // (a) states the drop was mid-exchange and transparently re-dialed, and
    //     reassures that the exchange continues
    expect(message).toContain("dropped mid-exchange");
    expect(message).toContain("transparently");
    expect(message).toContain("the exchange continues");
    // (b) names the likely cause: a partner-side session-duration/idle cap the
    //     operator cannot change
    expect(message).toContain("session-duration or idle limit");
    expect(message).toContain("cannot");
    // (c) names the real remedy under the held-session model by the flag the
    //     operator can actually type, and is honest that a longer poll interval
    //     helps only for a query-frequency reaction
    expect(message).toContain("--polling-frequency");
    expect(message).toContain("--connection-per-poll");
    // (d) does NOT repeat the stale, inaccurate claim that raising the poll
    //     interval holds the session open less often (it does not: one session is
    //     held open for the whole exchange regardless of poll cadence)
    expect(message).not.toContain("held open less often");
    // (e) states what is left of the cumulative budget, so "the exchange
    //     continues" is not read as an open-ended survival guarantee: one of the
    //     two re-dials is spent, and exhausting the budget is terminal.
    expect(message).toContain(
      "1 further mid-exchange re-dial is allowed by max_reconnect_attempts=2",
    );
    expect(message).toContain("before the exchange fails");
  });

  test("escalates by rate, not one warn line per mid-exchange drop", async () => {
    // A chronic capper must stay visible without spamming a warn line every poll
    // cycle: after the first re-dial the adapter warns only every
    // SFTP_REDIAL_WARN_INTERVAL-th, so a full interval of drops yields two lines
    // (the first drop and the Nth), never one per drop.
    const wrapper = sessionWrapper({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    // A budget comfortably above the escalation interval so the cap does not fire:
    // this test exercises the warn cadence, not the reconnection cap.
    await adapter.connect({ host: "h", maxReconnectAttempts: 100 });

    // Drop and recover once per poll for a full escalation interval; connect()
    // restores state.live on each re-dial.
    for (let i = 0; i < SFTP_REDIAL_WARN_INTERVAL; i += 1) {
      state.live = false;
      await adapter.list("/remote/dir");
    }

    // Every drop was transparently recovered ...
    expect(adapter.reconnectCount).toBe(SFTP_REDIAL_WARN_INTERVAL);
    expect(adapter.midExchangeReconnectCount).toBe(SFTP_REDIAL_WARN_INTERVAL);
    // ... but the operator saw only two warn lines (the first drop and the Nth),
    // never one per drop.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.length).toBeLessThan(SFTP_REDIAL_WARN_INTERVAL);
    // Both messages reassure that the exchange survives the drop and stay honest
    // about the current single-session model (no "held open less often" claim).
    const first = warn.mock.calls[0][0] as string;
    expect(first).toContain("the exchange continues");
    expect(first).not.toContain("held open less often");
    const escalation = warn.mock.calls[1][0] as string;
    expect(escalation).toContain(`${SFTP_REDIAL_WARN_INTERVAL} times`);
    expect(escalation).toContain("the exchange continues");
    // Each line reports the budget REMAINING at that point, so a rising count is
    // legible as an approach to the terminal failure, not just as a tally.
    expect(first).toContain("99 further mid-exchange re-dials are allowed");
    expect(escalation).toContain(
      `${100 - SFTP_REDIAL_WARN_INTERVAL} further mid-exchange re-dials are allowed`,
    );
    // The escalation hedges the cause exactly as the first-drop message does: the
    // adapter cannot tell a session-duration cap from an idle cap, so it names
    // both rather than asserting one, and never claims to know it is a duration cap.
    expect(escalation).toContain("session-duration or idle limit");
    expect(escalation).not.toContain("capping session lifetime");
    expect(escalation).toContain("--polling-frequency");
    expect(escalation).toContain("connection-per-poll");
    expect(escalation).not.toContain("held open less often");
  });

  test("closes a session dialed during teardown and surfaces the original loss", async () => {
    // Latch `closing` WHILE the recovery re-dial is in flight (the entry-guard
    // teardown test above covers `closing` latched BEFORE the op). The post-re-dial
    // check must then tear down the freshly-dialed session so it does not outlive
    // the close, and surface the original clean-loss error rather than re-issuing.
    const wrapper = sessionWrapper();
    const state = { live: true };
    let connectCalls = 0;
    let signalRedialStarted!: () => void;
    const redialStarted = new Promise<void>((r) => {
      signalRedialStarted = r;
    });
    let releaseRedial!: () => void;
    const redialGate = new Promise<void>((r) => {
      releaseRedial = r;
    });
    const connect = vi.fn().mockImplementation(async () => {
      connectCalls += 1;
      if (connectCalls === 1) {
        state.live = true;
        return;
      }
      // The recovery re-dial: signal that connect() has begun, then park until the
      // test latches `closing`, then complete the handshake so the post-re-dial
      // check runs against a freshly-established session.
      signalRedialStarted();
      await redialGate;
      state.live = true;
    });
    const end = vi.fn().mockResolvedValue(true);
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end,
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const listing = adapter.list("/remote/dir").catch((e: unknown) => e);
    // The re-dial's connect() is now parked mid-handshake.
    await redialStarted;
    // Teardown begins mid-re-dial, then the handshake completes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).closing = true;
    releaseRedial();

    const err = await listing;
    // The original clean-loss error surfaces, not a re-issued result.
    expect((err as Error).message).toContain("SFTP session is not open");
    // The freshly-dialed session was torn down (its client.end() ran) and the op
    // did not re-issue into the closing adapter.
    expect(end).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(2);
    // The partner took this session before the teardown latched, so it is counted
    // as the lost session it was: what the teardown aborted is the RECOVERY, and
    // the counters report sessions lost rather than recoveries completed.
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("preserves the original rename error when the re-issue's exists() probe rejects", async () => {
    // rename()'s re-issue confirms a landed pre-drop rename via exists(dest); if
    // that probe itself rejects, the ambiguity is unresolved, so the outcome is
    // the undetermined one -- carrying the ORIGINAL rename error, not the probe's
    // failure (mirrors createExclusiveOnce's SFTPv3 fallback to the original
    // openErr).
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("rename");
      // The re-issue sees the source gone (a landed pre-drop rename): code 2.
      throw Object.assign(new Error("rename: No such file From: a To: b"), {
        code: 2,
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).exists = vi
      .fn()
      .mockRejectedValue(new Error("network timeout during exists()"));
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const err = await adapter
      .rename("/remote/id-joining.json", "/remote/id-hello.json")
      .catch((e: unknown) => e);
    // The original rename error (code 2) is the cause, not the exists() rejection,
    // and it is the original that reaches the operator: asserted where they read
    // it, since the wrapper's own message names only the destination.
    expect(err).toBeInstanceOf(TransportPublishIndeterminateError);
    expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe(2);
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).toContain("No such file");
    expect(rendered).not.toContain("network timeout");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  // The re-issue's existence probe is a server round trip like the rename it
  // confirms, so it is issued through the private existsOnce: the seam carrying
  // the outstanding-operation count, the per-operation deadline, and the
  // dead-session guard. The cases below pin what that seam buys on this path;
  // what the count itself buys is pinned in the connection-per-poll block, the
  // one mode where a boundary can fall while the probe is on the wire. Whichever
  // way the probe fails, it confirms nothing, so the rename fails carrying the
  // ORIGINAL error -- and fails promptly, rather than riding the whole-exchange
  // budget.

  test("refuses the re-issue's probe on a session already dead rather than hanging on it", async () => {
    // A fatal protocol error can land on the re-issued rename's own reply: the
    // wrapper is destroyed, so a stat posted onto it would buffer on a channel
    // that never answers and ride the whole-exchange budget. The probe's entry
    // guard rejects instead, and the rename fails with the error it already had.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("rename");
      // The re-issue sees the source gone (a landed pre-drop rename), and the
      // reply that carries it is malformed: the guarded wrapper 'error' listener
      // kills the session before the probe is issued.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).fatalSftpError = new Error("Malformed DATA packet");
      throw Object.assign(new Error("rename: No such file From: a To: b"), {
        code: 2,
      });
    });
    // A probe that reached this client would never answer, so the assertions
    // below stand only because none is issued.
    const probe = pendingExists(client);
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const err = await adapter
      .rename("/remote/id-joining.json", "/remote/id-hello.json")
      .catch((e: unknown) => e);
    expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe(2);
    expect(probe.exists).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("bounds a re-issue probe whose answer the server withholds by the per-operation deadline", async () => {
    // The other prompt-failure guarantee: no fatal error, so the probe IS issued,
    // and the server simply never answers the stat. Without the adapter's own
    // per-operation bound the rename would hang to the whole-exchange budget.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("rename");
      throw Object.assign(new Error("rename: No such file From: a To: b"), {
        code: 2,
      });
    });
    const probe = pendingExists(client);
    const adapter = new SSH2SFTPClientAdapter({ stallDeadlineMs: 50 });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const err = await adapter
      .rename("/remote/id-joining.json", "/remote/id-hello.json")
      .catch((e: unknown) => e);
    // The probe was issued and timed out; the ambiguity it could not resolve
    // leaves the ORIGINAL rename error, not the stall, as the cause. One probe,
    // not two: an unanswered destination has already left the question open, so
    // the source is not asked and a second deadline is not spent.
    expect(probe.exists).toHaveBeenCalledOnce();
    expect(err).not.toBeInstanceOf(TransportOperationStalledError);
    expect(err).toBeInstanceOf(TransportPublishIndeterminateError);
    expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe(2);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("reports an absent destination whose source is gone too as undetermined", async () => {
    // Both probes answer, and both answer false. That is NOT evidence the rename
    // failed: in delete mode the peer's consume-delete removes exactly this
    // party's own publish, so a rename that landed durably and was consumed
    // inside the recovery window reads identically to one that never landed. The
    // rejection stands -- nothing here reports an unpublished message as sent --
    // but as the undetermined outcome it is.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("rename");
      throw Object.assign(new Error("rename: No such file From: a To: b"), {
        code: 2,
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).exists = vi.fn().mockResolvedValue(false);
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const err = await adapter
      .rename("/remote/id-joining.json", "/remote/id-hello.json")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportPublishIndeterminateError);
    expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe(2);
    expect(sanitizeErrorForDisplay(err)).toContain("No such file");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  // Renders the undetermined outcome of a rename into `toPath` exactly as a
  // terminal CLI error is rendered, so the assertions below read what an operator
  // would see rather than what went into the Error.
  async function renderUndeterminedPublish(toPath: string): Promise<string> {
    const wrapper = sessionWrapper();
    const { client, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("rename");
      throw Object.assign(new Error("_rename: No such file or directory"), {
        code: 2,
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).exists = vi.fn().mockResolvedValue(false);
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const err = await adapter
      .rename("/remote/id-msg.json", toPath)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportPublishIndeterminateError);
    return sanitizeErrorForDisplay(err);
  }

  test("the undetermined publish's operative sentence outlives a destination that spends the display budget", async () => {
    // The rendering boundary, not the raw message: sanitizeErrorForDisplay is the
    // only path a terminal CLI error takes to a terminal, and it caps each link of
    // the cause chain at COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH. The sentence the
    // operator must act on -- that the publish MAY have arrived -- has to clear
    // that cap even against an ack name long enough to spend the whole budget,
    // since a truncation reaching it would leave prose asserting the opposite.
    const rendered = await renderUndeterminedPublish(
      `/remote/${"a".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH)}-ack.json`,
    );
    const [publishLink, ...causeLinks] = rendered.split("\ncaused by: ");
    expect(publishLink).toContain(
      "the publish may or may not have reached the partner",
    );
    // The truncation the cap does impose falls on the destination, which trails
    // the sentence rather than preceding it.
    expect(publishLink).toContain(DISPLAY_TRUNCATION_MARKER);
    expect(publishLink.indexOf("Destination:")).toBeGreaterThan(
      publishLink.indexOf("may or may not"),
    );
    // The transport's own status is a separate link with a separate budget.
    expect(causeLinks.join("\n")).toContain(
      "_rename: No such file or directory",
    );
  });

  test("the undetermined publish escapes a destination carrying ANSI and a line break", async () => {
    // `toPath` is partner-derived on the ack and rendezvous rename paths (the ack
    // name's middle segments are unconstrained), so the destination is escaped
    // like every other path this app names in an error -- a hostile name must not
    // drive the operator's terminal or forge a log line.
    const rendered = await renderUndeterminedPublish(
      "/remote/\u001b[31mid\n2026-01-01 not a real log line-ack.json",
    );
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\n2026-01-01");
    expect(rendered).toContain("x1b[31mid");
    expect(rendered).toContain("x0a2026-01-01");
    expect(rendered).toContain(
      "the publish may or may not have reached the partner",
    );
  });

  test("surfaces the original rename error when the source is still on the server", async () => {
    // The other half of that pair: the destination is absent and the source is
    // still there, so nothing moved this party's file and the publish
    // determinately did not land. Its own error surfaces, unwrapped -- the
    // undetermined classification must not swallow a determinate failure.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("rename");
      throw Object.assign(new Error("rename: No such file From: a To: b"), {
        code: 2,
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).exists = vi
      .fn()
      .mockImplementation(async (path: string) =>
        path.endsWith("id-joining.json"),
      );
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const err = await adapter
      .rename("/remote/id-joining.json", "/remote/id-hello.json")
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TransportPublishIndeterminateError);
    expect((err as NodeJS.ErrnoException).code).toBe(2);
    expect((err as Error).message).toContain("No such file");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("leaves a FIRST-attempt rename's absence and dest-exists conflict terminal, with no probe", async () => {
    // The idempotency relaxation is the RE-ISSUE's alone. On a live session there
    // is no session loss to recover from, so a genuine absence and a persistent
    // "operation did not take effect" both surface as themselves -- and neither
    // consults the destination, which is what would turn a real conflict into a
    // silent success.
    const wrapper = sessionWrapper();
    const { client, connect } = droppable(wrapper);
    // The raw numeric SFTP status ssh2-sftp-client passes through on `code`.
    let failure: Error & { code: number } = Object.assign(
      new Error("rename: No such file From: a To: b"),
      { code: 2 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      throw failure;
    });
    const probe = pendingExists(client);
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    // retries: 0 holds the status-4 case to a single attempt; the retry budget
    // itself is pinned by the "rename retry" block.
    await adapter.connect({ host: "h", maxReconnectAttempts: 2, retries: 0 });

    await expect(
      adapter.rename("/remote/temp-send.tmp", "/remote/id-0-12.json"),
    ).rejects.toThrow("No such file");

    failure = Object.assign(new Error("_rename: Failure"), { code: 4 });
    await expect(
      adapter.rename("/remote/temp-send.tmp", "/remote/id-0-12.json"),
    ).rejects.toThrow("_rename: Failure");

    expect(probe.exists).not.toHaveBeenCalled();
    // The session never dropped, so nothing re-dialed either.
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("suppresses the heartbeat's beat while the re-issue probe is on the wire", async () => {
    // The default held-session mode is the one that arms the heartbeat, and
    // ssh2-sftp-client permits one operation at a time. The probe passes through
    // the same bracket that keeps the heartbeat's in-flight count, so a beat
    // falling while it is outstanding is suppressed rather than posted alongside
    // it. The control at the end runs the same clock over a settled probe.
    vi.useFakeTimers();
    try {
      const wrapper = sessionWrapper();
      const { client, state } = droppable(wrapper);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).rename = vi.fn().mockImplementation(async () => {
        if (!state.live) throw notConnected("rename");
        throw Object.assign(new Error("rename: No such file From: a To: b"), {
          code: 2,
        });
      });
      const probe = pendingExists(client);
      // A deadline well past the heartbeat interval, so the beat below is what
      // the probe outlives rather than its own bound.
      const adapter = new SSH2SFTPClientAdapter({
        stallDeadlineMs: SFTP_HEARTBEAT_INTERVAL_MS * 10,
      });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      state.live = false;

      const publish = adapter.rename(
        "/remote/id-joining.json",
        "/remote/id-hello.json",
      );
      await probe.issued;

      await vi.advanceTimersByTimeAsync(SFTP_HEARTBEAT_INTERVAL_MS);
      expect(client.realPath).not.toHaveBeenCalled();

      probe.answer(true);
      await expect(publish).resolves.toBeUndefined();
      // Same idle stretch, nothing outstanding: the beat fires, so the
      // suppression above was the probe's doing and not a stopped heartbeat.
      await vi.advanceTimersByTimeAsync(SFTP_HEARTBEAT_INTERVAL_MS);
      expect(client.realPath).toHaveBeenCalledWith(".");

      await adapter.end();
    } finally {
      vi.useRealTimers();
    }
  });

  // A raw SFTPWrapper stand-in that serves an empty directory (EOF on the first
  // readdir), so each recovered list() re-dials and returns []. Used by the cap
  // tests to drive a series of clean drops through withSessionRecovery.
  const emptyDirWrapper = () =>
    sessionWrapper({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });

  test("recovers up to the cap, then fails the next drop terminally (default mode)", async () => {
    // max_reconnect_attempts caps the CUMULATIVE number of mid-exchange
    // reconnections in the default held-session mode. With a budget of 3, three
    // drops each recover; the fourth exhausts the budget and fails the exchange
    // terminally with the actionable message rather than re-dialing again.
    const { client, connect, state } = droppable(emptyDirWrapper());
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
    for (let i = 0; i < 3; i += 1) {
      state.live = false;
      await adapter.list("/remote/dir");
    }
    // Three survived drops: budget spent exactly to the cap.
    expect(adapter.midExchangeReconnectCount).toBe(3);
    expect(connect).toHaveBeenCalledTimes(4); // initial + 3 recoveries

    // The fourth drop is refused: terminal UsageError, no further re-dial.
    state.live = false;
    const err = await adapter.list("/remote/dir").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain("max_reconnect_attempts=3");
    // Names the partner-server drop and both remedies, each by the name the
    // operator can actually reach: the flag and the config field.
    expect((err as Error).message).toContain("session-duration or idle limit");
    expect((err as Error).message).toContain("--connection-per-poll");
    expect((err as Error).message).toContain("connection_per_poll: true");
    // No re-dial for the refused drop, and the drop itself still counted: the
    // budget bounds sessions lost, and this one was lost.
    expect(connect).toHaveBeenCalledTimes(4);
    expect(adapter.midExchangeReconnectCount).toBe(4);
  });

  test("the cumulative budget does not reset on a successful op (no reset on progress)", async () => {
    // The budget is STRICTLY cumulative: a successful op between drops does not
    // reset the count. A session-capping server makes progress every cycle, so a
    // reset-on-progress budget would never bound it. Prove it by interleaving
    // drop-free (progressing) list()s between the drops and showing the cap is
    // still reached at the same cumulative drop count.
    const { client, state } = droppable(emptyDirWrapper());
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    // Drop #1 recovers.
    state.live = false;
    await adapter.list("/remote/dir");
    expect(adapter.midExchangeReconnectCount).toBe(1);
    // Progress: a successful op with no drop must NOT reset the count.
    await adapter.list("/remote/dir");
    expect(adapter.midExchangeReconnectCount).toBe(1);

    // Drop #2 recovers -- now at the cap.
    state.live = false;
    await adapter.list("/remote/dir");
    expect(adapter.midExchangeReconnectCount).toBe(2);
    // More progress between the drop and the exhausting drop.
    await adapter.list("/remote/dir");

    // Drop #3 exhausts the budget: reachable only because the intervening
    // successful ops did NOT reset the cumulative count.
    state.live = false;
    const err = await adapter.list("/remote/dir").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain("reconnection budget");
    // Two recovered and the third refused, all three counted as the sessions the
    // partner took.
    expect(adapter.midExchangeReconnectCount).toBe(3);
  });

  test("warns on the last permitted re-dial, even below the escalation interval", async () => {
    // The rate cadence alone leaves a hole at any budget under
    // SFTP_REDIAL_WARN_INTERVAL -- the default 3 included: the first drop warns,
    // the escalation step never fires, and the operator's next signal would be the
    // terminal error. So the last re-dial the budget permits always warns, saying
    // plainly that the next drop ends the exchange.
    const { client, state } = droppable(emptyDirWrapper());
    const adapter = new SSH2SFTPClientAdapter();
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    // The shipped default: a budget well below the escalation interval.
    await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
    for (let i = 0; i < 3; i += 1) {
      state.live = false;
      await adapter.list("/remote/dir");
    }

    // Two lines: the first drop and the last permitted re-dial, not one per drop
    // and not silence after the first.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain(
      "2 further mid-exchange re-dials are allowed",
    );
    const last = warn.mock.calls[1][0] as string;
    expect(last).toContain(
      "That was the last re-dial allowed by max_reconnect_attempts=3",
    );
    expect(last).toContain("the next mid-exchange drop ends the exchange");

    // And the warning told the truth: the next drop is terminal.
    state.live = false;
    await expect(adapter.list("/remote/dir")).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  test("a teardown re-dial is exempt from the cap, uncounted and unwarned, and still lands", async () => {
    // The authenticated abort-marker write and the terminal-frame drain re-dial
    // during teardown. Even with the mid-exchange budget already exhausted, a
    // teardown re-dial (signaled by beginTeardown) is ALLOWED -- so the fast-fail
    // marker still lands -- and is neither counted nor warned (it is teardown
    // mechanics, not a survived mid-exchange drop).
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    let putCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).put = vi.fn().mockImplementation(() => {
      if (!state.live) return Promise.reject(notConnected("put"));
      putCalls += 1;
      return Promise.resolve("ok");
    });
    const adapter = new SSH2SFTPClientAdapter();
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    // Budget 0: a NON-teardown drop would fail terminally on the first drop.
    await adapter.connect({ host: "h", retries: 0, maxReconnectAttempts: 0 });
    // Teardown begins (as close() and the abort-marker write both signal), then the
    // held session drops and the marker-style write is issued.
    adapter.beginTeardown();
    state.live = false;

    await expect(
      adapter.put(Buffer.from("abort"), "/remote/id-abort.tmp", { flags: "w" }),
    ).resolves.toBe("ok");
    // The re-dial happened despite the exhausted budget: the marker landed.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(putCalls).toBe(1);
    // ... and it was charged to neither reconnect metric and raised no warning.
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(adapter.reconnectCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

// --- mid-exchange drop whose close the partner withholds ---------------------
//
// A partner server that drops the SFTP session mid-exchange and then withholds
// its connection close leaves the transport half-open -- this side's write half
// ended, no FIN back -- with ssh2-sftp-client's `sftp` property STILL SET, since
// the library clears it only from the ssh2 Client's 'close'. The operation on the
// wire cannot complete on a transport that carries nothing, so it rides the
// per-operation liveness deadline and rejects with the terminal stalled error.
// Recovery therefore reads the TRANSPORT rather than the session property: it
// forces the ended transport closed so the library clears the session, then
// re-dials and re-issues exactly as it does for a partner that closes. A stall
// over a transport that is still live stays terminal, which is the distinction
// these cases pin. Measured against a real ssh2 server (docs/spec/DEPENDENCY_PINS.md);
// the end-to-end exercise is test/integration/heldSessionWithheldClose.test.ts.

describe("mid-exchange drop against a partner that withholds its close", () => {
  interface WithheldCloseSocket {
    setKeepAlive: () => void;
    writableEnded: boolean;
    readableEnded: boolean;
    destroyed: boolean;
    destroy?: () => void;
  }

  // An ssh2-sftp-client stand-in modeling the pinned library against that partner.
  // `dropWithholdingClose` is the server's cut as ssh2 leaves it: a half of the
  // transport ended, the session property untouched, and no 'close' -- so nothing
  // clears the session until this side destroys the socket, which is what the
  // library's global 'close' listener answers. `clearsOnDestroy: false` models an
  // ssh2 that no longer emits that 'close'; omitting `destroy` from the socket
  // models one that no longer exposes the seam at all.
  function withholdingPartner(
    options: { clearsOnDestroy?: boolean; withDestroy?: boolean } = {},
  ) {
    const state = { live: true };
    const session = {
      open: vi.fn(),
      close: vi.fn(),
      opendir: vi.fn(),
      readdir: vi.fn(),
      on: vi.fn(),
    };
    const socket: WithheldCloseSocket = {
      setKeepAlive: () => {},
      writableEnded: false,
      readableEnded: false,
      destroyed: false,
    };
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    const destroy = vi.fn(() => {
      socket.destroyed = true;
      if (options.clearsOnDestroy === false) return;
      state.live = false;
      rawClient.emit("close");
    });
    if (options.withDestroy !== false) socket.destroy = destroy;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: socket,
      end: vi.fn(() => {
        socket.writableEnded = true;
      }),
    });
    // ssh2 mints a fresh socket per dial, so a re-dial leaves neither half ended.
    const connect = vi.fn().mockImplementation(async () => {
      state.live = true;
      socket.writableEnded = false;
      socket.readableEnded = false;
      socket.destroyed = false;
    });
    const client = {
      get sftp() {
        return state.live ? session : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const dropWithholdingClose = (
      half: "writable" | "readable" = "writable",
    ) => {
      if (half === "writable") socket.writableEnded = true;
      else socket.readableEnded = true;
    };
    return { client, connect, socket, state, destroy, dropWithholdingClose };
  }

  // The rejection such a drop produces: the operation is never answered, so the
  // adapter's own per-operation deadline is what ends it.
  const stalled = () =>
    new TransportOperationStalledError(
      "SFTP file delete of /remote/x.json stalled: no response from the " +
        "server; refusing to wait on the server further",
    );

  // The adapter's own forced-close bound (not exported; a liveness backstop, not
  // a tunable).
  const FORCED_CLOSE_BOUND_MS = 1_000;

  function loggedAdapter() {
    const adapter = new SSH2SFTPClientAdapter();
    const log = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      error: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = log;
    return { adapter, log };
  }

  const install = (adapter: SSH2SFTPClientAdapter, client: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = client;
  };

  // A delete that stalls on the drop and succeeds on the re-issue, the shape the
  // recovered operation takes.
  const stallingThenSucceedingDelete = (client: object) => {
    const del = vi
      .fn()
      .mockRejectedValueOnce(stalled())
      .mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = del;
    return del;
  };

  test.each([
    { half: "writable" as const, flag: "writableEnded" },
    { half: "readable" as const, flag: "readableEnded" },
  ])(
    "recovers the drop and completes the operation when the transport's $flag half has ended",
    async ({ half }) => {
      const { client, connect, destroy, dropWithholdingClose } =
        withholdingPartner();
      const del = stallingThenSucceedingDelete(client);
      const { adapter } = loggedAdapter();
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      dropWithholdingClose(half);

      await expect(adapter.delete("/remote/x.json")).resolves.toBeUndefined();

      // The session could only be cleared from this side: the forced close ran
      // once, and the re-dial and re-issue followed it.
      expect(destroy).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledTimes(2);
      expect(del).toHaveBeenCalledTimes(2);
    },
  );

  test("counts and warns the recovery as the mid-exchange drop it is, never as an idle release", async () => {
    const { client, dropWithholdingClose } = withholdingPartner();
    stallingThenSucceedingDelete(client);
    const { adapter, log } = loggedAdapter();
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
    dropWithholdingClose();
    await adapter.delete("/remote/x.json");

    // A survived server-side drop, counted in both metrics exactly as a drop the
    // partner closed cleanly is.
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    // The connection-per-poll idle release's own accounting is untouched: this
    // boundary was a partner-side drop, not a release.
    expect(adapter.forcedReleaseCount).toBe(0);
    expect(adapter.declinedReleaseCount).toBe(0);

    // The existing mid-exchange drop warning, default-mode arm: it names the
    // partner's session cap and points at connection-per-poll, which is the right
    // advice for a server that behaves this way.
    expect(log.warn).toHaveBeenCalledOnce();
    const message = log.warn.mock.calls[0][0] as string;
    expect(message).toContain("dropped mid-exchange and was transparently");
    expect(message).toContain("session-duration or idle limit");
    expect(message).toContain("--connection-per-poll");
    expect(message).toContain("max_reconnect_attempts=3");
    // Not the idle release's line, which reports a boundary this mode never has.
    expect(message).not.toContain("idle release");
  });

  test("charges the drop to max_reconnect_attempts, and an exhausted budget is terminal", async () => {
    const { client, connect, state, socket, dropWithholdingClose } =
      withholdingPartner();
    // Every attempt stalls the way the drop does; only the re-dial restores the
    // session, so each drop costs exactly one re-dial.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = vi.fn().mockImplementation(async () => {
      if (socket.writableEnded) throw stalled();
    });
    const { adapter } = loggedAdapter();
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
    dropWithholdingClose();
    await expect(adapter.delete("/remote/x.json")).resolves.toBeUndefined();
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(connect).toHaveBeenCalledTimes(2);

    // The budget is spent, so the next such drop fails terminally with the
    // existing actionable message and no further re-dial.
    dropWithholdingClose();
    const err = await adapter.delete("/remote/x.json").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain("max_reconnect_attempts=1");
    expect((err as Error).message).toContain("--connection-per-poll");
    expect(connect).toHaveBeenCalledTimes(2);
    // The refused drop was still a session lost, and the budget bounds those.
    expect(adapter.midExchangeReconnectCount).toBe(2);
    expect(state.live).toBe(true);
  });

  test("leaves a stall on a live, still-writable transport terminal", async () => {
    // The stall exclusion keeps its whole force wherever the transport has not
    // ended: re-dialing on a timeout would hand a withholding server a free
    // liveness reset, and nothing here says the session was lost.
    const { client, connect, destroy } = withholdingPartner();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = vi.fn().mockRejectedValue(stalled());
    const { adapter } = loggedAdapter();
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    await expect(adapter.delete("/remote/x.json")).rejects.toBeInstanceOf(
      TransportOperationStalledError,
    );
    expect(connect).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(adapter.midExchangeReconnectCount).toBe(0);
  });

  test("recovers a partner that DOES close with no forced close and no extra dial", async () => {
    // The library cleared the session itself, so there is nothing to force: the
    // recovery is the one it has always been, with no added wait and no second
    // mechanism driven.
    const { client, connect, destroy, state } = withholdingPartner();
    const del = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("delete: No SFTP connection available"), {
          code: "ERR_NOT_CONNECTED",
        }),
      )
      .mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = del;
    const { adapter } = loggedAdapter();
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    // The partner closed the connection: ssh2-sftp-client's global 'close'
    // listener cleared the session property.
    state.live = false;

    await expect(adapter.delete("/remote/x.json")).resolves.toBeUndefined();
    expect(destroy).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("warns and leaves the operation terminal when the socket destroy seam has moved", async () => {
    // The mechanism is checked, not assumed: with the seam gone the recovery
    // cannot clear the session, so it says so -- naming the seam and the upgrade
    // checklist -- and degrades to the terminal outcome the operation already had,
    // in the same error class the poll loop stops on.
    const { client, connect, dropWithholdingClose } = withholdingPartner({
      withDestroy: false,
    });
    const del = stallingThenSucceedingDelete(client);
    const { adapter, log } = loggedAdapter();
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    dropWithholdingClose();

    await expect(adapter.delete("/remote/x.json")).rejects.toBeInstanceOf(
      TransportOperationStalledError,
    );
    expect(connect).toHaveBeenCalledTimes(1);
    // The operation was not re-issued onto the session that can carry nothing.
    expect(del).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledOnce();
    const message = log.warn.mock.calls[0][0] as string;
    expect(message).toContain("client._sock.destroy()");
    expect(message).toContain("Upgrading the SFTP Stack");
    expect(message).toContain("docs/spec/DEPENDENCY_PINS.md");
    // Nothing was recovered, and the session was lost all the same: the counters
    // report sessions lost rather than recoveries completed.
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("warns and leaves the operation terminal when the forced close's destroy raises", async () => {
    // net.Socket's destroy() is driven synchronously, so it can raise INTO the
    // recovery rather than rejecting a wait it can absorb. The recovery catches
    // that where the connection-per-poll release deliberately does not: the
    // operation already carries the loss the poll loop stops on, and an error of
    // the mechanism's own would replace it with one the loop reads differently.
    const { client, connect, destroy, dropWithholdingClose } =
      withholdingPartner();
    destroy.mockImplementation(() => {
      throw new Error("socket already destroyed");
    });
    const del = stallingThenSucceedingDelete(client);
    const { adapter, log } = loggedAdapter();
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    dropWithholdingClose();

    await expect(adapter.delete("/remote/x.json")).rejects.toBeInstanceOf(
      TransportOperationStalledError,
    );
    expect(destroy).toHaveBeenCalledOnce();
    // The session never cleared, so there is nothing to re-dial or re-issue onto.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledOnce();
    const message = log.warn.mock.calls[0][0] as string;
    expect(message).toContain("socket already destroyed");
    // A destroy that raises is the shape a change in ssh2's teardown semantics
    // reaches the operator as, so this warning routes them to the same
    // re-verification checklist its two sibling failures do.
    expect(message).toContain("Upgrading the SFTP Stack");
    expect(message).toContain("docs/spec/DEPENDENCY_PINS.md");
    // Counted as the lost session it was, whether or not the re-dial for it ran.
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("warns and leaves the operation terminal when the forced close does not clear the session", async () => {
    // The one premise no dial can check -- that destroying the transport takes the
    // session with it -- is read back where it is driven, on the mid-exchange
    // path's own terms: a warning and the operation's own loss, not a raise of its
    // own that would replace it.
    vi.useFakeTimers();
    try {
      const { client, connect, destroy, dropWithholdingClose } =
        withholdingPartner({ clearsOnDestroy: false });
      const del = stallingThenSucceedingDelete(client);
      const { adapter, log } = loggedAdapter();
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      dropWithholdingClose();

      const failing = adapter.delete("/remote/x.json").catch((e: unknown) => e);
      // The forced close waits out its own bound for a 'close' that never lands.
      await vi.advanceTimersByTimeAsync(FORCED_CLOSE_BOUND_MS + 2);

      expect(await failing).toBeInstanceOf(TransportOperationStalledError);
      expect(destroy).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledOnce();
      expect(log.warn).toHaveBeenCalledOnce();
      const message = log.warn.mock.calls[0][0] as string;
      expect(message).toContain("did not clear");
      expect(message).toContain("Upgrading the SFTP Stack");
      // Counted as the lost session it was, whether or not the re-dial for it ran.
      expect(adapter.midExchangeReconnectCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- ephemeral session mode (connection-per-poll) ----------------------------
//
// In this mode the adapter releases its SFTP session at each poll-loop idle
// boundary (releaseForIdle) and re-dials at the start of the next cycle
// (ensureConnected), so no session is held across an idle gap a server's
// max-session/idle cap would drop. The release is NON-TERMINAL: it drives the
// underlying ssh2 Client's own end() (not ssh2-sftp-client's, which would latch
// endCalled and disable drop detection) so `closing` stays unlatched and the
// within-cycle recovery floor survives. Off by default, so all of this is inert
// unless the adapter is constructed with ephemeralSessions: true.

describe("ephemeral session mode (connection-per-poll)", () => {
  function wrapperMethods(overrides: Record<string, unknown> = {}) {
    return {
      open: vi.fn(),
      close: vi.fn(),
      opendir: vi.fn(),
      readdir: vi.fn(),
      on: vi.fn(),
      ...overrides,
    };
  }
  const stub = (adapter: SSH2SFTPClientAdapter) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      error: vi.fn(),
    };
  };
  const install = (adapter: SSH2SFTPClientAdapter, client: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = client;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapterLog = (adapter: SSH2SFTPClientAdapter) => (adapter as any).log;
  // Whether the adapter's recorded session boundary stands as its own deliberate
  // idle release -- the one reading that exempts a loss from the reconnect counters
  // and the operator warning, as opposed to merely saying a release took the
  // session. Private state with no public surface, read directly by the tests below
  // whose case -- a release that released nothing, one during teardown, or one that
  // closed over a transport a partner's drop had already ended -- leaves no
  // behavior, or none of its own, to read it through; each of those also asserts the
  // behavior wherever one exists.
  const releaseBoundaryStands = (adapter: SSH2SFTPClientAdapter) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((adapter as any).sessionBoundary as string) === "deliberatelyReleased";
  // The wider companion: whether the recorded boundary says a release took the
  // session away at all, which both release readings do -- the reading the
  // pre-establish gate and the deferred cleanup delete act on. A case whose point
  // is that the release classified NOTHING asserts this one, so a reading that
  // answered the session question would fail it rather than pass the narrower
  // assertion above.
  const boundarySaysReleaseTookTheSession = (adapter: SSH2SFTPClientAdapter) =>
    ["deliberatelyReleased", "releasedOverEndedTransport"].includes(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).sessionBoundary as string,
    );

  // The error ssh2-sftp-client's haveConnection() raises once its `sftp` property
  // has been cleared -- what every high-level op below rejects with on a released
  // session, so an op that reached the server without re-establishing first shows
  // up as a counted, warned re-dial rather than passing silently.
  const notConnected = (name: string) =>
    Object.assign(new Error(`${name}: No SFTP connection available`), {
      code: "ERR_NOT_CONNECTED",
    });

  // A wrapper stand-in that is a real EventEmitter, so connect()'s guarded
  // fatal-'error' listener actually registers and a test can emit the malformed
  // packet that kills the session. wrapperMethods()'s `on` is a plain mock, which
  // registers nothing.
  const fatalErrorWrapper = () =>
    Object.assign(new EventEmitter(), {
      open: vi.fn(),
      close: vi.fn(),
      opendir: vi.fn(),
      readdir: vi.fn(),
    }) as unknown as EventEmitter & ReturnType<typeof wrapperMethods>;

  // A droppable client whose underlying ssh2 Client is a real EventEmitter: its
  // end() clears the session (state.live=false) and emits 'close', modeling the
  // ssh2-sftp-client global 'close' listener that clears this.sftp when the
  // connection closes. connect() restores the session. This lets releaseForIdle's
  // "drive the ssh2 Client's end() and await its 'close'" path run against a
  // faithful stand-in without a live server. It carries the whole high-level op
  // surface (the raw-wrapper ops come from the caller's `wrapper`), so an op can
  // be driven end to end across a boundary.
  function ephemeralClient(wrapper: ReturnType<typeof wrapperMethods>) {
    const state = { live: true };
    // The deletes the fixture actually performed, and the one lever a test needs
    // over them: a partner that accepts the request and withholds its callback,
    // which only a bound can end.
    const deleted: string[] = [];
    const deleteControls = { withholdCallback: false };
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    // A live net.Socket reports Node's half-close flags and its post-destroy flag,
    // and carries destroy(); the release's seams are verified against the first two
    // at connect, and both forced closes read `destroyed` back where they drive it.
    const socket = {
      setKeepAlive: vi.fn(),
      writableEnded: false,
      destroyed: false,
      destroy: vi.fn(() => {
        socket.destroyed = true;
        state.live = false;
        rawClient.emit("close");
      }),
    };
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: socket,
      end: vi.fn(() => {
        state.live = false;
        rawClient.emit("close");
      }),
    });
    const connect = vi.fn().mockImplementation(async () => {
      state.live = true;
      // A dial gets a FRESH socket: whatever a previous cycle's teardown did to the
      // last one does not carry into it, so a release reading the socket sees this
      // cycle's state rather than an earlier cycle's. Left alone when a test has
      // taken the socket, or the flag, away -- each of those is its own case.
      const dialed = rawClient._sock as
        { writableEnded?: boolean; destroyed?: boolean } | undefined;
      if (dialed?.writableEnded !== undefined) dialed.writableEnded = false;
      if (dialed?.destroyed !== undefined) dialed.destroyed = false;
    });
    const onLiveSession =
      <T>(name: string, value: T) =>
      async () => {
        if (!state.live) throw notConnected(name);
        return value;
      };
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      // ssh2-sftp-client holds its session on a plain writable property (its own
      // listeners null it), so the stand-in is writable too: the release's
      // mechanism-unavailable fallback clears it directly.
      set sftp(value: ReturnType<typeof wrapperMethods> | null) {
        state.live = value !== null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
      get: vi.fn(onLiveSession("get", Buffer.from("payload"))),
      put: vi.fn(onLiveSession("put", "ok")),
      delete: vi.fn(async (path: string) => {
        if (deleteControls.withholdCallback) await new Promise<void>(() => {});
        if (!state.live) throw notConnected("delete");
        deleted.push(path);
      }),
      rename: vi.fn(onLiveSession("rename", undefined)),
      exists: vi.fn(onLiveSession("exists", true)),
    };
    return {
      client,
      connect,
      state,
      rawClient,
      socket,
      deleted,
      deleteControls,
    };
  }

  // A client whose ssh2 Client models the real close SEQUENCE rather than
  // collapsing it: end() begins the teardown and the session keeps reading live
  // until the 'close' that lands a macrotask later (ssh2-sftp-client clears
  // `this.sftp` from that event, not from end()). An op issued between the two
  // rejects the way a channel that is already going away does -- with the session
  // property still set, the state that decides whether a rejection is a
  // recoverable clean loss.
  function slowClosingClient(wrapper: ReturnType<typeof wrapperMethods>) {
    const state = { live: true, ending: false };
    const deleted: string[] = [];
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: { setKeepAlive: vi.fn(), writableEnded: false, destroy: vi.fn() },
      end: vi.fn(() => {
        state.ending = true;
        setTimeout(() => {
          state.ending = false;
          state.live = false;
          rawClient.emit("close");
        }, 0);
      }),
    });
    const connect = vi.fn().mockImplementation(async () => {
      state.ending = false;
      state.live = true;
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
      exists: vi.fn(async () => {
        if (state.ending)
          throw new Error("Channel closed while the connection was ending");
        if (!state.live) throw notConnected("exists");
        return true;
      }),
      delete: vi.fn(async (path: string) => {
        if (state.ending)
          throw new Error("Channel closed while the connection was ending");
        if (!state.live) throw notConnected("delete");
        deleted.push(path);
      }),
    };
    return { client, connect, state, rawClient, deleted };
  }

  // A client that models what an ssh2 'end' does to an operation ALREADY ON THE
  // WIRE: ssh2-sftp-client's endListener both clears the session and rejects the
  // in-flight operation, and ssh2 emits 'end' BEFORE the 'close' that lands a
  // macrotask later. A connect() started inside that window is what the real
  // library fails: it resets the event flags and installs its own temp listeners,
  // so the release's own stale 'close' lands on the fresh handshake and rejects it
  // as an "Unexpected close event".
  function midWireTearClient(wrapper: ReturnType<typeof wrapperMethods>) {
    const state = { live: true, ending: false };
    // Every operation on the wire, not one: a drop tears the whole set, which is
    // what a fan-out case needs and what the real stack does (one cut, every
    // outstanding request failed). A single-operation case is the one-member set.
    const inFlight = new Set<(error: unknown) => void>();
    const failEveryInFlight = (error: unknown) => {
      const torn = [...inFlight];
      inFlight.clear();
      for (const fail of torn) fail(error);
    };
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    // destroy() needs nothing from the peer, and the ssh2 Client's 'close' that
    // follows is what fires ssh2-sftp-client's global listener to clear the
    // session. A stand-in that drove neither leaves a retirement of a session
    // still held over an ended transport failing for want of a mock.
    const socket = {
      setKeepAlive: vi.fn(),
      writableEnded: false,
      destroy: vi.fn(() => {
        state.live = false;
        rawClient.emit("close");
      }),
    };
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: socket,
      end: vi.fn(() => {
        state.ending = true;
        state.live = false;
        failEveryInFlight(notConnected("exists"));
        setTimeout(() => {
          state.ending = false;
          rawClient.emit("close");
        }, 0);
      }),
    });
    const connect = vi.fn().mockImplementation(async () => {
      if (state.ending)
        throw new Error("getConnection: Unexpected close event");
      // ssh2 mints a fresh socket per dial, so neither half is ended on it.
      socket.writableEnded = false;
      state.live = true;
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
      // An operation on a live session is outstanding for one macrotask -- the
      // server round trip the release can fall in the middle of -- and completes
      // unless it is torn first.
      exists: vi.fn(
        () =>
          new Promise<boolean>((resolve, reject) => {
            if (!state.live) {
              reject(notConnected("exists"));
              return;
            }
            const fail = (error: unknown) => {
              clearTimeout(answer);
              reject(error);
            };
            const answer = setTimeout(() => {
              inFlight.delete(fail);
              resolve(true);
            }, 0);
            inFlight.add(fail);
          }),
      ),
    };
    // The PARTNER dropping the session with operations on the wire while
    // withholding its CONNECTION close: only the SFTP channel goes, so the
    // operations are rejected over a transport ssh2 has ended while neither
    // ssh2-sftp-client listener that clears `sftp` has run.
    // The session property therefore still reads live, which is what leaves a
    // release something to close (see shouldRecoverFromSessionLoss for why the
    // ended transport is what makes this rejection a loss rather than an
    // application failure).
    const tearChannelWithholdingClose = () => {
      socket.writableEnded = true;
      failEveryInFlight(new Error("exists: channel is closed"));
    };
    return {
      client,
      connect,
      state,
      rawClient,
      tearChannelWithholdingClose,
    };
  }

  test("connect-then-release-then-reconnect brackets a single cycle's ops", async () => {
    const wrapper = wrapperMethods();
    const { client, connect, state, rawClient } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    expect(connect).toHaveBeenCalledTimes(1);

    // Idle boundary: the session is released for the inter-poll gap.
    await adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    expect(state.live).toBe(false);

    // Start of the next cycle: an explicit re-dial re-establishes the session
    // (no lazy re-dial on a first-op failure).
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(state.live).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("the boundary release does not latch closing; recovery still works after it", async () => {
    // The release must be NON-TERMINAL: it must not run the adapter's end()
    // (which latches `closing` and disables recovery). Prove it by releasing,
    // re-dialing, then dropping mid-cycle and confirming the within-cycle
    // recovery floor still re-dials and completes the op.
    const wrapper = wrapperMethods({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (() => {
        let served = false;
        return (
          _h: Buffer,
          cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
        ) => {
          if (served) return cb(Object.assign(new Error("EOF"), { code: 1 }));
          served = true;
          cb(null, [{ filename: "a.json", attrs: { mtime: 1, size: 1 } }]);
        };
      })(),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, connect, state } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).closing).toBe(false);
    await adapter.ensureConnected();
    expect(connect).toHaveBeenCalledTimes(2);

    // Mid-cycle clean drop: the within-cycle recovery floor must still re-dial.
    state.live = false;
    const result = await adapter.list("/remote/dir");
    expect(result.map((e) => e.name)).toEqual(["a.json"]);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  test("recovery re-dials are NOT bounded by the mid-exchange reconnection cap", async () => {
    // The cumulative cap applies only to the default held-session mode. In
    // connection-per-poll it is gated off in EVERY phase, so recovery re-dials are
    // unbounded by the count (bounded instead by the peer-inactivity ceiling): more
    // drops than max_reconnect_attempts still recover, where the default mode would
    // have failed terminally. This is what carries the rendezvous phase -- which
    // holds one session across its waits, unlike the poll loop -- through a server
    // cap that cuts it repeatedly.
    const wrapper = wrapperMethods({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, connect, state } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    // Budget of 1: the default mode would fail on the SECOND drop.
    await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
    for (let i = 0; i < 3; i += 1) {
      state.live = false;
      await adapter.list("/remote/dir");
    }
    // All three drops recovered past the default cap, none refused.
    expect(connect).toHaveBeenCalledTimes(4); // initial + 3 recoveries
    // They still count as mid-exchange recoveries -- only the CAP is off in this mode.
    expect(adapter.midExchangeReconnectCount).toBe(3);
  });

  test("the recovery warning describes the per-poll case, quoting no budget", async () => {
    // The warn line must match the mode the operator is running. In per-poll the
    // count is not charged against max_reconnect_attempts and the remedy the
    // default-mode line recommends is already in force, so quoting a remaining
    // budget would state a bound that does not apply and naming the flag would
    // advise a mode already on. The mode's own idle release never reaches this
    // warning, and the adapter cannot tell the two causes that do reach it apart --
    // a fault within a poll cycle, or a rendezvous wait cut by the server's cap --
    // so the line names both with the remedy for each, and says plainly that the
    // rendezvous case is the mode working rather than something to chase.
    const wrapper = wrapperMethods({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, state } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;
    await adapter.list("/remote/dir");

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    // A real drop, stated plainly, with both of the causes it can have.
    expect(message).toContain("dropped mid-exchange");
    expect(message).toContain("the exchange continues");
    expect(message).toContain("within a poll cycle");
    expect(message).toContain("rendezvous");
    // The rendezvous cause is not sent after the link: it is the mode working.
    expect(message).toContain("needs nothing from you");
    // No budget quoted, and no advice to enable the mode already running.
    expect(message).not.toContain("max_reconnect_attempts=2");
    expect(message).not.toContain("further mid-exchange re-dial");
    expect(message).not.toContain("--connection-per-poll");
    // The bound that DOES apply is named instead.
    expect(message).toContain("peer_timeout_ms");
  });

  test("re-dial reuses the retained connect options (no re-prompt / same key + credentials)", async () => {
    const wrapper = wrapperMethods();
    const { client, connect, state } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    const hostVerifier = () => true;
    await adapter.connect({
      host: "h",
      username: "u",
      password: "pw",
      hostVerifier,
      maxReconnectAttempts: 0,
    });
    await adapter.releaseForIdle();
    await adapter.ensureConnected();

    // The re-dial passed ssh2 the identical connect options as the first dial
    // (host, credentials, and the enforcing host-key verifier), minus the
    // psilink-specific maxReconnectAttempts connect() strips -- no re-prompt, no
    // freshly-built options.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[1][0]).toEqual(connect.mock.calls[0][0]);
    expect(connect.mock.calls[1][0]).toMatchObject({
      host: "h",
      username: "u",
      password: "pw",
      hostVerifier,
    });
    expect(state.live).toBe(true);
  });

  test("a transient dial failure returns false (skip the cycle), not a throw", async () => {
    const wrapper = wrapperMethods();
    const state = { live: true };
    let calls = 0;
    const connect = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        state.live = true;
        return;
      }
      throw new Error("connect ECONNREFUSED");
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // Model a released (dropped) session so ensureConnected attempts a re-dial.
    state.live = false;

    await expect(adapter.ensureConnected()).resolves.toBe(false);
    expect(connect).toHaveBeenCalledTimes(2);
    // The transient failure is reported for observability, not thrown.
    expect(adapterLog(adapter).warn).toHaveBeenCalledWith(
      expect.stringContaining("retrying"),
    );
  });

  test("a host-key mismatch on the re-dial is fatal (rejects, not skipped)", async () => {
    const wrapper = wrapperMethods();
    const state = { live: true };
    let calls = 0;
    const connect = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        state.live = true;
        return;
      }
      throw new Error("Host denied (verification failed)");
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    // A non-zero reconnect budget makes the single-attempt assertion meaningful:
    // a working predicate refuses to spend it re-running the key exchange against
    // the same untrusted host.
    await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
    state.live = false;

    await expect(adapter.ensureConnected()).rejects.toThrow("Host denied");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("releaseForIdle and ensureConnected are no-ops when the mode is off", async () => {
    const wrapper = wrapperMethods();
    const { client, connect, state, rawClient } = ephemeralClient(wrapper);
    // Default construction: ephemeral mode off.
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    expect(connect).toHaveBeenCalledTimes(1);

    // Neither boundary method touches the session in the default whole-exchange
    // model.
    await adapter.releaseForIdle();
    expect(rawClient.end).not.toHaveBeenCalled();
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);

    // And neither dials on a session that is GONE either: in the default mode
    // session recovery owns re-establishment, so a cycle-boundary reconnect that
    // dialed here would open a session the mode never asked for.
    state.live = false;
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);

    // Stop the (default-mode) heartbeat so no unref'd timer lingers past the test.
    await adapter.end();
  });

  test("the heartbeat is not armed in ephemeral mode (no keepalive fires)", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = wrapperMethods();
      const { client } = ephemeralClient(wrapper);
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stubAdapterLog(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      // No session is held long enough to idle out, so the heartbeat is never
      // armed: however long an idle stretch runs, no realPath keepalive fires.
      await vi.advanceTimersByTimeAsync(SFTP_HEARTBEAT_INTERVAL_MS * 3);
      expect(client.realPath).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an intentional cycle release + re-dial is not counted or warned as a drop", async () => {
    // The mode's OWN idle-boundary release (releaseForIdle drives the ssh2 Client's
    // end(), clearing this.sftp) and the next cycle's re-dial are its designed
    // behavior, NOT a server-forced mid-exchange drop, so neither may increment the
    // mid-exchange recovery counter or fire the recovery WARN (reserved for a
    // genuine unexpected drop the operator should see). Proven over both orderings
    // an exchange produces: the poll cycle's, where ensureConnected re-establishes
    // at cycle start ahead of the cycle's ops, and the send's, where the protocol
    // continuation resumes INTO the idle gap and the op itself re-establishes.
    // Each cycle runs a real op, so a boundary mistaken for a drop would show up.
    const wrapper = wrapperMethods({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, connect } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await adapter.releaseForIdle();
      await expect(adapter.ensureConnected()).resolves.toBe(true);
      // A normal op runs against the freshly re-dialed session; ensureConnected
      // repopulated this.sftp, so withSessionRecovery must not treat it as a loss.
      await expect(adapter.list("/remote/dir")).resolves.toEqual([]);
    }

    // The send ordering: the continuation resumes in the idle gap, with no cycle
    // start between the release and the ops, so the send's own list/put/rename are
    // what re-establish the session.
    for (let send = 0; send < 3; send += 1) {
      await adapter.releaseForIdle();
      await expect(adapter.list("/remote/dir")).resolves.toEqual([]);
      await adapter.put(Buffer.from("frame"), "/remote/temp-send.tmp", {
        flags: "w",
      });
      await adapter.rename("/remote/temp-send.tmp", "/remote/id-0-12.json");
    }

    // The designed release + re-dial is invisible to the recovery accounting under
    // both orderings: no server-forced drop happened, so the mid-exchange sub-count
    // stays zero (and no internal connect-retry bumped the merged total either).
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(adapter.reconnectCount).toBe(0);
    // ... and the recovery WARN never fired: no message names a transparently
    // re-dialed mid-exchange drop. (connect() called once per cycle to re-dial,
    // never via the recovery path.)
    const recoveryWarns = warn.mock.calls.filter((c) =>
      (c[0] as string).includes("transparently"),
    );
    expect(recoveryWarns).toEqual([]);
    // Initial dial plus one re-dial per boundary, whichever side re-established it.
    expect(connect).toHaveBeenCalledTimes(7);
  });

  test("an ordinary release is totalled, warns nothing, and needs a session to count", async () => {
    // The outcome the mode exists for: this side drove the close, the partner's
    // server answered it within the bound, and the next cycle dialed a fresh
    // session. Nothing anomalous happened, so no occurrence draws a line and the
    // run total is the only thing telling an unattended operator the mode
    // delivered per-cycle sessions at all -- and the only denominator the forced
    // total has. A release that finds no session to close is not one of them: it
    // ended no boundary, so counting it would inflate that denominator with
    // boundaries the partner never answered.
    const { client } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
      await expect(adapter.ensureConnected()).resolves.toBe(true);
    }
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();

    expect(adapter.releasedBoundaryCount).toBe(4);
    // Each of the mode's other per-cycle outcomes is its own count, and none of
    // them happened here.
    expect(adapter.forcedReleaseCount).toBe(0);
    expect(adapter.declinedReleaseCount).toBe(0);
    expect(adapter.declinedCycleRedialCount).toBe(0);
    expect(adapter.heldBoundaryCount).toBe(0);
    // Nothing was lost, so no boundary reaches the reconnect counters, and the
    // operator hears nothing at all about an ordinary cycle.
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(adapterLog(adapter).warn).not.toHaveBeenCalled();
  });

  test("an op after the idle release issues no attempt against the released session", async () => {
    // What the standing release boundary buys, stated as the only thing that
    // distinguishes it from letting the recovery path absorb the gap: the op is
    // spared the one attempt that is guaranteed to fail. The counters, the dial
    // count and the warnings are identical either way -- the re-dial that follows
    // a deliberate release is exempt from all three -- so the attempt itself is
    // what has to be asserted.
    const { client, state } = ephemeralClient(wrapperMethods());
    const attempts: boolean[] = [];
    client.exists = vi.fn(async () => {
      attempts.push(state.live);
      if (!state.live) throw notConnected("exists");
      return true;
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    expect(state.live).toBe(false);

    await expect(adapter.exists("/remote/file.json")).resolves.toBe(true);

    // One attempt, and the session was live when it was made: without the gate
    // the first attempt lands on the released session, rejects, and only the
    // re-issue behind the recovery re-dial succeeds.
    expect(attempts).toEqual([true]);
  });

  // The never-reject cleanup delete reaches no gate at all: its contract keeps it
  // outside the recovery chokepoint, so it is the one operation that can be issued
  // into an idle gap and reach no session. It resolves either way, so its caller
  // in core cannot tell that from a delete that landed -- only the adapter can,
  // and what it does with the reading is record the cleanup and re-issue it at the
  // next point a session exists.

  // The ceiling on the whole re-issue drain, duplicated from the adapter for the
  // same reason the close and acquire bounds above are (it is a liveness backstop,
  // not a seam), so the cases below can sit either side of it.
  const DRAIN_BOUND_MS = 5_000;

  // Wait for a condition the adapter reaches on its own schedule (a request
  // arriving at the fixture), failing rather than hanging if it never does.
  const waitUntil = async (predicate: () => boolean): Promise<void> => {
    for (let turn = 0; turn < 2_000 && !predicate(); turn += 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(predicate()).toBe(true);
  };

  // Let every queued continuation run, so anything an in-flight call was going to
  // issue has reached the fixture by the time the assertion reads it.
  const settleQueue = async (turns = 10): Promise<void> => {
    for (let turn = 0; turn < turns; turn += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
  };

  test("a cleanup delete issued while the deliberate-release boundary stands is re-issued at the next re-establishment", async () => {
    const { client, state, deleted } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    expect(state.live).toBe(false);
    expect(releaseBoundaryStands(adapter)).toBe(true);

    // The send()-catch sweep resuming into the idle gap: it must not reject, and
    // on the released session it removes nothing.
    const abandoned = protocolTempPath();
    await expect(adapter.safeDelete(abandoned)).resolves.toBeUndefined();
    expect(deleted).toEqual([]);
    expect(deferredCleanupPaths(adapter)).toEqual([abandoned]);

    // The next cycle's re-establishment is where the file actually goes away.
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(deleted).toEqual([abandoned]);
    expect(deferredCleanupPaths(adapter)).toEqual([]);
  });

  test("a cleanup delete issued while the release is in flight is re-issued at the next re-establishment", async () => {
    // The other reading, and the one no completed-boundary check covers: the
    // release has driven the ssh2 Client's end() and is awaiting its 'close', so
    // the session still reads live over a transport that can no longer carry the
    // delete.
    const { client, rawClient, deleted } = slowClosingClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    const release = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    expect(client.sftp).not.toBeNull();

    const inFlight = protocolTempPath();
    await expect(adapter.safeDelete(inFlight)).resolves.toBeUndefined();
    expect(deleted).toEqual([]);
    await release;

    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(deleted).toEqual([inFlight]);
    expect(deferredCleanupPaths(adapter)).toEqual([]);
  });

  test("a cleanup delete that can obtain no session at all resolves and keeps its record", async () => {
    // The dial keeps failing, so the drain never runs. The contract still holds --
    // the caller in a catch block sees no rejection -- and the record is kept
    // rather than dropped, so the first re-establishment that does land sweeps it.
    const { client, connect, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await adapter.releaseForIdle();
    expect(state.live).toBe(false);
    connect.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const orphan = protocolTempPath();
    await expect(adapter.safeDelete(orphan)).resolves.toBeUndefined();
    await expect(adapter.ensureConnected()).resolves.toBe(false);

    expect(deferredCleanupPaths(adapter)).toEqual([orphan]);
  });

  test("a drain a partner will not answer ends at the drain bound, well inside the per-operation deadline", async () => {
    // Core forwards ensureConnected unwrapped and close() awaits it with no
    // budget above, so the drain's wait lands on teardown and on the recovery
    // gate's first attempt after an idle gap. A partner that ACCEPTS delete
    // requests and WITHHOLDS their callbacks must therefore not cost either of
    // them a whole per-operation deadline: the re-issue carries the
    // teardown-scale bound in its place, and its expiry keeps what it could not
    // perform.
    const { client, deleteControls } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    const withheld = protocolTempPath();
    await adapter.safeDelete(withheld);
    expect(deferredCleanupPaths(adapter)).toEqual([withheld]);

    vi.useFakeTimers();
    try {
      deleteControls.withholdCallback = true;
      let settled = false;
      const reconnected = adapter.ensureConnected().then((live) => {
        settled = true;
        return live;
      });
      const assertion = expect(reconnected).resolves.toBe(true);
      // One tick short of the bound the drain is still waiting: the bound is
      // what ends it, not some earlier accident of the plumbing.
      await vi.advanceTimersByTimeAsync(DRAIN_BOUND_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await assertion;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    // The delete that could not be performed is kept, not dropped: the next
    // re-establishment tries again.
    expect(deferredCleanupPaths(adapter)).toEqual([withheld]);
  });

  test("an idle boundary reached with a drain re-issue in flight still closes the session", async () => {
    // The re-issue is the one round trip still owing a settlement that an idle
    // release MAY tear, and this is what that buys. Counted at the bracket
    // instead, it would hold the boundary for its whole bound -- and a boundary
    // that closes nothing leaves the session live, so the next re-establishment
    // finds one, re-runs the drain and regenerates the operation, which against
    // a server that accepts DELETE and withholds its callback reverts the mode
    // to a held session for the run. The tear costs the cleanup nothing: the
    // torn delete rejects, which records the path again for the next
    // re-establishment.
    const { client, state } = ephemeralClient(wrapperMethods());
    const calls: string[] = [];
    let releaseDelete!: () => void;
    const parked = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    client.delete = vi.fn(async (path: string) => {
      calls.push(path);
      // The sweep that fell into the idle gap; the re-issue behind it is the one
      // held on the wire.
      if (calls.length === 1) throw notConnected("delete");
      await parked;
      if (!state.live) throw notConnected("delete");
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    const withheld = protocolTempPath();
    await expect(adapter.safeDelete(withheld)).resolves.toBeUndefined();
    expect(deferredCleanupPaths(adapter)).toEqual([withheld]);

    const reestablishing = adapter.ensureConnected();
    await waitUntil(() => calls.length === 2);
    expect(state.live).toBe(true);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((adapter as any).ledger as SftpAdapterLedger).outstandingOperations,
    ).toBe(0);

    await adapter.releaseForIdle();
    expect(state.live).toBe(false);
    expect(adapter.heldBoundaryCount).toBe(0);

    releaseDelete();
    expect(await reestablishing).toBe(true);
    // The torn re-issue spent one of its budget and left the rest, so the next
    // re-establishment sweeps the path again.
    expect(deferredCleanupPaths(adapter)).toEqual([withheld]);
    expect(deferredCleanupBudgets(adapter)).toEqual([
      MAX_DEFERRED_CLEANUP_REISSUES - 1,
    ]);
  });

  test("the drain bound covers the whole record, not one deadline per re-issued delete", async () => {
    // The re-issues go out concurrently, which is what makes ONE bound the
    // honest description of the drain's cost. A record filled to its cap must
    // therefore end at the same bound a single entry does.
    const { client, deleteControls } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    for (let i = 0; i < MAX_DEFERRED_CLEANUP_DELETES; i += 1)
      await adapter.safeDelete(protocolTempPath());
    expect(deferredCleanupPaths(adapter)).toHaveLength(
      MAX_DEFERRED_CLEANUP_DELETES,
    );

    vi.useFakeTimers();
    try {
      deleteControls.withholdCallback = true;
      const assertion = expect(adapter.ensureConnected()).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(DRAIN_BOUND_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
    expect(deferredCleanupPaths(adapter)).toHaveLength(
      MAX_DEFERRED_CLEANUP_DELETES,
    );
  });

  test("a drain rejection cannot fail the exchange, while the dial's host-key rejection still does", async () => {
    // Core's poll loop treats an ensureConnected rejection as a TERMINAL dial
    // error: it stops the poller and emits. The two things that can reject here
    // must therefore part company -- a best-effort cleanup sweep may not end an
    // exchange, and a host-key rejection must, since papering that over would
    // turn a possible MITM into a silently-continued run.
    const { client, connect, deleted } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    const recorded = protocolTempPath();
    await adapter.safeDelete(recorded);
    expect(deferredCleanupPaths(adapter)).toEqual([recorded]);

    const cleanupRecord = (
      adapter as unknown as {
        deferredCleanupDeletes: { drain: () => Promise<void> };
      }
    ).deferredCleanupDeletes;
    const drain = cleanupRecord.drain;
    cleanupRecord.drain = () => Promise.reject(new Error("the sweep blew up"));
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    cleanupRecord.drain = drain;

    // With the real drain restored and the record still standing, a fatal
    // host-key rejection reaches the caller and nothing is swept onto the
    // session that failed verification.
    await adapter.releaseForIdle();
    connect.mockRejectedValue(new Error("Host denied (verification failed)"));
    await expect(adapter.ensureConnected()).rejects.toThrow(
      "Host denied (verification failed)",
    );
    expect(deleted).toEqual([]);
    expect(deferredCleanupPaths(adapter)).toEqual([recorded]);
  });

  test("after a fatal SFTP error a cleanup delete short-circuits and no recorded one is re-issued", async () => {
    // Both halves of the post-fatal posture. A request posted to a destroyed
    // wrapper never calls back, so safeDelete returns at once rather than driving
    // one -- and the drain must not reintroduce, at teardown, exactly the request
    // that short-circuit refuses.
    const wrapper = fatalErrorWrapper();
    const { client } = ephemeralClient(wrapper);
    const attempted: string[] = [];
    client.delete = vi.fn(async (path: string) => {
      attempted.push(path);
      // A cleanup that fails for its own reason, so it is recorded without a
      // release having taken the session away.
      throw new Error("permission denied");
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    // A cleanup that failed for its own reason, recorded before anything went
    // fatal.
    const recorded = protocolTempPath();
    await expect(adapter.safeDelete(recorded)).resolves.toBeUndefined();
    expect(attempted).toEqual([recorded]);
    expect(deferredCleanupPaths(adapter)).toEqual([recorded]);

    wrapper.emit("error", new Error("Malformed NAME packet"));

    await expect(
      adapter.safeDelete(protocolTempPath()),
    ).resolves.toBeUndefined();
    adapter.beginTeardown();
    await adapter.ensureConnected();

    // Nothing further reached the dead session, from either route.
    expect(attempted).toEqual([recorded]);
  });

  test("the record of unperformed cleanup deletes stays bounded, refusing rather than evicting", async () => {
    // A run whose cycles keep sweeping temps into an idle gap and whose re-dial
    // keeps failing, so nothing is ever drained. The record must not grow with
    // the run -- and what overflow does is refuse the newcomer, never drop a
    // cleanup this adapter had already promised to re-issue.
    const { client, connect, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const debug = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn: vi.fn(),
      info: vi.fn(),
      debug,
      trace: vi.fn(),
      error: vi.fn(),
    };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    expect(state.live).toBe(false);
    connect.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const first = protocolTempPath();
    await adapter.safeDelete(first);
    for (let cycle = 1; cycle < MAX_DEFERRED_CLEANUP_DELETES * 3; cycle += 1)
      await adapter.safeDelete(protocolTempPath());
    // No session comes back, so no drain runs and nothing leaves the record by
    // that route either.
    await expect(adapter.ensureConnected()).resolves.toBe(false);

    expect(deferredCleanupPaths(adapter)).toHaveLength(
      MAX_DEFERRED_CLEANUP_DELETES,
    );
    expect(deferredCleanupPaths(adapter)[0]).toBe(first);
    // The refusal is reported where an operator looking for it would find it, and
    // says which file was left behind.
    expect(
      debug.mock.calls.some(
        (call) =>
          (call[0] as string).includes(
            "cleanup deletes are already recorded",
          ) && (call[0] as string).includes("is left behind"),
      ),
    ).toBe(true);
  });

  test("a cleanup delete the server keeps refusing is re-issued a bounded number of times, then given up on", async () => {
    // The only thing that clears a record is a delete this side saw succeed, so
    // without a budget a delete that can never succeed -- a peer-owned temp under
    // a sticky-bit directory, which the entry sweep still attempts -- is re-issued
    // once per re-establishment for the life of the exchange, and with the record
    // full that is a record's worth of extra round trips per poll cycle against
    // the partner's server.
    const { client, state } = ephemeralClient(wrapperMethods());
    const attempts: string[] = [];
    client.delete = vi.fn(async (path: string) => {
      attempts.push(path);
      if (!state.live) throw notConnected("delete");
      throw new Error("permission denied");
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const debug = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn: vi.fn(),
      info: vi.fn(),
      debug,
      trace: vi.fn(),
      error: vi.fn(),
    };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    const refused = protocolTempPath();
    await expect(adapter.safeDelete(refused)).resolves.toBeUndefined();
    expect(deferredCleanupBudgets(adapter)).toEqual([
      MAX_DEFERRED_CLEANUP_REISSUES,
    ]);

    // Each re-establishment spends one of the budget and re-records the rest, so
    // the record narrows toward giving up rather than standing for the run.
    for (let spent = 1; spent <= MAX_DEFERRED_CLEANUP_REISSUES; spent += 1) {
      await expect(adapter.ensureConnected()).resolves.toBe(true);
      await adapter.releaseForIdle();
      expect(deferredCleanupBudgets(adapter)).toEqual(
        spent === MAX_DEFERRED_CLEANUP_REISSUES
          ? []
          : [MAX_DEFERRED_CLEANUP_REISSUES - spent],
      );
    }

    // One attempt for the sweep that reached no session, then the budget, and
    // then nothing however many further cycles run.
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await expect(adapter.ensureConnected()).resolves.toBe(true);
      await adapter.releaseForIdle();
    }
    expect(attempts).toHaveLength(1 + MAX_DEFERRED_CLEANUP_REISSUES);
    expect(deferredCleanupPaths(adapter)).toEqual([]);
    // Giving up says so, and says which file was left behind.
    expect(
      debug.mock.calls.some(
        (call) =>
          (call[0] as string).includes("without succeeding") &&
          (call[0] as string).includes("is left behind"),
      ),
    ).toBe(true);
  });

  test("an op re-establishing through the recovery gate drains the record before its own attempt", async () => {
    // The third route into the drain: the gate withSessionRecovery applies at
    // operation entry re-establishes through ensureConnected, so an ordinary
    // data-plane op sweeps the record with no cycle-start or teardown
    // re-establishment involved. The op behind it therefore waits the drain out
    // before its first attempt, which is bounded -- the re-issues go out
    // concurrently under one per-operation deadline, and the gate is best-effort
    // -- and it still completes in that one attempt.
    const { client, state, deleted } = ephemeralClient(wrapperMethods());
    const order: string[] = [];
    const performDelete = client.delete;
    client.delete = vi.fn(async (path: string) => {
      await performDelete(path);
      order.push("cleanup delete");
    });
    client.exists = vi.fn(async () => {
      order.push("exists attempt");
      if (!state.live) throw notConnected("exists");
      return true;
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    expect(state.live).toBe(false);
    expect(releaseBoundaryStands(adapter)).toBe(true);

    const gated = protocolTempPath();
    await expect(adapter.safeDelete(gated)).resolves.toBeUndefined();
    expect(deferredCleanupPaths(adapter)).toEqual([gated]);

    // No ensureConnected() of its own: the gate is the only route this op has to
    // a session, and so the only route the record has to the drain.
    await expect(adapter.exists("/remote/file.json")).resolves.toBe(true);

    expect(deleted).toEqual([gated]);
    expect(deferredCleanupPaths(adapter)).toEqual([]);
    expect(order).toEqual(["cleanup delete", "exists attempt"]);
    expect(adapterLog(adapter).warn).not.toHaveBeenCalled();
  });

  test("two overlapping re-establishments run one drain between them, and a record made after its snapshot waits for the next", async () => {
    // Re-establishment is not serialized: the poll cycle's re-dial, teardown's,
    // and the recovery gate's all reach ensureConnected, and a send() resuming
    // from the protocol continuation puts two of them in flight together. The
    // second must JOIN the drain already running rather than start one -- issuing
    // a second delete for a path whose first re-issue is still on the wire, and
    // taking a fresh snapshot that sweeps a record the first drain has not
    // finished paying for.
    const { client, state } = ephemeralClient(wrapperMethods());
    const attempts = new Map<string, number>();
    const concurrent = new Map<string, number>();
    const peak = new Map<string, number>();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holdFor = new Set<string>();
    const refuse = new Set<string>();
    client.delete = vi.fn(async (path: string) => {
      if (!state.live) throw notConnected("delete");
      attempts.set(path, (attempts.get(path) ?? 0) + 1);
      const inFlight = (concurrent.get(path) ?? 0) + 1;
      concurrent.set(path, inFlight);
      peak.set(path, Math.max(peak.get(path) ?? 0, inFlight));
      try {
        if (holdFor.has(path)) await held;
        if (refuse.has(path)) throw new Error("permission denied");
      } finally {
        concurrent.set(path, (concurrent.get(path) ?? 1) - 1);
      }
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    expect(state.live).toBe(false);

    const first = protocolTempPath();
    const second = protocolTempPath();
    holdFor.add(first);
    holdFor.add(second);
    await adapter.safeDelete(first);
    await adapter.safeDelete(second);
    expect(deferredCleanupPaths(adapter)).toEqual([first, second]);

    // The first re-establishment takes the snapshot and puts both re-issues on
    // the wire, where the fixture holds them.
    const reestablishing = adapter.ensureConnected();
    await waitUntil(() => attempts.size === 2);

    // A cleanup recorded while that drain is still outstanding: its own attempt
    // is refused, so it lands in the record AFTER the snapshot was taken.
    const late = protocolTempPath();
    refuse.add(late);
    await adapter.safeDelete(late);
    expect(deferredCleanupPaths(adapter)).toEqual([late]);

    // The overlapping re-establishment. It must find the drain in flight and
    // wait it out rather than sweeping `late` alongside.
    const overlapping = adapter.ensureConnected();
    await settleQueue();
    expect(attempts.get(late)).toBe(1);

    release();
    expect(await reestablishing).toBe(true);
    expect(await overlapping).toBe(true);

    // One re-issue per snapshotted path, never two on the wire at once.
    expect(attempts.get(first)).toBe(1);
    expect(attempts.get(second)).toBe(1);
    expect(peak.get(first)).toBe(1);
    expect(peak.get(second)).toBe(1);
    // And the post-snapshot record is still standing, its only attempt the one
    // safeDelete made for itself -- the drain that was running did not pay for
    // it, and neither did the re-establishment that joined that drain.
    expect(attempts.get(late)).toBe(1);
    expect(deferredCleanupPaths(adapter)).toEqual([late]);

    // The next re-establishment is what sweeps it.
    refuse.delete(late);
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(attempts.get(late)).toBe(2);
    expect(deferredCleanupPaths(adapter)).toEqual([]);
  });

  test("an op issued while the release is in flight completes instead of failing terminally", async () => {
    // The release drives the ssh2 Client's end() and then awaits its 'close'.
    // ssh2-sftp-client clears `this.sftp` from that 'close', not from end(), so
    // between the two the session still reports live while the channel is already
    // going away. An op landing in that window rejects with a live-looking
    // session, which the clean-loss classifier reads as "not a session loss" and
    // fails terminally -- so the op must wait the release out and re-establish
    // rather than race it.
    const wrapper = wrapperMethods();
    const { client, connect, rawClient } = slowClosingClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    // Issue the op INSIDE the window: end() has been called, 'close' has not
    // landed, and the session still reads live.
    const release = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    expect(client.sftp).not.toBeNull();
    await expect(adapter.exists("/remote/file.json")).resolves.toBe(true);
    await release;

    // It rode the deliberate release, so it is neither counted nor warned.
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    // The initial dial plus the one re-establishment the op waited for.
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("an op issued during a release that records no boundary still waits the close window out", async () => {
    // The release in flight is the reading that covers the close window, and it
    // is the ONLY one that covers this release: the PEER began this teardown, so
    // no deliberate-release boundary is recorded and the boundary reading never
    // becomes true. An op issued into the window must still be held off -- it
    // would otherwise reject against a session that still reads live, which the
    // clean-loss classifier calls terminal.
    const { client, connect, rawClient, state } =
      slowClosingClient(wrapperMethods());
    const socket = rawClient._sock as Record<string, unknown>;
    // The peer's FIN has been consumed: ssh2 has emitted 'end' and the 'close' is
    // on its way, which is what makes this boundary the server's rather than this
    // adapter's.
    socket.readableEnded = true;
    // Each attempt records whether it was made inside the close window (the ssh2
    // Client's end() driven, its 'close' not yet landed, the session still
    // reading live).
    const attempts: boolean[] = [];
    client.exists = vi.fn(async () => {
      attempts.push(state.ending);
      if (state.ending)
        throw new Error("Channel closed while the connection was ending");
      if (!state.live) throw notConnected("exists");
      return true;
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    const release = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    expect(client.sftp).not.toBeNull();
    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);

    await expect(adapter.exists("/remote/file.json")).resolves.toBe(true);
    await release;

    // One attempt, made on the far side of the close rather than inside it.
    expect(attempts).toEqual([false]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("the release latch is one-shot: a drop after the cycle-start re-dial is counted and warned", async () => {
    // Exempting the release must not blanket-exempt the mode. The latch is
    // discharged by the re-establishment itself, so the very next cleared session
    // in that same cycle is what it looks like -- an unexpected drop -- and is
    // counted and warned like any other.
    const wrapper = wrapperMethods({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, connect, state } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(adapter.midExchangeReconnectCount).toBe(0);

    // The server drops the freshly established session mid-cycle.
    state.live = false;
    await expect(adapter.list("/remote/dir")).resolves.toEqual([]);

    expect(connect).toHaveBeenCalledTimes(3);
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped mid-exchange"),
    );
  });

  test("a release that finds no session charges the drop it found and leaves the next op none to charge", async () => {
    // releaseForIdle returns early when the session is ALREADY gone, which means
    // the server dropped it before the boundary -- a real drop the operator must
    // still see, and the release is the first thing in the run to observe it. It
    // charges the lost session there, records no reading that a release took it,
    // and warns the operator; the operation that follows re-dials over the same
    // ended generation and so adds nothing.
    const wrapper = wrapperMethods({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, connect, state, rawClient } = ephemeralClient(wrapper);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    // The drop lands at the tail of the cycle, before the idle boundary runs.
    state.live = false;
    await adapter.releaseForIdle();
    // Nothing to close: the release took its early return without driving end().
    expect(rawClient.end).not.toHaveBeenCalled();
    // The boundary charged the drop it found, and told the operator about a lost
    // session no operation was on the wire to report.
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("ended the SFTP session before this"),
    );
    // Not a boundary that RELEASED anything, so the release totals stay empty.
    expect(adapter.releasedBoundaryCount).toBe(0);
    expect(adapter.forcedReleaseCount).toBe(0);

    await expect(adapter.list("/remote/dir")).resolves.toEqual([]);

    // The operation re-dialed over the generation the boundary had already ended,
    // so one partner cut is still one in each counter.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes("dropped mid-exchange"),
      ),
    ).toHaveLength(0);
  });

  test("a release during teardown does not latch", async () => {
    // `closing` is latched by end(), and a release arriving after it returns at
    // once without touching the session. Nothing was released, so nothing may be
    // latched: the latch exempts the next re-establishment from the reconnect
    // count and the operator warning, and a release that did nothing has no
    // exemption to hand out. Asserted on the latch itself because teardown leaves
    // no behavior to read it through -- `closing` also disables recovery.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.end();
    await adapter.releaseForIdle();

    expect(rawClient.end).not.toHaveBeenCalled();
    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);
  });

  // Every seam the idle release drives past the public API, and where it lives.
  // The release is the only caller of any of them, so an upgrade that relocates
  // one takes the boundary with it silently -- a session held across every idle
  // gap, which is the one thing this mode exists to prevent.
  const idleReleaseSeams = [
    {
      seam: "client.end()",
      remove: (raw: Record<string, unknown>) => {
        delete raw.end;
      },
    },
    {
      seam: "client.once()",
      remove: (raw: Record<string, unknown>) => {
        raw.once = undefined;
      },
    },
    {
      seam: "client.removeListener()",
      remove: (raw: Record<string, unknown>) => {
        raw.removeListener = undefined;
      },
    },
    {
      seam: "client._sock.destroy()",
      remove: (raw: Record<string, unknown>) => {
        delete (raw._sock as Record<string, unknown>).destroy;
      },
    },
    {
      seam: "client._sock.writableEnded",
      remove: (raw: Record<string, unknown>) => {
        delete (raw._sock as Record<string, unknown>).writableEnded;
      },
    },
  ] as const;

  test.each(idleReleaseSeams)(
    "connect fails loudly when $seam is gone",
    async ({ seam, remove }) => {
      const { client, rawClient } = ephemeralClient(wrapperMethods());
      remove(rawClient);
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);

      const dial = adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      await expect(dial).rejects.toThrow(seam);
      // Named alongside the checklist that re-verifies it, so the operator who
      // hits this on an upgrade is not left to find it.
      await expect(dial).rejects.toThrow("DEPENDENCY_PINS.md");
    },
  );

  test("the default held-session mode is not held to the release's seams", async () => {
    // Nothing outside connection-per-poll mode drives any of them, so failing a
    // held-session dial on a seam it never reaches would ground the whole SFTP
    // channel on an upgrade that costs it nothing.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    delete rawClient.end;
    delete (rawClient._sock as Record<string, unknown>).destroy;
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await expect(
      adapter.connect({ host: "h", maxReconnectAttempts: 2 }),
    ).resolves.toBeUndefined();
  });

  // A server that accepts the disconnect and then goes quiet. ssh2's Client.end()
  // ends the socket and the Client emits 'close' only from the socket's own, so
  // the connection sits in half-close: the transport is ended, no close ever
  // arrives, and ssh2-sftp-client's session property stays set. Destroying the
  // socket needs nothing from that server, and the 'close' it produces is what
  // clears the session -- the sequence measured against a real ssh2 server.
  function withheldCloseClient(wrapper: ReturnType<typeof wrapperMethods>) {
    const built = ephemeralClient(wrapper);
    const { state, rawClient } = built;
    const sock = rawClient._sock as {
      writableEnded?: boolean;
      destroy?: () => void;
    };
    rawClient.end = vi.fn(() => {
      sock.writableEnded = true;
    });
    sock.destroy = vi.fn(() => {
      state.live = false;
      rawClient.emit("close");
    });
    return { ...built, sock };
  }

  test("a release whose close never lands forces the transport closed, so the next cycle re-dials before any op", async () => {
    // The defect this closes: the release's own end() has already ended the
    // transport, so a session left set behind it can serve nothing -- yet
    // ensureConnected reads it as live and skips the cycle's dial, and the first
    // operation of that cycle rides the per-operation liveness deadline into a
    // terminal failure. The release must not hand that state to the next cycle: it
    // forces the socket closed itself, which clears the session, so the cycle
    // starts by dialing a fresh one.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, sock } =
        withheldCloseClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      // The listeners the adapter holds on the Client across a dial: its
      // persistent transport-lifecycle watch, and nothing else. Anything above
      // this afterwards is a close wait that outlived the release that armed it.
      const dialedCloseListeners = rawClient.listenerCount("close");
      const release = adapter.releaseForIdle();
      // The adapter's own close bound (not exported; a liveness backstop, not a
      // tunable). Past it the partner's close is still outstanding.
      await vi.advanceTimersByTimeAsync(5_000);
      await release;

      expect(rawClient.end).toHaveBeenCalledOnce();
      expect(sock.destroy).toHaveBeenCalledOnce();
      // The session the next cycle reads is gone, so the dial cannot be skipped.
      expect(client.sftp).toBeNull();
      expect(state.live).toBe(false);
      // Nothing was left waiting on the ssh2 Client for a close that never came;
      // the next cycle's release installs its own.
      expect(rawClient.listenerCount("close")).toBe(dialedCloseListeners);

      // The next cycle: the session is RE-ESTABLISHED before any operation is
      // issued, rather than an operation being issued against the ended transport.
      await expect(adapter.ensureConnected()).resolves.toBe(true);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(state.live).toBe(true);
      await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

      // A forced release is still this adapter's own deliberate boundary, so the
      // re-dial that follows it is neither counted nor reported as a drop.
      expect(adapter.reconnectCount).toBe(0);
      expect(adapter.midExchangeReconnectCount).toBe(0);
      const dropWarns = warn.mock.calls.filter((c) =>
        (c[0] as string).includes("dropped mid-exchange"),
      );
      expect(dropWarns).toEqual([]);

      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain("did not close the connection");
      expect(message).toContain("closed it from this side");
      expect(message).toContain("dials a fresh session");
      expect(message).toContain("the exchange continues");
      expect(message).not.toContain("stall");
      expect(message).not.toContain("will not replace it");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a genuine drop in the cycle after a forced release is still counted and warned", async () => {
    // The forced release keeps the latch (it is the mode's own boundary), so the
    // latch has to be discharged by the re-establishment that follows exactly as
    // an ordinary release's is. Otherwise the first real server-side drop of the
    // new cycle would inherit the release's exemption and never reach the operator.
    vi.useFakeTimers();
    try {
      const { client, connect, state } = withheldCloseClient(
        wrapperMethods({
          opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
            cb(null, Buffer.from("h")),
          readdir: (
            _h: Buffer,
            cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
          ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
          close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
        }),
      );
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      const release = adapter.releaseForIdle();
      await vi.advanceTimersByTimeAsync(5_000);
      await release;
      await expect(adapter.ensureConnected()).resolves.toBe(true);
      expect(adapter.midExchangeReconnectCount).toBe(0);

      // The server drops the freshly established session mid-cycle.
      state.live = false;
      await expect(adapter.list("/remote/dir")).resolves.toEqual([]);

      expect(connect).toHaveBeenCalledTimes(3);
      expect(adapter.reconnectCount).toBe(1);
      expect(adapter.midExchangeReconnectCount).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("dropped mid-exchange"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("a forced release warns on the first and then on the rate-escalated cadence", async () => {
    // A partner that never closes forces one of these EVERY cycle, so an unpaced
    // line would fill an hours-long exchange's log. It follows the cadence a
    // chronic mid-exchange re-dial already gets: the first, then every
    // SFTP_REDIAL_WARN_INTERVAL-th. Driven past two intervals rather than one, so
    // what is pinned is the repeating cadence and not merely its first escalation:
    // an off-by-one in either term would still produce one line at the interval.
    vi.useFakeTimers();
    try {
      const { client, sock, rawClient } = withheldCloseClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      const dialedCloseListeners = rawClient.listenerCount("close");
      const cycles = SFTP_REDIAL_WARN_INTERVAL * 2 + 1;
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        const release = adapter.releaseForIdle();
        await vi.advanceTimersByTimeAsync(5_000);
        await release;
        await adapter.ensureConnected();
      }

      expect(sock.destroy).toHaveBeenCalledTimes(cycles);
      // Every cycle re-dialed, and none of them was reported as a drop.
      expect(adapter.reconnectCount).toBe(0);
      // The forced total is a SUBSET of the released one -- the same boundary
      // reached two ways -- so an exchange whose every cycle was forced reads as
      // the whole of its denominator rather than as a total with none.
      expect(adapter.forcedReleaseCount).toBe(cycles);
      expect(adapter.releasedBoundaryCount).toBe(cycles);
      expect(warn).toHaveBeenCalledTimes(3);
      // The number in each line is the number of boundaries the sentence
      // describes, which is the end-of-run summary's total: the first occurrence
      // and every interval-th after it, with the trailing occurrences past the
      // last one silent.
      expect(warn.mock.calls[0][0]).toContain(
        "1 idle boundary closed this way so far",
      );
      expect(warn.mock.calls[1][0]).toContain(
        `${SFTP_REDIAL_WARN_INTERVAL} idle boundaries closed this way so far`,
      );
      expect(warn.mock.calls[2][0]).toContain(
        `${SFTP_REDIAL_WARN_INTERVAL * 2} idle boundaries closed this way so far`,
      );
      // Each cycle's release installs and consumes its own close wait, so nothing
      // accumulates on the ssh2 Client the library keeps across reconnects: the
      // count is back to the one persistent watch a dial leaves behind.
      expect(rawClient.listenerCount("close")).toBe(dialedCloseListeners);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the forced close's bound is ref'd; the release's own stays unref'd", async () => {
    // A liveness bound the process can exit out from under is not a bound. After
    // the socket is destroyed there is no ref'd handle left in the destroyed
    // socket's place, so an unref'd forced-close timer never fires: the one case
    // that bound exists for -- an ssh2 that stopped emitting 'close' on a destroyed
    // socket -- would exit the CLI silently mid-exchange instead of reaching the
    // check behind it. The release's own bound waits on a half-ended socket, which
    // is still a ref'd handle, so it keeps the unref'd-liveness-timer contract.
    vi.useFakeTimers();
    const armed: { delayMs: number; handle: { hasRef(): boolean } }[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((
        callback: (...args: unknown[]) => void,
        delayMs?: number,
        ...rest: unknown[]
      ) => {
        const handle = realSetTimeout(callback, delayMs, ...rest);
        armed.push({
          delayMs: delayMs ?? 0,
          handle: handle as unknown as { hasRef(): boolean },
        });
        return handle;
      }) as unknown as typeof setTimeout);
    try {
      const { client, sock } = withheldCloseClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      const release = adapter.releaseForIdle();
      // The release's own close bound expires, then the forced close runs.
      await vi.advanceTimersByTimeAsync(5_000);
      await release;
      expect(sock.destroy).toHaveBeenCalledOnce();

      // The two bounds, identified by their (unexported, liveness-backstop) delays.
      const releaseBound = armed.filter((timer) => timer.delayMs === 5_000);
      const forcedBound = armed.filter((timer) => timer.delayMs === 1_000);
      expect(releaseBound).toHaveLength(1);
      expect(forcedBound).toHaveLength(1);
      expect(releaseBound[0].handle.hasRef()).toBe(false);
      expect(forcedBound[0].handle.hasRef()).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test("an op issued while the forced close runs waits for it instead of stalling on the ended transport", async () => {
    // The forced close runs past the release's own close bound, and the session
    // still reads live inside it. An operation arriving there must serialize behind
    // the release the way one arriving before the bound expired does -- otherwise
    // it is admitted by a session that cannot answer and rides the per-operation
    // liveness deadline, which is exactly the terminal failure being fixed.
    vi.useFakeTimers();
    try {
      const { client, connect, rawClient, sock } =
        withheldCloseClient(wrapperMethods());
      const state = { destroyed: false };
      // A destroy whose 'close' lands a macrotask later, so the window is real.
      sock.destroy = vi.fn(() => {
        setTimeout(() => {
          state.destroyed = true;
          client.sftp = null;
          rawClient.emit("close");
        }, 0);
      });
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      const release = adapter.releaseForIdle();
      await vi.advanceTimersByTimeAsync(5_000);
      // Inside the forced close: the destroy has been driven, its 'close' has not
      // landed, and the session still reads live.
      expect(sock.destroy).toHaveBeenCalledOnce();
      expect(state.destroyed).toBe(false);
      expect(client.sftp).not.toBeNull();

      const op = adapter.exists("/remote/out.json");
      await vi.advanceTimersByTimeAsync(1);
      await release;
      await expect(op).resolves.toBe(true);
      // The op ran on a session the release re-established, not on the ended one.
      expect(connect).toHaveBeenCalledTimes(2);
      expect(adapter.reconnectCount).toBe(0);
      expect(adapter.midExchangeReconnectCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a release that finds the transport still writable drops the latch", async () => {
    // The warning above rests on an ssh2 premise -- end() ends the socket -- so it
    // is checked, not asserted: an ssh2 whose end() stopped ending the socket would
    // leave a genuinely live session held across the idle gap, the one thing this
    // mode exists to prevent, and the operator must be pointed at the changelog
    // rather than told to expect a stall. It is also the one branch where the
    // session may still be LIVE, so the check has to carry the latch as well as the
    // log line: a latch standing over a live session exempts its next genuine drop
    // from the count and the warning. Proven by dropping that session and requiring
    // the re-dial to be reported.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient } =
        ephemeralClient(wrapperMethods());
      // An end() that neither ends the transport nor closes anything, over a socket
      // that reports the half-close flag a live net.Socket does.
      rawClient.end = vi.fn();
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      const release = adapter.releaseForIdle();
      await vi.advanceTimersByTimeAsync(5_000);
      await release;

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("still writable"),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("ssh2 changelog"),
      );
      expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);
      expect(state.live).toBe(true);

      // The server drops the session the release could not close: a real loss.
      state.live = false;
      await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

      expect(connect).toHaveBeenCalledTimes(2);
      expect(adapter.reconnectCount).toBe(1);
      expect(adapter.midExchangeReconnectCount).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("dropped mid-exchange"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("a second release that closes nothing draws a second warning", async () => {
    // The one degraded outcome deliberately off the shared warn cadence: it
    // keeps no run total, so a paced line would say "1" every time it fired and
    // the operator could not tell one occurrence from ten. Every occurrence is
    // its own record instead, which only a second one can measure -- the shared
    // cadence's interval is wide enough that it would swallow this line.
    vi.useFakeTimers();
    try {
      const { client, rawClient } = ephemeralClient(wrapperMethods());
      rawClient.end = vi.fn();
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const release = adapter.releaseForIdle();
        await vi.advanceTimersByTimeAsync(5_000);
        await release;
      }

      expect(
        warn.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes("still writable")),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a release that finds the PEER tearing the connection down charges that drop and does not latch", async () => {
    // ssh2 emits 'end' on the peer's FIN and 'close' only after, and
    // ssh2-sftp-client's global 'end' listener leaves its session property set, so
    // a release can walk into a server-initiated teardown and find a session that
    // still reads live. Its end() closes nothing there -- the peer already did --
    // so the boundary charges the loss to the partner and records no reading that
    // a release took the session; latching would hand a genuine drop the release's
    // own exemption and the operator would never hear about it.
    const { client, connect, state, rawClient } =
      ephemeralClient(wrapperMethods());
    const sock = rawClient._sock as { readableEnded?: boolean };
    // The peer's FIN has been consumed: this teardown is the server's.
    sock.readableEnded = true;
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();

    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);
    expect(state.live).toBe(false);
    // The peer took this session, so the boundary charges it and says so, and it
    // is not one this side released.
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("ended the SFTP session before this"),
    );
    expect(adapter.releasedBoundaryCount).toBe(0);

    // The next operation re-establishes over the generation the boundary already
    // ended, so the one cut stays one in each counter.
    await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("a throwing ssh2 end() rejects the release, leaving no boundary and no held transition", async () => {
    // The release takes the transition lock, arms its close wait, and records its
    // boundary before it drives the close, so a throw out of the ssh2 Client's
    // end() must undo all three: a lock never released would hold the next
    // operation's gate forever, the wait would sit on the shared client for a
    // close that is never coming, and the boundary would exempt a later genuine
    // drop from the count and the warning.
    const { client, state, rawClient } = ephemeralClient(wrapperMethods());
    rawClient.end = vi.fn(() => {
      throw new Error("socket already destroyed");
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    const dialedCloseListeners = rawClient.listenerCount("close");
    await expect(adapter.releaseForIdle()).rejects.toThrow(
      "socket already destroyed",
    );

    expect(state.live).toBe(true);
    // Nothing was left for the next operation to wait on: it runs on the session
    // the failed release never closed, rather than stalling out the close bound.
    const outcome = await Promise.race([
      adapter.exists("/remote/out.json").then(() => "ran"),
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 250)),
    ]);
    expect(outcome).toBe("ran");
    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);
    // Back to the one persistent transport-lifecycle watch a dial leaves behind:
    // the release's own close wait was dismantled on its way out.
    expect(rawClient.listenerCount("close")).toBe(dialedCloseListeners);
  });

  // Every data-plane operation on the transport contract reaches the server
  // through the same recovery chokepoint, so every one must cross an idle
  // boundary the same way. The table below is that enumeration; the guard under
  // it is what makes adding an operation to the contract without a row here fail
  // `npm run typecheck` instead of silently leaving that operation uncovered.
  type RecoveredDataPlaneOp = Exclude<
    keyof FileTransportClient,
    // Lifecycle, not data plane: these establish and release the session the
    // table's ops ride on.
    | "connect"
    | "end"
    | "releaseForIdle"
    | "ensureConnected"
    | "beginTeardown"
    // The never-reject cleanup delete. It swallows every outcome instead of being
    // recovery-wrapped, so it never reaches this table's chokepoint: it neither
    // re-establishes before its attempt nor touches the reconnect counters and the
    // warning these rows assert about. What it does across a boundary instead --
    // record the cleanup and re-issue it at the next re-establishment -- is
    // asserted by the cleanup-delete cases above, which is what keeps this
    // exclusion an exclusion from THIS crossing rather than from coverage. Adding
    // a second such op is a deliberate edit of this list, not an omission.
    | "safeDelete"
  >;
  const dataPlaneOps = [
    { op: "list", run: (a: SSH2SFTPClientAdapter) => a.list("/remote/dir") },
    { op: "get", run: (a: SSH2SFTPClientAdapter) => a.get("/remote/in.json") },
    {
      op: "put",
      run: (a: SSH2SFTPClientAdapter) =>
        a.put(Buffer.from("payload"), "/remote/out.tmp", { flags: "w" }),
    },
    {
      op: "delete",
      run: (a: SSH2SFTPClientAdapter) => a.delete("/remote/out.json"),
    },
    {
      op: "rename",
      run: (a: SSH2SFTPClientAdapter) =>
        a.rename("/remote/out.tmp", "/remote/out.json"),
    },
    {
      op: "createExclusive",
      run: (a: SSH2SFTPClientAdapter) =>
        a.createExclusive("/remote/x-lock.json"),
    },
    {
      op: "exists",
      run: (a: SSH2SFTPClientAdapter) => a.exists("/remote/out.json"),
    },
  ] as const satisfies ReadonlyArray<{
    op: RecoveredDataPlaneOp;
    run: (adapter: SSH2SFTPClientAdapter) => Promise<unknown>;
  }>;
  type UncoveredDataPlaneOp = Exclude<
    RecoveredDataPlaneOp,
    (typeof dataPlaneOps)[number]["op"]
  >;
  // `true` only while the table covers the contract: an uncovered op makes the
  // annotation `never` and this initializer a type error.
  const everyDataPlaneOpIsCovered: UncoveredDataPlaneOp extends never
    ? true
    : never = true;

  test("every data-plane op re-establishes across an idle release, uncounted and unwarned", async () => {
    expect(everyDataPlaneOpIsCovered).toBe(true);

    for (const { op, run } of dataPlaneOps) {
      const wrapper = wrapperMethods({
        opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
          cb(null, Buffer.from("h")),
        readdir: (
          _h: Buffer,
          cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
        ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
        open: (
          _p: string,
          _f: number,
          _a: object,
          cb: (e: Error | null, h: Buffer) => void,
        ) => cb(null, Buffer.from("h")),
        close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
      });
      const { client, connect, state } = ephemeralClient(wrapper);
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
      install(adapter, client);

      await adapter.connect({ host: "h", retries: 0, maxReconnectAttempts: 2 });
      await adapter.releaseForIdle();
      expect(state.live, op).toBe(false);

      await run(adapter);

      expect(state.live, op).toBe(true);
      expect(connect, op).toHaveBeenCalledTimes(2);
      expect(adapter.reconnectCount, op).toBe(0);
      expect(adapter.midExchangeReconnectCount, op).toBe(0);
      expect(warn, op).not.toHaveBeenCalled();
    }
  });

  test("the retain-mode ack write crosses an idle release uncounted and unwarned", async () => {
    // The ack write issues a put and then a rename with no session precondition
    // of its own. It rides the same chokepoint as every other op, so it needs no
    // placement guarantee: prove it by running the pair across a boundary, in the
    // order writeAck issues them.
    const { client, connect, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", retries: 0, maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    expect(state.live).toBe(false);

    await adapter.put(Buffer.alloc(0), "/remote/temp-ack.tmp", { flags: "w" });
    await adapter.rename("/remote/temp-ack.tmp", "/remote/id-msg-ack.json");

    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a host-key rejection on the post-release re-establishment fails the op terminally", async () => {
    // The post-release re-establishment is best-effort so it cannot break the
    // never-reject callers, but nothing is swallowed for good: a server presenting
    // a different key is a trust-boundary fault, and it must still reach the
    // caller as a terminal failure rather than being ridden to a timeout.
    const wrapper = wrapperMethods();
    const state = { live: true };
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: { setKeepAlive: vi.fn(), writableEnded: false, destroy: vi.fn() },
      end: vi.fn(() => {
        state.live = false;
        rawClient.emit("close");
      }),
    });
    let dials = 0;
    const connect = vi.fn().mockImplementation(async () => {
      dials += 1;
      if (dials === 1) {
        state.live = true;
        return;
      }
      throw new Error("Host denied (verification failed)");
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
      exists: vi.fn(async () => {
        if (!state.live) throw notConnected("exists");
        return true;
      }),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await adapter.releaseForIdle();

    await expect(adapter.exists("/remote/out.json")).rejects.toThrow(
      "Host denied",
    );
    expect(adapter.midExchangeReconnectCount).toBe(0);
  });

  test("the default held-session mode is untouched: drops still counted, warned, and capped", async () => {
    // The release path is mode-gated at every point it touches, so the default
    // whole-exchange model behaves as though the mode did not exist: calling the
    // boundary methods changes nothing, and a genuine drop is still counted,
    // warned, and charged against the cumulative max_reconnect_attempts budget
    // whose exhaustion is terminal. What the default mode does share is the
    // transition lock -- its connect() and its end() take it too -- and the two
    // orderings that follow from that are pinned separately (the first dial
    // acquiring, so teardown cannot run the client down under it; and a connect
    // issued during an in-flight teardown parking before it refuses the re-open).
    const wrapper = wrapperMethods({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, connect, state, rawClient } = ephemeralClient(wrapper);
    // Default construction: connection-per-poll off.
    const adapter = new SSH2SFTPClientAdapter();
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
    // Both boundary methods are no-ops here and leave no release behind.
    await adapter.releaseForIdle();
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);

    // The one drop the budget allows: recovered, counted, and warned.
    state.live = false;
    await expect(adapter.list("/remote/dir")).resolves.toEqual([]);
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("dropped mid-exchange");
    expect(warn.mock.calls[0][0]).toContain("max_reconnect_attempts=1");

    // The next drop exhausts the cumulative budget and is terminal.
    state.live = false;
    const error = await adapter.list("/remote/dir").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain(
      "reconnection budget is exhausted",
    );
    // Two sessions lost, one of them recovered: the budget bounds the losses.
    expect(adapter.midExchangeReconnectCount).toBe(2);

    await adapter.end();
  });

  test("two concurrent ensureConnected calls open a single connect (serialized)", async () => {
    // poll()'s cycle-start ensureConnected and close()'s pre-drain ensureConnected
    // can fire concurrently; both must not open a parallel connect() on the one
    // shared Ssh2SftpClient (it shares connection-level listeners, so two handshakes
    // at once is unsafe). The second call must queue behind the first's re-dial
    // and observe the now-live session rather than dialing again.
    const wrapper = wrapperMethods();
    const state = { live: true };
    // A realistic handshake: the session becomes live only AFTER an async tick, not
    // synchronously. That lag is what makes the race real -- a second concurrent
    // ensureConnected that resumes before the first's connect settles still sees a
    // cleared session, so without serialization it would open a parallel connect().
    const connect = vi.fn().mockImplementation(async () => {
      await Promise.resolve();
      state.live = true;
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    expect(connect).toHaveBeenCalledTimes(1);

    // A released session, then two ensureConnected fired without awaiting between.
    state.live = false;
    const [a, b] = await Promise.all([
      adapter.ensureConnected(),
      adapter.ensureConnected(),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    // The initial dial plus a SINGLE cycle-start re-dial: the second call awaited
    // the first's re-dial and saw the live session, so no parallel connect().
    expect(connect).toHaveBeenCalledTimes(2);
    expect(state.live).toBe(true);
  });

  test("no idle boundary across a recovery arm closes the session the arm is using", async () => {
    // Dialing while a release is in flight, between the ssh2 Client's end() and its
    // 'close', hands the release's stale 'close' to the temp listeners connect()
    // installs and fails the handshake, charging a healthy exchange a re-dial retry
    // (or, at max_reconnect_attempts=0, failing the operation outright) for a
    // session the adapter closed on purpose. Closing between the re-dial and the
    // re-issue is worse: the re-issue rejects on a session this side has just taken
    // away, and a rename that DID land surfaces as a failure.
    //
    // What rules both out is one span: an operation is counted outstanding from
    // where it is ISSUED to where it finally settles, the failed attempt, the
    // re-dial and the re-issue all inside it, so every boundary that falls across
    // an arm is HELD. Swept across the whole arm rather than placed at one point --
    // a depth that closed would be exactly the hole this pins shut, and there is no
    // reading of the count that names it.
    const depths = 40;
    for (let depth = 0; depth < depths; depth += 1) {
      const { client, connect, state, rawClient, tearChannelWithholdingClose } =
        midWireTearClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
      install(adapter, client);

      // No reconnection budget at all, so a handshake lost to a release's close is
      // terminal rather than quietly retried a second later.
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      const dialsBeforeTheDrop = connect.mock.calls.length;

      const op = adapter.exists("/remote/out.json");
      tearChannelWithholdingClose();
      // An idle transition queue is entered in the calling tick, so a release
      // called at this depth is a release ENTERED there.
      for (let tick = 0; tick < depth; tick += 1) await Promise.resolve();
      const release = adapter.releaseForIdle();

      await expect(op).resolves.toBe(true);
      await release;

      // Nothing was closed at any depth: the release found the operation counted
      // and kept the boundary, so the one dial in the run is the arm's re-dial
      // rather than a cycle start behind a close.
      expect(rawClient.end, `depth ${depth}`).not.toHaveBeenCalled();
      expect(adapter.heldBoundaryCount, `depth ${depth}`).toBe(1);
      expect(state.live, `depth ${depth}`).toBe(true);
      expect(
        connect.mock.calls.length - dialsBeforeTheDrop,
        `depth ${depth}`,
      ).toBe(1);
      // One partner cut, counted once and warned once whatever the depth.
      expect(adapter.midExchangeReconnectCount, `depth ${depth}`).toBe(1);
      expect(adapter.reconnectCount, `depth ${depth}`).toBe(1);
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes("dropped mid-exchange"),
        ),
        `depth ${depth}`,
      ).toHaveLength(1);
    }
  });

  // A release landing beside the recovery arm of an operation a PARTNER tore, at
  // both widths a cut can land on. A drop that withheld the partner's connection
  // close leaves the session property still set, so the release would find
  // something to close were it not held. The width decides how many arms recover
  // from the cut, and it may not decide how many drops the operator is told about;
  // the wide arms are what put a release next to a whole fan-out of recovery arms,
  // which is the interleaving the narrow ones cannot reach.
  test.each([1, 3])(
    "one partner drop tearing %i operation(s) is counted and warned once with a " +
      "release landing beside the arm",
    async (width: number) => {
      const { client, connect, state, tearChannelWithholdingClose } =
        midWireTearClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      const dialsBeforeTheDrop = connect.mock.calls.length;

      // Issued in one turn, so the cut lands on the whole set rather than on
      // whichever member was left.
      const ops = Array.from({ length: width }, () =>
        adapter.exists("/remote/out.json"),
      );
      tearChannelWithholdingClose();
      // An idle transition queue is entered in the calling tick, so a release
      // called here is a release ENTERED at this reading of the count.
      expect(outstandingOperations(adapter)).toBe(width);
      const release = adapter.releaseForIdle();

      // Every torn operation recovers on its own result, whichever of them dialed.
      expect(await Promise.all(ops)).toEqual(ops.map(() => true));
      await release;

      expect(state.live).toBe(true);
      expect(adapter.heldBoundaryCount).toBe(1);
      // One partner cut, one dial to recover it, counted once in each metric and
      // warned once, however many operations it tore.
      expect(connect.mock.calls.length - dialsBeforeTheDrop).toBe(1);
      expect(adapter.midExchangeReconnectCount).toBe(1);
      expect(adapter.reconnectCount).toBe(1);
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes("dropped mid-exchange"),
        ),
      ).toHaveLength(1);
    },
  );

  test("a release that closed over a partner-ended transport charges that drop and leaves no session for the next operation", async () => {
    // The release's boundary answers two questions and only one of them is the
    // recovery path's. Recording nothing at all here -- rather than a reading that
    // answers the session question without calling the loss deliberate -- would
    // leave the next operation to be issued at the session this release took, fail
    // on it, and be recovered as a SECOND drop: one partner cut reported twice,
    // with a doomed round trip and a spurious re-dial in between.
    const { client, connect, state, socket } =
      ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    // The partner dropped the session and withheld its connection close with nothing
    // on the wire: ssh2 answered the disconnect by ending its own half of the
    // transport, and no listener that clears the session has run, so the release
    // still finds one to close.
    socket.writableEnded = true;
    await adapter.releaseForIdle();
    expect(state.live).toBe(false);
    // Not the exempting reading -- there was a loss here, and the next operation to
    // suffer one must not inherit an exemption from it -- while the session question
    // the same boundary answers is what the gate below acts on.
    expect(releaseBoundaryStands(adapter)).toBe(false);
    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(true);
    // The release ended this session, so it is one of the boundaries that
    // released one -- what ENDED the transport beneath it is the separate
    // question, and the answer to that is what the loss is charged on.
    expect(adapter.releasedBoundaryCount).toBe(1);
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("ended the SFTP session before this"),
    );

    await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

    // The one re-establishment is the gate's, ahead of the operation's first
    // attempt: nothing was issued at the released session, so the operation adds
    // no second report of the one drop.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(adapter.reconnectCount).toBe(1);
    // Scoped to the drop line rather than to the whole log: this stand-in's ssh2
    // end() closes a transport its caller had already ended, where the real stack
    // leaves it in half-close until the release's bound expires and the forced
    // close reports that path's line instead. What an operator sees for this shape
    // is driven against a real server in
    // test/integration/ephemeralSessionExchange.test.ts.
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes("dropped mid-exchange"),
      ),
    ).toHaveLength(0);
  });

  test("an ordinary per-poll release counts no reconnection at any boundary", async () => {
    // The misreport the arm's read order exists to prevent, from the side the mode
    // spends every cycle on: release, re-dial, and nothing lost. Driven over several
    // cycles rather than one, because what would fail here is a boundary reading that
    // reported the mode's own lifecycle as a drop -- which it would do at every poll
    // interval, filling a long exchange's log and burying a chronic capper.
    const { client, connect } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);
      await adapter.releaseForIdle();
      await expect(adapter.ensureConnected()).resolves.toBe(true);
    }

    // The first dial plus one per cycle, none of them a recovery re-dial.
    expect(connect).toHaveBeenCalledTimes(4);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.forcedReleaseCount).toBe(0);
    expect(adapter.heldBoundaryCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("the idle release waits an in-flight re-dial out instead of leaving its session held", async () => {
    // The mirror of the case above: a re-dial (a cycle-start ensureConnected, as
    // close()'s pre-drain reconnect fires, or a recovery re-dial) can be
    // mid-handshake when the poll loop reaches its idle boundary. Without the
    // wait the release reads the not-yet-established session as "nothing to
    // release" and returns having released and latched nothing, and the dial then
    // lands a session that is held across the entire idle gap -- the one thing
    // this mode exists to prevent.
    const wrapper = wrapperMethods();
    const state = { live: true };
    let dialReached!: () => void;
    const dialing = new Promise<void>((resolve) => {
      dialReached = resolve;
    });
    let finishDial!: () => void;
    const handshake = new Promise<void>((resolve) => {
      finishDial = resolve;
    });
    let dials = 0;
    const connect = vi.fn().mockImplementation(async () => {
      dials += 1;
      // The initial dial completes at once; the cycle-start re-dial is held open
      // by the test so the boundary can fall in the middle of it.
      if (dials > 1) {
        dialReached();
        await handshake;
      }
      state.live = true;
    });
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: { setKeepAlive: vi.fn(), writableEnded: false, destroy: vi.fn() },
      end: vi.fn(() => {
        state.live = false;
        rawClient.emit("close");
      }),
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // The previous cycle released; this cycle's re-dial is in flight.
    state.live = false;
    const ready = adapter.ensureConnected();
    await dialing;

    const release = adapter.releaseForIdle();
    finishDial();
    await expect(ready).resolves.toBe(true);
    await release;

    // The release found the session the dial established and closed it, so no
    // session is held across the idle gap.
    expect(rawClient.end).toHaveBeenCalledOnce();
    expect(state.live).toBe(false);
    expect(releaseBoundaryStands(adapter)).toBe(true);
  });

  test("an idle release that was waiting when teardown began releases nothing", async () => {
    // The mirror of the cycle-start case below: the release can be parked for a
    // dial's whole budget, and close() can land in the middle of that wait, so the
    // check it made on entry is stale by the time it resumes. Driving the ssh2
    // Client's end() on the far side would run this release's teardown alongside
    // close()'s own client.end() on the one shared client, and latch a deliberate
    // release over a session the teardown is what ended.
    const wrapper = wrapperMethods();
    const state = { live: true };
    let dialReached!: () => void;
    const dialing = new Promise<void>((resolve) => {
      dialReached = resolve;
    });
    let finishDial!: () => void;
    const handshake = new Promise<void>((resolve) => {
      finishDial = resolve;
    });
    let dials = 0;
    const connect = vi.fn().mockImplementation(async () => {
      dials += 1;
      // The initial dial completes at once; the cycle-start re-dial is held open
      // by the test so the boundary and the teardown can both fall inside it.
      if (dials > 1) {
        dialReached();
        await handshake;
      }
      state.live = true;
    });
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: { setKeepAlive: vi.fn(), writableEnded: false, destroy: vi.fn() },
      end: vi.fn(() => {
        state.live = false;
        rawClient.emit("close");
      }),
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // The previous cycle released; this cycle's re-dial is in flight.
    state.live = false;
    const ready = adapter.ensureConnected();
    await dialing;

    const release = adapter.releaseForIdle();
    // The teardown begins while that release is waiting the dial out.
    const closed = adapter.end();
    finishDial();
    await Promise.all([ready, release, closed]);

    // The release drove no ssh2 Client end() of its own: close() owns the final
    // teardown, and the release classified nothing at all.
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);
    expect(client.end).toHaveBeenCalledOnce();
  });

  test("end() waits the in-flight release out before tearing the client down", async () => {
    // The release's ssh2 Client end() and this teardown's client.end() must not
    // overlap on the one shared Ssh2SftpClient. close() can reach end() while the
    // poll loop's last release is still between the two, so end() waits it out.
    const { client, state, rawClient } = slowClosingClient(wrapperMethods());
    let sessionAtTeardown: { live: boolean; ending: boolean } | undefined;
    client.end = vi.fn(async () => {
      sessionAtTeardown = { ...state };
      return true;
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const release = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    const closed = adapter.end();
    await Promise.all([release, closed]);

    // The library end() ran on the far side of the release's 'close', not inside
    // the window where the connection is going away but still reads live.
    expect(sessionAtTeardown).toEqual({ live: false, ending: false });
  });

  test("the cycle-start reconnect waits the in-flight release out before dialing", async () => {
    // close()'s pre-drain reconnect can fire while the poll loop's idle release is
    // still between the ssh2 Client's end() and its 'close'. In that window the
    // session still READS live, so a reconnect that does not wait reports success
    // without dialing -- and the release's 'close' then clears the session the
    // caller was just told it had.
    const { client, connect, state, rawClient } =
      slowClosingClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const release = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    const ready = adapter.ensureConnected();
    await Promise.all([release, ready]);

    await expect(ready).resolves.toBe(true);
    // The initial dial plus a real re-dial taken after the close: the caller is
    // handed a session that is actually live.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(state.live).toBe(true);
  });

  test("a recovery re-dial waits a concurrent dial out and re-issues on its session", async () => {
    // A partner-side drop tears a concurrent operation just as the cycle's own dial
    // re-establishes the session, so two re-establishment paths are live at once.
    // ssh2's Client.connect() on a still-writable socket ends the socket and
    // re-connects from its 'close', which kills the first handshake and rejects the
    // SECOND dial -- so a recovery that dialed alongside the cycle dial would fail
    // the very operation it exists to save. It waits that dial out, finds the
    // session it established, and re-issues on it rather than dialing at all.
    const wrapper = wrapperMethods();
    const state = { live: true };
    let failInFlight: ((error: unknown) => void) | undefined;
    let dialsInFlight = 0;
    let peakDialsInFlight = 0;
    let dials = 0;
    const connect = vi.fn().mockImplementation(async () => {
      dials += 1;
      dialsInFlight += 1;
      peakDialsInFlight = Math.max(peakDialsInFlight, dialsInFlight);
      try {
        // The initial dial completes at once; the re-establishment takes a real
        // handshake's worth of time, so a second dial opened while it runs -- the
        // recovery waking one microtask behind the cycle start -- is unmistakable.
        if (dials > 1) await new Promise((settle) => setTimeout(settle, 20));
        state.live = true;
      } finally {
        dialsInFlight -= 1;
      }
    });
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: { setKeepAlive: vi.fn(), writableEnded: false, destroy: vi.fn() },
      end: vi.fn(() => {
        state.live = false;
        setTimeout(() => rawClient.emit("close"), 0);
      }),
    });
    const tearFromServer = () => {
      state.live = false;
      failInFlight?.(notConnected("exists"));
      failInFlight = undefined;
    };
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
      exists: vi.fn(
        () =>
          new Promise<boolean>((resolve, reject) => {
            if (!state.live) {
              reject(notConnected("exists"));
              return;
            }
            const answer = setTimeout(() => resolve(true), 0);
            failInFlight = (error: unknown) => {
              clearTimeout(answer);
              reject(error);
            };
          }),
      ),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    // No reconnection budget at all, so a handshake lost to a concurrent dial is
    // terminal rather than quietly retried a second later.
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const torn = adapter.exists("/remote/out.json");
    // The partner drops the session with that operation on the wire, and the cycle
    // takes its own dial before the rejection has finished travelling: the recovery
    // wakes one microtask behind that dial.
    tearFromServer();
    const cycleDial = adapter.ensureConnected();

    await expect(cycleDial).resolves.toBe(true);
    await expect(torn).resolves.toBe(true);

    // One dial at a time, and only one re-establishment in total: the recovery
    // re-issued the torn operation on the session the cycle dial had established.
    expect(peakDialsInFlight).toBe(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  test("a cycle-start reconnect that was waiting when teardown began does not dial", async () => {
    // ensureConnected can be parked for a release's whole close bound or a dial's
    // whole budget, and close() can land in the middle of that wait, so the check
    // it made on entry is stale by the time it resumes. Dialing on the far side
    // would leave a session outliving the teardown, and reporting a live session
    // would hand the caller operations to issue on it.
    const { client, connect, rawClient } = slowClosingClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const release = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    const ready = adapter.ensureConnected();
    // The teardown begins while that reconnect is waiting the release out.
    const closed = adapter.end();
    await Promise.all([release, ready, closed]);

    await expect(ready).resolves.toBe(true);
    // The initial dial is the only one: no session was established past the
    // teardown.
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("teardown never runs the client down under a recovery re-dial", async () => {
    // The recovery of an operation a partner-side drop tore off the wire and the
    // teardown both queue behind the cycle's own dial, and the recovery queues
    // FIRST, so it reaches the front first -- with the teardown latch set behind
    // it. Dialing there is wrong twice over: a handshake runs against the
    // teardown's client.end() on the one shared Ssh2SftpClient, and
    // ssh2-sftp-client's own end() short-circuits on the cleared session, resolving
    // WITHOUT ending the ssh2 Client -- so close() returns while an SSH handshake
    // still holds a ref'd socket, and the CLI's clean close lingers for the dial's
    // budget.
    const wrapper = wrapperMethods();
    const state = { live: true };
    let failInFlight: ((error: unknown) => void) | undefined;
    let dialsInFlight = 0;
    let dials = 0;
    // Every session transition in the order it happened, each teardown carrying
    // the number of handshakes live at that instant -- the sequence is the
    // assertion, since a teardown recorded alongside a dial is the overlap.
    const events: string[] = [];
    const connect = vi.fn().mockImplementation(async () => {
      dials += 1;
      // The initial dial completes at once; a re-dial takes a real handshake's
      // worth of time, so a teardown that runs inside one is unmistakable.
      if (dials === 1) {
        state.live = true;
        return;
      }
      dialsInFlight += 1;
      events.push("dial:start");
      try {
        await new Promise((settle) => setTimeout(settle, 20));
        state.live = true;
      } finally {
        dialsInFlight -= 1;
        events.push("dial:end");
      }
    });
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: { setKeepAlive: vi.fn(), writableEnded: false, destroy: vi.fn() },
      end: vi.fn(() => {
        state.live = false;
        setTimeout(() => rawClient.emit("close"), 0);
      }),
    });
    const tearFromServer = () => {
      state.live = false;
      failInFlight?.(notConnected("exists"));
      failInFlight = undefined;
    };
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn(async () => {
        events.push(`teardown:client.end (dialsInFlight=${dialsInFlight})`);
        return true;
      }),
      realPath: vi.fn().mockResolvedValue("/"),
      exists: vi.fn(
        () =>
          new Promise<boolean>((resolve, reject) => {
            if (!state.live) {
              reject(notConnected("exists"));
              return;
            }
            const answer = setTimeout(() => resolve(true), 0);
            failInFlight = (error: unknown) => {
              clearTimeout(answer);
              reject(error);
            };
          }),
      ),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const torn = adapter.exists("/remote/out.json");
    // The partner drops the session with that operation on the wire, and the cycle
    // takes its own dial: the recovery parks on that dial.
    tearFromServer();
    const cycleDial = adapter.ensureConnected();
    // Let the torn operation's rejection travel its promise chain into the
    // recovery path, so the recovery is parked on the cycle dial before the
    // teardown parks behind it. Draining microtasks cannot advance that dial,
    // which settles on a macrotask, so it is still in flight here.
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    const closed = adapter.end();
    await Promise.allSettled([cycleDial, torn, closed]);

    // The cycle dial ran to completion, the recovery behind it dialed nothing, and
    // the teardown's client.end() ran with no handshake live.
    expect(events).toEqual([
      "dial:start",
      "dial:end",
      "teardown:client.end (dialsInFlight=0)",
    ]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  // --- session-transition behavior, read through observable outcomes ---------
  //
  // The cases below pin what the adapter DOES across a session transition --
  // which boundary is a deliberate release and which is a server-side drop, and
  // what a teardown may overlap -- through the reconnect counters, the operator
  // warning, and the seams the adapter drives. None of them reads the adapter's
  // internal bookkeeping, so each holds whatever machinery serializes the
  // transitions underneath.

  // The SSH_FX_NO_SUCH_FILE status ssh2-sftp-client surfaces as the raw numeric
  // SFTP code, which the delete and rename recovery resolvers read to tell a
  // pre-drop attempt that already LANDED from a genuine absence.
  const noSuchFile = (name: string) =>
    Object.assign(new Error(`${name}: No such file`), { code: 2 });

  // A client whose data-plane ops are outstanding for one macrotask -- the server
  // round trip a release can fall in the middle of -- and whose ssh2 Client end()
  // tears whichever is on the wire, exactly as ssh2-sftp-client's per-operation
  // listeners do. An op torn that way ALREADY LANDED on the server (the request
  // reached it; only the reply was lost), so its re-issue sees the post-op state:
  // the deleted source absent, the renamed source absent with the destination
  // present. That is the state the recovery resolvers exist to read.
  //
  // `schedule` is called in the same turn as the re-issue's own rejection, which
  // is the only place a test can hand work to the exact microtask queue that
  // rejection drains: the recovery arm's remaining hops are queued from there,
  // so a continuation queued alongside them interleaves with the arm rather than
  // landing before or after the whole of it.
  function landedOnTearClient(
    wrapper: ReturnType<typeof wrapperMethods>,
    schedule: () => void = () => {},
  ) {
    const state = { live: true, ending: false };
    const landed = new Set<string>();
    let failInFlight: ((error: unknown) => void) | undefined;
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    // destroy() needs nothing from the peer, and the ssh2 Client's 'close' that
    // follows is what fires ssh2-sftp-client's global listener to clear the
    // session. A stand-in that drove neither leaves a retirement of a session
    // still held over an ended transport failing for want of a mock.
    const socket = {
      setKeepAlive: vi.fn(),
      writableEnded: false,
      destroy: vi.fn(() => {
        state.live = false;
        rawClient.emit("close");
      }),
    };
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: socket,
      end: vi.fn(() => {
        state.ending = true;
        state.live = false;
        failInFlight?.(notConnected("operation"));
        failInFlight = undefined;
        setTimeout(() => {
          state.ending = false;
          rawClient.emit("close");
        }, 0);
      }),
    });
    const connect = vi.fn().mockImplementation(async () => {
      if (state.ending)
        throw new Error("getConnection: Unexpected close event");
      // ssh2 mints a fresh socket per dial, so neither half is ended on it.
      socket.writableEnded = false;
      state.live = true;
    });
    // One server round trip: it lands on the far side unless the transport is
    // already gone, and a tear rejects the caller AFTER the server applied it.
    const roundTrip = (name: string, path: string, apply: () => void) =>
      new Promise<void>((resolve, reject) => {
        if (!state.live) {
          reject(notConnected(name));
          return;
        }
        if (landed.has(path)) {
          // A server answers a re-issue with a round trip of its own, so the
          // rejection lands a macrotask later rather than inside this executor.
          setTimeout(() => {
            reject(noSuchFile(name));
            schedule();
          }, 0);
          return;
        }
        const answer = setTimeout(() => {
          apply();
          resolve();
        }, 0);
        failInFlight = (error: unknown) => {
          clearTimeout(answer);
          apply();
          reject(error);
        };
      });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
      delete: vi.fn((path: string) =>
        roundTrip("delete", path, () => landed.add(path)),
      ),
      rename: vi.fn((fromPath: string, toPath: string) =>
        roundTrip("rename", fromPath, () => {
          landed.add(fromPath);
          landed.add(toPath);
        }),
      ),
      exists: vi.fn(async (path: string) => {
        if (!state.live) throw notConnected("exists");
        return landed.has(path);
      }),
    };
    // The PARTNER dropping a session with an operation on the wire: it fails that
    // operation and clears the session exactly as the ssh2 'close' handler does,
    // with no end() of this side's. The tear the recovery resolvers are for, driven
    // by the only thing that still produces it.
    const dropFromServer = () => {
      state.live = false;
      failInFlight?.(notConnected("operation"));
      failInFlight = undefined;
      rawClient.emit("close");
    };
    // The same drop from a partner that withholds its CONNECTION close: only the
    // SFTP channel goes, so the operation -- which LANDED before the channel did --
    // is rejected over a transport ssh2 has ended while neither ssh2-sftp-client
    // listener that clears `sftp` has run. The session property therefore still
    // reads live, which is what leaves a release something to close.
    const tearChannelWithholdingClose = () => {
      socket.writableEnded = true;
      failInFlight?.(new Error("operation: channel is closed"));
      failInFlight = undefined;
    };
    return {
      client,
      connect,
      state,
      rawClient,
      socket,
      landed,
      dropFromServer,
      tearChannelWithholdingClose,
    };
  }

  // Replaces a client's delete with one the test settles by hand, so an operation
  // can be left OUTSTANDING across a transition. What the boundary precondition
  // reads is the wire, so every case below has to put something on it and leave it
  // there.
  function pendingDelete(client: object) {
    let resolveOperation!: () => void;
    let rejectOperation!: (error: unknown) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          resolveOperation = () => resolve();
          rejectOperation = reject;
        }),
    );
    return {
      settle: () => resolveOperation(),
      fail: (error: unknown) => rejectOperation(error),
    };
  }

  test("a delete torn off the wire by a server drop resolves through its recovery resolver", async () => {
    // The tear that survives the boundary precondition: the PARTNER drops the
    // session with the delete on the wire. The default held-session mode is where
    // this lands -- it runs no idle release at all -- and the resolver is what
    // carries it: re-dial, re-issue, and the now-absent source read as the landed
    // attempt it was. The drop is the server's, so it is counted and warned.
    const { client, connect, landed, dropFromServer } =
      landedOnTearClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    const removal = adapter.delete("/remote/out.json");
    dropFromServer();

    await expect(removal).resolves.toBeUndefined();
    expect(landed.has("/remote/out.json")).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("a rename torn off the wire by a server drop resolves through its recovery resolver", async () => {
    // The same tear on the publish that matters most: a temp-file rename to its
    // final name. The re-issue sees the source gone, confirms the self-prefixed
    // destination present, and reports the landed publish as the success it was.
    const { client, connect, landed, dropFromServer } =
      landedOnTearClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    const publish = adapter.rename(
      "/remote/temp-send.tmp",
      "/remote/id-0-12.json",
    );
    dropFromServer();

    await expect(publish).resolves.toBeUndefined();
    expect(landed.has("/remote/id-0-12.json")).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("a rename torn by a partner that withholds its connection close recovers on a transport the re-dial retires itself", async () => {
    // The same landed publish, torn by a partner that drops only the SFTP
    // channel: the session property is left set over a transport ssh2 has ended,
    // which the library's connect() will not dial past. Nothing else clears it
    // here -- no release runs -- so the re-dial's own retirement is what has to,
    // forcing the ended transport closed for the client 'close' that clears the
    // session, and the re-issue then reads the landed rename exactly as it does
    // after a drop that closed.
    const {
      client,
      connect,
      rawClient,
      socket,
      landed,
      tearChannelWithholdingClose,
    } = landedOnTearClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    const publish = adapter.rename(
      "/remote/temp-send.tmp",
      "/remote/id-0-12.json",
    );
    tearChannelWithholdingClose();

    await expect(publish).resolves.toBeUndefined();
    expect(landed.has("/remote/id-0-12.json")).toBe(true);
    // The forced close is the retirement's own: the ssh2 Client's end() is driven
    // by a release in this mock and by nothing else, and no release runs here.
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  // A client modeling what a partner-side drop does to a HIGH-LEVEL operation in
  // flight, which is a different sequence from the raw-wrapper tear above.
  // ssh2-sftp-client's per-operation listeners clear the session and reject the
  // operation from the ssh2 Client's 'end', a full event ahead of the 'close' the
  // transport still owes -- so recovery is entered with the session already gone
  // and a lifecycle event of the dead transport still to come. The library's own
  // connect-time listeners fail any dial that stale event reaches, which is what
  // `connect` refuses here, and the handshake such a dial started runs on unowned
  // at the server. The 'close' lands when this side destroys the socket: the state
  // under test is a transport that still owes it when recovery runs, so the mock
  // holds that state until the adapter acts on it.
  function tornOnEndClient(wrapper: ReturnType<typeof wrapperMethods>) {
    const state = { live: true, closeOwed: false };
    let failInFlight: ((error: unknown) => void) | undefined;
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    const socket = {
      setKeepAlive: vi.fn(),
      writableEnded: false,
      readableEnded: false,
      destroyed: false,
      destroy: vi.fn(() => {
        socket.destroyed = true;
        if (!state.closeOwed) return;
        state.closeOwed = false;
        rawClient.emit("close");
      }),
    };
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: socket,
      end: vi.fn(),
    });
    const connect = vi.fn().mockImplementation(async () => {
      if (state.closeOwed)
        throw new Error("getConnection: Unexpected close event");
      // ssh2 mints a fresh socket per dial, so neither half is ended on it.
      state.live = true;
      socket.writableEnded = false;
      socket.readableEnded = false;
      socket.destroyed = false;
    });
    // One server round trip, outstanding for a macrotask, which the drop tears.
    const roundTrip = <T>(name: string, value: T) =>
      new Promise<T>((resolve, reject) => {
        if (!state.live) {
          reject(notConnected(name));
          return;
        }
        const answer = setTimeout(() => resolve(value), 0);
        failInFlight = (error: unknown) => {
          clearTimeout(answer);
          reject(error);
        };
      });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
      get: vi.fn(() => roundTrip("get", Buffer.from("payload"))),
      put: vi.fn(() => roundTrip("put", "ok")),
      exists: vi.fn(() => roundTrip("exists", true)),
    };
    // The partner's clean cut, as the pinned library delivers it to a high-level
    // operation: the session property is cleared and the operation rejected from
    // the 'end', with the 'close' still owed.
    const dropFromServer = () => {
      state.live = false;
      state.closeOwed = true;
      socket.writableEnded = true;
      socket.readableEnded = true;
      failInFlight?.(notConnected("operation"));
      failInFlight = undefined;
      rawClient.emit("end");
    };
    return { client, connect, rawClient, socket, dropFromServer };
  }

  test.each([
    {
      op: "get" as const,
      run: (a: SSH2SFTPClientAdapter) => a.get("/r/x.json"),
    },
    {
      op: "put" as const,
      run: (a: SSH2SFTPClientAdapter) =>
        a.put(Buffer.from("payload"), "/r/x.json"),
    },
    {
      op: "exists" as const,
      run: (a: SSH2SFTPClientAdapter) => a.exists("/r/x.json"),
    },
  ])(
    "a $op torn in flight by a server drop recovers on ONE re-dial, with no dial issued into the owed close",
    async ({ run }) => {
      // The high-level ops reject on the 'end', so recovery runs while the dead
      // transport still owes its 'close'. Dialing there fails the dial and leaves
      // the session it opened abandoned at the server, and that session's own
      // later events fail the next dial in turn -- so the whole budget burns out
      // and the operation surfaces a connect error instead of its session loss.
      // The recovery retires the transport first, so the one dial it makes lands.
      const { client, connect, socket, dropFromServer } =
        tornOnEndClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter();
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 3 });

      const operation = run(adapter);
      dropFromServer();

      await expect(operation).resolves.not.toBeUndefined();
      // Exactly one re-dial: no attempt was spent on a dial the owed close would
      // have failed, so none left an abandoned session behind either.
      expect(connect).toHaveBeenCalledTimes(2);
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(adapter.reconnectCount).toBe(1);
      expect(adapter.midExchangeReconnectCount).toBe(1);
    },
  );

  test("warns and leaves the operation terminal when the owed close never lands", async () => {
    // The premise the retirement rests on -- that destroying the transport draws
    // the client 'close' -- is read back where it is driven, like its two siblings
    // on this path: a warning naming the checklist, no dial, and the operation's
    // own session loss rather than an error of the mechanism's making.
    vi.useFakeTimers();
    try {
      const { client, connect, socket, dropFromServer } =
        tornOnEndClient(wrapperMethods());
      socket.destroy = vi.fn(() => {
        socket.destroyed = true;
      });
      const warn = vi.fn();
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = {
        warn,
        info: vi.fn(),
        trace: vi.fn(),
        error: vi.fn(),
      };
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
      const failing = adapter.exists("/r/x.json").catch((e: unknown) => e);
      dropFromServer();
      // Past the retirement's own bound for a 'close' that never lands, and past
      // the whole dialing-retry budget besides, so the case settles on what the
      // recovery decided rather than on a wait still outstanding.
      await vi.advanceTimersByTimeAsync(10_000);

      const error = await failing;
      expect((error as { code?: unknown }).code).toBe("ERR_NOT_CONNECTED");
      expect(connect).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledOnce();
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain("did not close within");
      expect(message).toContain("Upgrading the SFTP Stack");
      expect(message).toContain("docs/spec/DEPENDENCY_PINS.md");
      // Nothing was recovered, and nothing is reported as recovered; the session
      // was lost all the same, which is what the counter reports.
      expect(adapter.midExchangeReconnectCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Takes the lifecycle watch's seam away from a Client, leaving the seams the
  // retirement DRIVES intact: EventEmitter's own once() is implemented in terms of
  // on(), so a hand-rolled substitute is what separates the reading's seam from the
  // forced close's rather than removing both at once.
  function withoutClientOn(rawClient: EventEmitter & Record<string, unknown>) {
    const attach = rawClient.on.bind(rawClient);
    const once = (
      event: string,
      listener: (...args: unknown[]) => void,
    ): EventEmitter => {
      const wrapped = (...args: unknown[]): void => {
        rawClient.removeListener(event, wrapped);
        listener(...args);
      };
      attach(event, wrapped);
      return rawClient;
    };
    Object.assign(rawClient, { once, on: undefined });
  }

  // The retirement's report that it had no lifecycle reading to take, picked out of
  // the warnings the recovery itself raises alongside it.
  function unreadableLifecycleWarnings(
    warn: ReturnType<typeof vi.fn>,
  ): string[] {
    return warn.mock.calls
      .map((call) => call[0] as string)
      .filter((message) => message.includes("client.on()"));
  }

  test("a Client whose on() has moved still recovers the torn operation, warning for the reading it lost", async () => {
    // The transport-lifecycle watch is best-effort, but its absence is "cannot
    // tell", never "nothing owed": with no reading to take, the re-dial retires the
    // transport rather than dialing into a window it cannot see -- so the torn
    // operation still recovers on ONE dial, and the lost reading is reported as the
    // seam failure it is instead of being spent silently on a failed dial.
    const { client, connect, rawClient, socket, dropFromServer } =
      tornOnEndClient(wrapperMethods());
    withoutClientOn(rawClient);
    const warn = vi.fn();
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      info: vi.fn(),
      trace: vi.fn(),
      error: vi.fn(),
    };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
    const operation = adapter.exists("/r/x.json");
    dropFromServer();

    await expect(operation).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(adapter.midExchangeReconnectCount).toBe(1);
    const lostReading = unreadableLifecycleWarnings(warn);
    expect(lostReading).toHaveLength(1);
    expect(lostReading[0]).toContain("Upgrading the SFTP Stack");
    expect(lostReading[0]).toContain("docs/spec/DEPENDENCY_PINS.md");
  });

  test("a Client whose on() has moved pays the forced close's bound where the drop had already run its whole sequence", async () => {
    // The cost of reading an absent lifecycle as "cannot tell": the neighbouring
    // class, whose 'close' has already landed, no longer takes the shortcut the
    // reading would have licensed. It closes a transport that had already closed
    // and rides the forced close's whole bound -- a 'close' listener armed after
    // the event never resolves early -- before dialing. The drop still recovers on
    // one dial; only the wait is added, and only here.
    vi.useFakeTimers();
    try {
      const { client, connect, rawClient, socket, dropFromServer } =
        tornOnEndClient(wrapperMethods());
      withoutClientOn(rawClient);
      const adapter = new SSH2SFTPClientAdapter();
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
      dropFromServer();
      // The partner's close arrives before anything else is issued, so nothing is
      // owed -- which is exactly what this Client cannot be asked.
      socket.destroy();
      socket.destroy.mockClear();

      const operation = adapter.exists("/r/x.json");
      // Everything that can settle without a timer expiring has settled.
      await vi.advanceTimersByTimeAsync(0);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(socket.destroy).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(operation).resolves.toBe(true);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(adapter.midExchangeReconnectCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a Client whose on() has moved warns once however many drops it recovers", async () => {
    // Whether the Client exposes on() is the installed version's property, not the
    // drop's, so the second recovery repeats the wait and not the warning.
    const { client, connect, rawClient, dropFromServer } =
      tornOnEndClient(wrapperMethods());
    withoutClientOn(rawClient);
    const warn = vi.fn();
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      info: vi.fn(),
      trace: vi.fn(),
      error: vi.fn(),
    };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 4 });
    const first = adapter.exists("/r/x.json");
    dropFromServer();
    await expect(first).resolves.toBe(true);
    const second = adapter.exists("/r/y.json");
    dropFromServer();
    await expect(second).resolves.toBe(true);

    expect(connect).toHaveBeenCalledTimes(3);
    expect(adapter.midExchangeReconnectCount).toBe(2);
    expect(unreadableLifecycleWarnings(warn)).toHaveLength(1);
  });

  test("a Client with no EventEmitter surface at all refuses the re-dial and leaves the operation its own loss", async () => {
    // The whole surface gone, which is what relocating it actually looks like: the
    // reading is unavailable AND so is the forced close the conservative branch
    // falls through to. Both are reported, no dial is spent on a window nothing can
    // see, and the operation fails with the session loss it already had rather than
    // with a connect error of the recovery's making.
    vi.useFakeTimers();
    try {
      const { client, connect, rawClient, socket, dropFromServer } =
        tornOnEndClient(wrapperMethods());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (rawClient as any).on = undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (rawClient as any).once = undefined;
      const warn = vi.fn();
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = {
        warn,
        info: vi.fn(),
        trace: vi.fn(),
        error: vi.fn(),
      };
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
      const failing = adapter.exists("/r/x.json").catch((e: unknown) => e);
      dropFromServer();
      // Past the retirement's own bound and the whole dialing-retry budget, so the
      // case settles on what the recovery decided rather than on a wait still
      // outstanding.
      await vi.advanceTimersByTimeAsync(10_000);

      const error = await failing;
      expect((error as { code?: unknown }).code).toBe("ERR_NOT_CONNECTED");
      expect(connect).toHaveBeenCalledTimes(1);
      expect(socket.destroy).not.toHaveBeenCalled();
      // The re-dial was refused, and the session was lost regardless.
      expect(adapter.midExchangeReconnectCount).toBe(1);
      const messages = warn.mock.calls.map((call) => call[0] as string);
      expect(unreadableLifecycleWarnings(warn)).toHaveLength(1);
      expect(messages).toHaveLength(2);
      expect(messages[1]).toContain("client.once()");
      for (const message of messages) {
        expect(message).toContain("Upgrading the SFTP Stack");
        expect(message).toContain("docs/spec/DEPENDENCY_PINS.md");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test("a drop that lands BEFORE the operation is issued still recovers on one re-dial", async () => {
    // The neighbouring class, kept apart from the in-flight tear above: the whole
    // lifecycle sequence has run by the time the operation is issued, so there is
    // nothing owed and the retirement drives nothing at all. The re-dial is the
    // one it has always been.
    const { client, connect, socket, dropFromServer } =
      tornOnEndClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
    dropFromServer();
    // The partner's close arrives before anything else is issued.
    socket.destroy();
    socket.destroy.mockClear();

    await expect(adapter.exists("/r/x.json")).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("the re-dial stops the keepalive, then retires the transport, then dials", async () => {
    // The order the whole recovery rests on, asserted as an order rather than as
    // three outcomes that a reordering would leave individually intact. Retiring
    // AFTER the dial would put the dial in the window the retirement exists to
    // clear, and it is the retirement's close that settles whatever else the drop
    // left on that transport, so an operation concurrent with this one would be
    // left for its own liveness deadline instead. Stopping the keepalive after
    // either would let the dropped session's still-armed timer post a realPath
    // onto a transport this is about to destroy, or onto a handshake in progress.
    const { client, connect, socket, dropFromServer } =
      tornOnEndClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
    // Spied after the first dial, so the arming that dial does is not what the
    // reading below picks up.
    const stopKeepalive = vi.spyOn(
      (adapter as unknown as { heartbeat: { stop: () => void } }).heartbeat,
      "stop",
    );
    connect.mockClear();

    const operation = adapter.exists("/r/x.json");
    dropFromServer();
    await expect(operation).resolves.toBe(true);

    // Vitest stamps every mock call with a run-wide sequence number, which is what
    // orders calls on three separate mocks against each other.
    const [stopped] = stopKeepalive.mock.invocationCallOrder;
    const [retired] = socket.destroy.mock.invocationCallOrder;
    const [dialed] = connect.mock.invocationCallOrder;
    expect(stopped).toBeLessThan(retired);
    expect(retired).toBeLessThan(dialed);
    expect(connect).toHaveBeenCalledOnce();
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("an idle boundary reached with an operation outstanding does not close the session, and the operation completes on the session it was issued against", async () => {
    // The one operation no entry gate can cover: it is already on the wire when
    // the idle boundary falls. The release reads that off the adapter's own
    // outstanding-operation count and keeps the session, so the delete answers on
    // the very session it was issued against -- no tear, no recovery round, and
    // nothing for the reconnect counters or the operator warning.
    const { client, connect, rawClient, state, landed } =
      landedOnTearClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    // No reconnection budget at all, so a re-dial charged to the exchange would
    // fail the operation outright rather than being quietly absorbed.
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const removal = adapter.delete("/remote/out.json");
    const release = adapter.releaseForIdle();
    // Read with no await between it and the call above: the release drove nothing.
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);

    await expect(release).resolves.toBeUndefined();
    await expect(removal).resolves.toBeUndefined();

    expect(landed.has("/remote/out.json")).toBe(true);
    // The initial dial and nothing more: the operation neither lost a session nor
    // recovered one.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("an idle boundary reached while a rename re-issue's probe is on the wire holds the session, and the landed rename resolves as landed", async () => {
    // The probe that confirms a landed pre-drop rename is a server round trip of
    // this adapter's own, counted at the same bracket as the rename it settles.
    // A boundary falling while it is outstanding therefore closes nothing: a
    // release that tore it would leave the probe unable to answer, and an
    // unanswered probe reports a rename that DID land as the failure that drove
    // it -- a publish lost to a session this side closed on purpose.
    const { client, connect, rawClient, state, landed, dropFromServer } =
      landedOnTearClient(wrapperMethods());
    const probe = pendingExists(client);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const publish = adapter.rename(
      "/remote/temp-send.tmp",
      "/remote/id-0-12.json",
    );
    // The partner drops the session with the rename on the wire: it landed on the
    // server, so the re-issue after the recovery re-dial sees the source gone and
    // fires the probe.
    dropFromServer();
    await probe.issued;

    // The recovery arm counts the unsettled rename for the whole of itself and the
    // probe's own bracket nests inside that span, so the same operation is counted
    // more than once while the probe is on the wire. Read the way the release's
    // precondition reads it -- non-zero, never a quantity -- so what pins the state
    // the release is entered against is that reading and not the nesting depth.
    expect(outstandingOperations(adapter)).toBeGreaterThan(0);
    const release = adapter.releaseForIdle();
    // Read with no await between it and the call above: the release drove nothing.
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);
    await expect(release).resolves.toBeUndefined();
    expect(adapter.heldBoundaryCount).toBe(1);
    expect(adapter.heldBoundaryStretchCount).toBe(1);

    // The server applied the rename before the tear, so the probe finds the
    // destination present and the publish is reported as the success it was.
    expect(landed.has("/remote/id-0-12.json")).toBe(true);
    probe.answer(true);
    await expect(publish).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  // Enter an idle release at the seam between the re-issued attempt's reply and
  // the destination probe it fires.
  //
  // Entered from the same turn as that reply -- the only place a test can hand
  // work to the exact microtask queue the rejection drains -- and called
  // synchronously there: an idle transition queue is entered in the calling tick,
  // so the boundary falls with the re-issue's rejection queued and its probe not
  // yet issued. There is deliberately no count for the device to watch for: the
  // operation is one span from issue to final settlement, so the count reads the
  // same at this seam as it does anywhere else in the arm, which is the property
  // the case is for.
  //
  // Reports whether it arrived: a device the mock never called would leave the
  // case asserting nothing, so the case asserts it arrived.
  function releaseAtTheReissueSeam(adapter: SSH2SFTPClientAdapter) {
    let reached = false;
    const schedule = (): void => {
      reached = true;
      void adapter.releaseForIdle();
    };
    return { schedule, reached: () => reached };
  }

  test("an idle boundary landing between the rename re-issue and its probe closes nothing, and the landed rename still resolves", async () => {
    // The seam the recovery arm's bracket exists for. The re-issue after the
    // re-dial sees the source gone -- the pre-drop rename LANDED -- and fires the
    // destination probe that says so. Its own bracket settles the count before the
    // probe's opens, and a release entering there would close the session the
    // probe has yet to answer on: the unanswered probe reads as "the rename did
    // not land", and a publish that reached the server fails terminally on the
    // SSH_FX_NO_SUCH_FILE that drove the probe. The arm holds the count across the
    // whole of itself, so the boundary is held rather than closed.
    const adapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
      stallDeadlineMs: 300,
    });
    const seam = releaseAtTheReissueSeam(adapter);
    const { client, connect, rawClient, state, landed, dropFromServer } =
      landedOnTearClient(wrapperMethods(), seam.schedule);
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const publish = adapter.rename(
      "/remote/temp-send.tmp",
      "/remote/id-0-12.json",
    );
    dropFromServer();

    await expect(publish).resolves.toBeUndefined();
    expect(seam.reached()).toBe(true);
    expect(landed.has("/remote/id-0-12.json")).toBe(true);
    // The release closed nothing: the only thing that drives the ssh2 Client's
    // end() in this mock is the release itself.
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);
    // One re-dial for the drop, and none for a session a boundary took away.
    expect(connect).toHaveBeenCalledTimes(2);
    // The boundary the arm held is accounted exactly as a boundary held for an
    // ordinary operation is.
    expect(adapter.heldBoundaryCount).toBe(1);
    expect(adapter.heldBoundaryStretchCount).toBe(1);
  });

  test("an idle boundary landing between the recovery re-dial and the re-issue closes nothing, and the landed rename still resolves", async () => {
    // The other span the arm's bracket covers. The re-dial has established the
    // replacement session and the re-issue has not run on it yet; a release
    // entering there would close the very session just dialed, and the re-issue
    // would then reject with a dead-session error no recovery resolver reads at
    // all -- so a rename that DID land surfaces as a failed publish, the same
    // outcome as at the probe seam and by a different route.
    const adapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
      stallDeadlineMs: 300,
    });
    const { client, connect, rawClient, state, landed, dropFromServer } =
      landedOnTearClient(wrapperMethods());
    // Entered from inside the recovery re-dial, then advanced one microtask at a
    // time until that re-dial has left the transition queue: the release is
    // requested with the queue free, so it enters in the calling tick rather than
    // taking a slot behind the re-dial and landing past the re-issue. Requesting
    // it from inside the re-dial instead lands there every time, and measures
    // nothing -- the re-issue's own bracket holds the boundary by then whether or
    // not the arm keeps a span.
    let dials = 0;
    const boundary = { attemptsAtEntry: -1, entered: false };
    const dial = connect.getMockImplementation()!;
    connect.mockImplementation(async () => {
      dials += 1;
      await dial();
      if (dials !== 2) return;
      void (async () => {
        while (pendingSessionTransitions(adapter) > 0) await Promise.resolve();
        boundary.attemptsAtEntry = (
          client.rename as ReturnType<typeof vi.fn>
        ).mock.calls.length;
        const held = adapter.heldBoundaryCount;
        void adapter.releaseForIdle();
        boundary.entered = adapter.heldBoundaryCount !== held;
      })();
    });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const publish = adapter.rename(
      "/remote/temp-send.tmp",
      "/remote/id-0-12.json",
    );
    dropFromServer();

    await expect(publish).resolves.toBeUndefined();
    // The boundary landed in the window and nowhere else: it was entered in its
    // caller's own tick, with the first attempt the only rename issued so far. A
    // boundary that fell past the re-issue would be held by the re-issue's own
    // bracket and would measure nothing about the arm's span.
    expect(boundary.entered).toBe(true);
    expect(boundary.attemptsAtEntry).toBe(1);
    expect(landed.has("/remote/id-0-12.json")).toBe(true);
    // The release closed nothing: the only thing that drives the ssh2 Client's
    // end() in this mock is the release itself.
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);
    // One re-dial for the drop, and none for a session a boundary took away.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.heldBoundaryCount).toBe(1);
    expect(adapter.heldBoundaryStretchCount).toBe(1);
  });

  test("a landed rename torn mid-publish resolves with every boundary across its arm held", async () => {
    // The publish this span exists for. A rename that DID land is torn before its
    // reply arrives, and what tells the adapter it landed is the re-issue's own
    // error plus the destination probe behind it -- both inside the arm. A
    // boundary closing anywhere across that arm would close the session the
    // re-issue and the probe run on, and the landed publish would surface as a
    // failure. Swept across the arm rather than placed at one point: the span
    // covers the whole of it, so every depth reads the operation counted and is
    // held.
    const depths = 40;
    for (let depth = 0; depth < depths; depth += 1) {
      const {
        client,
        connect,
        rawClient,
        state,
        landed,
        tearChannelWithholdingClose,
      } = landedOnTearClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({
        ephemeralSessions: true,
        stallDeadlineMs: 300,
      });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      const publish = adapter.rename(
        "/remote/temp-send.tmp",
        "/remote/id-0-12.json",
      );
      // The partner drops the SFTP channel while withholding its connection close,
      // which is what would leave a release a session to close at all: a drop that
      // had already cleared the session would leave it nothing to do, so this is
      // the shape that can actually take a session away mid-arm.
      tearChannelWithholdingClose();
      for (let tick = 0; tick < depth; tick += 1) await Promise.resolve();
      const release = adapter.releaseForIdle();

      await expect(publish, `depth ${depth}`).resolves.toBeUndefined();
      await expect(release, `depth ${depth}`).resolves.toBeUndefined();
      expect(landed.has("/remote/id-0-12.json"), `depth ${depth}`).toBe(true);
      // Nothing closed: the boundary was held for the operation still in its arm.
      expect(rawClient.end, `depth ${depth}`).not.toHaveBeenCalled();
      expect(adapter.heldBoundaryCount, `depth ${depth}`).toBe(1);
      // The arm's own re-dial is the only one, and it left a live session behind.
      expect(connect, `depth ${depth}`).toHaveBeenCalledTimes(2);
      expect(state.live, `depth ${depth}`).toBe(true);
    }
  });

  test("the boundary held for the rename probe is bounded by the probe's own deadline, and the next boundary releases", async () => {
    // The composition the two halves above only prove in pieces: one boundary
    // falls while the probe is on the wire and is held, and what ends that hold
    // is the probe's per-operation deadline and nothing weaker. The count returns
    // to zero with the stat still outstanding at the server, and the next
    // boundary closes as an undisturbed one does -- so counting the probe buys
    // the hold no bound the rest of the bracket does not already carry.
    const { client, rawClient, state, dropFromServer } =
      landedOnTearClient(wrapperMethods());
    const probe = pendingExists(client);
    const adapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
      stallDeadlineMs: 200,
    });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const publish = adapter.rename(
      "/remote/temp-send.tmp",
      "/remote/id-0-12.json",
    );
    dropFromServer();
    await probe.issued;

    // The arm's span around the unsettled rename, with the probe's own bracket
    // nested inside it (see the case above), read as the non-zero the release's
    // precondition reads. What this case measures is the DROP to zero below, which
    // the nesting depth is no part of.
    expect(outstandingOperations(adapter)).toBeGreaterThan(0);
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);

    // The probe is never answered: its deadline is what settles it, and the
    // ORIGINAL rename error is what the rejection carries rather than the probe's
    // own stall.
    const err = await publish.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportPublishIndeterminateError);
    expect(sanitizeErrorForDisplay(err)).toContain("No such file");
    expect(probe.exists).toHaveBeenCalledOnce();
    expect(outstandingOperations(adapter)).toBe(0);

    const released = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    await expect(released).resolves.toBeUndefined();
    expect(state.live).toBe(false);
  });

  test("an operation outstanding at the boundary never reaches the stall-deadline or the session-still-live terminal reading", async () => {
    // The publish that matters most -- a temp-file rename to its final name --
    // outstanding when the boundary falls. Held rather than torn, it reaches the
    // recovery path not at all, so neither of that path's terminal readings is on
    // its account: no re-dial is issued for it, and it does not reject.
    const { client, connect, rawClient, landed } =
      landedOnTearClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const publish = adapter.rename(
      "/remote/temp-send.tmp",
      "/remote/id-0-12.json",
    );
    const release = adapter.releaseForIdle();
    expect(rawClient.end).not.toHaveBeenCalled();

    await expect(release).resolves.toBeUndefined();
    await expect(publish).resolves.toBeUndefined();

    expect(landed.has("/remote/id-0-12.json")).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("an operation issued while the release was still QUEUED behind another transition is likewise not torn", async () => {
    // Both of the entry gate's readings are written from INSIDE the release's own
    // transition, so an operation issued while that release is still queued reads
    // neither and goes straight onto the session that is still live. It is on the
    // wire by the time the release enters, and the precondition is read there --
    // after the acquire -- which is what covers this class for free.
    const { client, connect, rawClient, state } =
      ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(client);

    // A dial parked on the queue, so the release below takes a real queue slot
    // behind it rather than entering in the same tick.
    let finishDial!: () => void;
    connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDial = () => resolve();
        }),
    );
    const dial = adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const release = adapter.releaseForIdle();
    // Issued AFTER the release was requested, and reaching the transport in the
    // same tick: the gate deferred nothing, because neither of its readings is
    // written until that release enters.
    const removal = adapter.delete("/remote/out.json");
    expect(client.delete).toHaveBeenCalledOnce();

    finishDial();
    await dial;
    await expect(release).resolves.toBeUndefined();
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);

    operation.settle();
    await expect(removal).resolves.toBeUndefined();
  });

  test("the release happens at the next boundary once that operation has settled", async () => {
    // The hold costs the mode one idle gap and no more: it is not a latch, just a
    // reading of the wire, so the boundary after the operation settles ends the
    // session exactly as an undisturbed one does.
    const { client, rawClient, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(client);

    const removal = adapter.delete("/remote/out.json");
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
    expect(rawClient.end).not.toHaveBeenCalled();

    operation.settle();
    await expect(removal).resolves.toBeUndefined();

    const released = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    await expect(released).resolves.toBeUndefined();
    expect(state.live).toBe(false);
  });

  test("an idle boundary with nothing outstanding still releases as today, synchronously with the call", async () => {
    // The precondition buys the ordinary path nothing to pay: a cycle whose
    // operations have settled leaves the wire empty, and the boundary has still
    // driven the ssh2 Client's end() by the time releaseForIdle() returns to its
    // caller -- no await was introduced ahead of the transition body.
    const { client, rawClient, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await expect(adapter.delete("/remote/out.json")).resolves.toBeUndefined();

    const released = adapter.releaseForIdle();
    // Read with no await between it and the call above.
    expect(rawClient.end).toHaveBeenCalledOnce();
    await expect(released).resolves.toBeUndefined();
    expect(state.live).toBe(false);
  });

  test("a teardown with an operation outstanding does NOT wait for it to drain", async () => {
    // The precondition is the release's alone. A teardown that waited for the wire
    // to clear would park the close behind an operation whose own ceiling is the
    // exchange's, and would be waiting on the very operation the close ends.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(client);

    const removal = adapter.delete("/remote/out.json");
    await expect(adapter.end()).resolves.toBeUndefined();
    expect(client.end).toHaveBeenCalledOnce();
    expect(rawClient.end).not.toHaveBeenCalled();

    operation.settle();
    await expect(removal).resolves.toBeUndefined();
  });

  test("a recovery re-dial with an operation outstanding does NOT wait for it to drain", async () => {
    // A re-dial that held for the wire would park behind the very class of
    // operation that drove it: the concurrent send whose own loss is being
    // recovered from is exactly what would be outstanding.
    const { client, connect, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(client);
    const removal = adapter.delete("/remote/out.json");

    // The session drops under a second operation, which recovers through the
    // re-dial while the first is still on the wire.
    state.live = false;
    await expect(adapter.exists("/remote/in.json")).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);

    operation.settle();
    await expect(removal).resolves.toBeUndefined();
  });

  test("a rejecting operation balances the count as well as a resolving one", async () => {
    // A failure that left the count up would pin the session open for the rest of
    // the exchange: every later boundary would read an operation on a wire that had
    // been empty since. The boundary this one straddles is held, and the boundary
    // after it rejects is not.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(client);

    const removal = adapter.delete("/remote/out.json");
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
    expect(rawClient.end).not.toHaveBeenCalled();

    operation.fail(new Error("the server refused the delete"));
    await expect(removal).rejects.toThrow("the server refused the delete");

    const released = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    await expect(released).resolves.toBeUndefined();
  });

  test("a held boundary counts as held, not as declined or forced", async () => {
    // The declined count states a cause -- another session transition that did not
    // complete within the release's wait -- which is false of a hold, and the
    // end-of-run line it feeds would report an anomaly where a concurrent send
    // straddling a boundary is ordinary. Nor is a held boundary a closed one, so the
    // forced-release total stays where it is too. The hold has an end-of-run total
    // of its own, which is where these boundaries land instead.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(client);

    const removal = adapter.delete("/remote/out.json");
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();

    expect(rawClient.end).not.toHaveBeenCalled();
    expect(adapter.declinedReleaseCount).toBe(0);
    expect(adapter.forcedReleaseCount).toBe(0);
    // Nor a boundary the partner closed on request: a hold closed nothing at all.
    expect(adapter.releasedBoundaryCount).toBe(0);
    expect(adapter.heldBoundaryCount).toBe(2);
    expect(adapter.heldBoundaryStretchCount).toBe(1);
    // Accounted, never warned: the operator hears about the run's total at the end
    // and about no single occurrence.
    expect(adapterLog(adapter).warn).not.toHaveBeenCalled();

    operation.settle();
    await expect(removal).resolves.toBeUndefined();
  });

  test("one unsettled operation across several boundaries counts each boundary and one stretch", async () => {
    // The case the total exists for: an operation with no bound of its own holds
    // every remaining boundary, so the mode's per-cycle session lifetime has lapsed
    // for the rest of the run. Five boundaries lost, one uninterrupted hold -- and
    // it is the stretch count that says the mode stopped rather than merely paying
    // for five straddling sends.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(client);
    const removal = adapter.delete("/remote/out.json");

    for (let boundary = 0; boundary < 5; boundary += 1)
      await expect(adapter.releaseForIdle()).resolves.toBeUndefined();

    expect(rawClient.end).not.toHaveBeenCalled();
    expect(adapter.heldBoundaryCount).toBe(5);
    expect(adapter.heldBoundaryStretchCount).toBe(1);

    operation.settle();
    await expect(removal).resolves.toBeUndefined();
  });

  test("operations settling between boundaries count one stretch each", async () => {
    // The ordinary case, which must not read like the one above: a send straddling
    // a boundary costs one idle gap and then lets the wire empty, so the next hold
    // is a fresh stretch. Three sends, three boundaries, three stretches -- the mode
    // is working and the counts say so.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const operation = pendingDelete(client);
      const removal = adapter.delete(`/remote/out-${cycle}.json`);
      await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
      operation.settle();
      await expect(removal).resolves.toBeUndefined();
    }

    expect(rawClient.end).not.toHaveBeenCalled();
    expect(adapter.heldBoundaryCount).toBe(3);
    expect(adapter.heldBoundaryStretchCount).toBe(3);
  });

  test("both held counts stay at zero on a run that holds no boundary, in either mode", async () => {
    // The guard the end-of-run line rests on: a clean run of the mode prints
    // nothing, and the default held-session mode -- which runs no idle release at
    // all -- prints nothing either.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await expect(adapter.delete("/remote/out.json")).resolves.toBeUndefined();
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();

    expect(rawClient.end).toHaveBeenCalledOnce();
    expect(adapter.heldBoundaryCount).toBe(0);
    expect(adapter.heldBoundaryStretchCount).toBe(0);

    const held = ephemeralClient(wrapperMethods());
    const persistent = new SSH2SFTPClientAdapter();
    stub(persistent);
    install(persistent, held.client);

    await persistent.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(held.client);
    const removal = persistent.delete("/remote/out.json");
    // No release runs in the default mode, so the outstanding operation reaches no
    // boundary to hold.
    await expect(persistent.releaseForIdle()).resolves.toBeUndefined();

    expect(persistent.heldBoundaryCount).toBe(0);
    expect(persistent.heldBoundaryStretchCount).toBe(0);

    operation.settle();
    await expect(removal).resolves.toBeUndefined();
  });

  // The precondition's own reading: operations issued and not yet settled. Private
  // state with no public surface, and the three tests below are about the reading
  // itself -- what it counts, and what it therefore leaves unbounded -- so they
  // assert it directly alongside the behavior it produces. The recovery-window
  // cases above read it for a second purpose: an idle transition queue is entered
  // in the calling tick, so a release called at a chosen reading of this is a
  // release ENTERED at that reading, which is the only way to put a boundary at a
  // named point inside the recovery arm.
  const outstandingOperations = (adapter: SSH2SFTPClientAdapter) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((adapter as any).ledger as SftpAdapterLedger).outstandingOperations;

  // Transitions holding or waiting on the session lock. Read only to place a
  // boundary: a recovery re-dial that has left this count is one whose session is
  // established and whose queue is free, which is the near edge of the window
  // between that re-dial and the re-issue it was for.
  const pendingSessionTransitions = (adapter: SSH2SFTPClientAdapter) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).pendingTransitions as number;

  test("an operation the adapter never settles holds every later boundary", async () => {
    // The stated limit of the hold, not a desired behavior. The reading is of
    // operations ISSUED and unsettled, and nothing on this side settles an
    // operation the server never answers -- core's whole-exchange budget races and
    // abandons rather than cancelling -- so the hold lasts as long as the operation
    // does. A put from a string source is the shape with no adapter-side deadline
    // at all (no flat bound, no idle window), so its hold has no end short of the
    // exchange's.
    const { client, rawClient, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).put = vi.fn(() => new Promise<string>(() => {}));

    void adapter.put("/local/out.bin", "/remote/out.bin");
    expect(outstandingOperations(adapter)).toBe(1);

    for (let boundary = 0; boundary < 3; boundary += 1)
      await expect(adapter.releaseForIdle()).resolves.toBeUndefined();

    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);
    expect(outstandingOperations(adapter)).toBe(1);
  });

  test("a trickling upload holds every later boundary too: its progress window is re-armed, never tripped", async () => {
    // The other shape carrying no bound the hold can rely on: an operation whose
    // deadline is a progress-reset window (the chunked put's idle window here, the
    // capped get's sink likewise). A server acknowledging a chunk at a time re-arms
    // that window instead of tripping it, so the upload stays unsettled and every
    // boundary it spans is held.
    const { client, rawClient, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
      stallDeadlineMs: 50,
    });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // One chunk acknowledged every 10 ms -- well inside the window -- against a
    // payload of 64 chunks, so the transfer is still trickling at the boundaries
    // below and the put itself is never answered.
    let chunksAcknowledged = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).put = vi.fn((source: Readable) => {
      source.pipe(
        new Writable({
          write(_chunk, _encoding, done) {
            chunksAcknowledged += 1;
            setTimeout(done, 10).unref();
          },
        }),
      );
      return new Promise<string>(() => {});
    });

    // The transfer is deliberately left unfinished, so its window trips whenever
    // the trickle stops after this test; swallow that so it cannot surface as an
    // unhandled rejection.
    void adapter
      .put(Buffer.alloc(64 * SFTP_PUT_PROGRESS_CHUNK_BYTES), "/remote/out.bin")
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(chunksAcknowledged).toBeGreaterThan(4);

    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();

    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);
    expect(outstandingOperations(adapter)).toBe(1);
  });

  test("an expired per-operation deadline settles the count while the request is still outstanding, and the next boundary closes over it", async () => {
    // The direction the count departs from the wire the other way. Every adapter
    // bound is a race that abandons rather than a cancellation, so an expired one
    // settles the operation on this side with the library request still outstanding
    // at the server. What the precondition holds a boundary for is an UNSETTLED
    // operation, which this one no longer is.
    const { client, rawClient, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
      stallDeadlineMs: 50,
    });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    let libraryRequestSettled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).exists = vi.fn(() =>
      new Promise<boolean>(() => {}).finally(() => {
        libraryRequestSettled = true;
      }),
    );

    const probe = adapter.exists("/remote/in.json");
    expect(outstandingOperations(adapter)).toBe(1);
    await expect(probe).rejects.toBeInstanceOf(TransportOperationStalledError);
    expect(outstandingOperations(adapter)).toBe(0);
    expect(libraryRequestSettled).toBe(false);

    const released = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    await expect(released).resolves.toBeUndefined();
    expect(state.live).toBe(false);
  });

  test("a release whose ssh2 end() throws leaves the next drop counted and warned", async () => {
    // The release drove nothing: its end() raised before the transport was
    // touched, so the session it failed to close is still the server's to drop.
    // A boundary that classified itself as deliberate anyway would hand that
    // drop the release's exemption and the operator would never hear about it.
    const { client, connect, state, rawClient } =
      ephemeralClient(wrapperMethods());
    rawClient.end = vi.fn(() => {
      throw new Error("socket already destroyed");
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await expect(adapter.releaseForIdle()).rejects.toThrow(
      "socket already destroyed",
    );
    expect(state.live).toBe(true);

    // The server drops the session the release could not close.
    state.live = false;
    await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped mid-exchange"),
    );
  });

  test("a forced release that cannot clear the session leaves the next drop counted and warned", async () => {
    // The partner withheld its close, the release destroyed the transport itself,
    // and the session STILL did not clear -- so the release ends having released
    // nothing it can vouch for. The drop that follows is the server's, and is
    // counted and warned as one.
    vi.useFakeTimers();
    try {
      const { client, connect, state, sock } =
        withheldCloseClient(wrapperMethods());
      // A destroy that tears the socket down without the ssh2 Client 'close' that
      // clears the session: the premise the release reads back and raises on.
      sock.destroy = vi.fn();
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      // The rejection handler is attached before the clock advances, so the
      // release's failure is never momentarily unhandled.
      const release = expect(adapter.releaseForIdle()).rejects.toThrow(
        "did not clear",
      );
      await vi.advanceTimersByTimeAsync(6_000);
      await release;
      expect(state.live).toBe(true);

      // The server drops the session the release could not clear.
      state.live = false;
      await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

      expect(connect).toHaveBeenCalledTimes(2);
      expect(adapter.reconnectCount).toBe(1);
      expect(adapter.midExchangeReconnectCount).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("dropped mid-exchange"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("a dial that raises over the session it established drops the boundary", async () => {
    // The cycle-start dial establishes its session and then raises in its own
    // post-connect verification, so it never reaches the discharge at the end of
    // that dial -- and the mode reports the raise as a cycle to skip rather than a
    // failure, leaving the run over a LIVE session with the previous release's
    // boundary behind it. That boundary may not stand there: the session is the
    // server's to drop, and a drop it exempted would reach neither the reconnect
    // counters nor the operator.
    const { client, state, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    expect(releaseBoundaryStands(adapter)).toBe(true);

    // The seam the release is verified against is gone by the next dial, which
    // checks it after the handshake has established the session.
    delete (rawClient._sock as Record<string, unknown>).writableEnded;
    await expect(adapter.ensureConnected()).resolves.toBe(false);
    expect(state.live).toBe(true);
    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);

    // The release that follows drives nothing either: the same absent seam refuses
    // it before it reaches the transport, so it too ends nothing.
    await expect(adapter.releaseForIdle()).rejects.toThrow(
      "client._sock.writableEnded",
    );
    expect(state.live).toBe(true);

    // The absent seam is not what is under test past this point: put it back so the
    // drop below has a re-dial to recover on.
    (rawClient._sock as Record<string, unknown>).writableEnded = false;
    state.live = false;
    await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped mid-exchange"),
    );
  });

  test("a release that ends nothing exempts no drop, whatever it entered with", async () => {
    // The rule is over the state rather than the transition: the boundary stands
    // only where no session does. A release entering with one already standing is
    // what that rule makes unreachable, so it is set here directly -- what this
    // pins is that a release which ended nothing cannot hand the reading on,
    // however it came to be standing.
    const { client, state, rawClient } = ephemeralClient(wrapperMethods());
    rawClient.end = vi.fn(() => {
      throw new Error("socket already destroyed");
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).sessionBoundary = "deliberatelyReleased";

    await expect(adapter.releaseForIdle()).rejects.toThrow(
      "socket already destroyed",
    );
    expect(state.live).toBe(true);
    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);

    // The server drops the session the release could not close.
    state.live = false;
    await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped mid-exchange"),
    );
  });

  test("teardown never runs the client down under a cycle-start dial", async () => {
    // The mirror of the recovery case above, on the dial the poll loop itself
    // starts. close() can reach end() while a cycle-start handshake is still
    // running on the one shared Ssh2SftpClient: ssh2-sftp-client's own end() would
    // short-circuit on the session that handshake has not restored yet, resolving
    // WITHOUT ending the ssh2 Client -- so close() would return while an SSH dial
    // still holds a ref'd socket.
    const wrapper = wrapperMethods();
    const state = { live: true };
    let dialReached!: () => void;
    const dialing = new Promise<void>((resolve) => {
      dialReached = resolve;
    });
    let dialsInFlight = 0;
    let dials = 0;
    const events: string[] = [];
    const connect = vi.fn().mockImplementation(async () => {
      dials += 1;
      if (dials === 1) {
        state.live = true;
        return;
      }
      dialsInFlight += 1;
      events.push("dial:start");
      try {
        dialReached();
        await new Promise((settle) => setTimeout(settle, 20));
        state.live = true;
      } finally {
        dialsInFlight -= 1;
        events.push("dial:end");
      }
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn(async () => {
        events.push(`teardown:client.end (dialsInFlight=${dialsInFlight})`);
        return true;
      }),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // The previous cycle released; this cycle's dial is in flight.
    state.live = false;
    const ready = adapter.ensureConnected();
    await dialing;
    const closed = adapter.end();
    await Promise.all([ready, closed]);

    expect(events).not.toContainEqual(
      expect.stringMatching(/^teardown:.*dialsInFlight=[1-9]/),
    );
    expect(events).toEqual([
      "dial:start",
      "dial:end",
      "teardown:client.end (dialsInFlight=0)",
    ]);
  });

  // --- the session-transition lock ------------------------------------------
  //
  // Every point at which the adapter dials a session or closes one runs under one
  // FIFO lock. These cases exercise the lock itself: the order transitions run
  // in, that none overlaps another, that teardown takes the queue like the rest,
  // and that a failing transition frees it.

  // Records each transition's body entering and leaving, through the adapter's own
  // acquire. Built test-side so the adapter carries no log of its own; an exact
  // start/end sequence is what proves both the order and the non-overlap.
  function recordTransitions(adapter: SSH2SFTPClientAdapter): string[] {
    const log: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = adapter as any;
    const acquire = internals.runTransition.bind(adapter);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    internals.runTransition = (transition: any) =>
      acquire({
        ...transition,
        run: async (recordBoundary: unknown) => {
          log.push(`start:${transition.kind}`);
          try {
            return await transition.run(recordBoundary);
          } finally {
            log.push(`end:${transition.kind}`);
          }
        },
      });
    return log;
  }

  test("all four non-teardown transitions started at once run one at a time in request order", async () => {
    // Teardown is not a fifth participant here by construction: it latches before
    // it enqueues, so anything already queued behind it is skipped rather than run
    // (the two cases below). These four can coexist, and each must have the client
    // to itself -- ssh2-sftp-client shares connection-level listeners, so two
    // handshakes, or a handshake and a close, at once is unsafe.
    const { client, connect, state, rawClient } =
      ephemeralClient(wrapperMethods());
    // A handshake that takes a real macrotask, so an overlap would be recorded
    // rather than merely possible.
    connect.mockImplementation(async () => {
      await new Promise((settle) => setTimeout(settle, 5));
      state.live = true;
      const dialed = rawClient._sock as { writableEnded?: boolean } | undefined;
      if (dialed?.writableEnded !== undefined) dialed.writableEnded = false;
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);
    const log = recordTransitions(adapter);

    // Fired in one synchronous run, with no await between them: the first dial,
    // an idle release, a cycle-start reconnect, and a recovery re-dial. The
    // public connect takes its queue slot synchronously, so the three behind it
    // queue rather than racing it.
    const dial = adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const release = adapter.releaseForIdle();
    const ready = adapter.ensureConnected();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redial = (adapter as any).redialForRecovery() as Promise<void>;
    await Promise.all([dial, release, ready, redial]);

    expect(log).toEqual([
      "start:connect",
      "end:connect",
      "start:releaseForIdle",
      "end:releaseForIdle",
      "start:ensureConnected",
      "end:ensureConnected",
      "start:redialForRecovery",
      "end:redialForRecovery",
    ]);
    // The release closed what the first dial established and the cycle-start
    // reconnect dialed a fresh session; the recovery re-dial found that session
    // live and dialed nothing.
    expect(rawClient.end).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(state.live).toBe(true);
  });

  test("a transition attempted after teardown is latched does not run", async () => {
    const { client, connect, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.end();
    const log = recordTransitions(adapter);

    // Every kind that can be requested after the latch, each returning what its
    // caller reads as "nothing to do" -- except a re-open, which is refused.
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).redialForRecovery() as Promise<string>,
    ).resolves.toBe("noSession");
    await expect(adapter.connect({ host: "h" })).rejects.toThrow(
      "cannot be reopened",
    );

    // None of them ran a body at all: no dial, and no second close.
    expect(log).toEqual([]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
  });

  test("a transition already in flight when teardown is latched is awaited by teardown before it returns", async () => {
    // The release is between the ssh2 Client's end() and its 'close' when close()
    // reaches end(). Teardown holds no privileged entry: it takes the queue behind
    // the release and runs ssh2-sftp-client's end() only once that release is done.
    const { client, rawClient } = slowClosingClient(wrapperMethods());
    const events: string[] = [];
    rawClient.on("close", () => events.push("release:closed"));
    const drivenEnd = rawClient.end as () => void;
    rawClient.end = vi.fn(() => {
      events.push("release:ssh2-end");
      drivenEnd();
    });
    client.end = vi.fn(async () => {
      events.push("teardown:client.end");
      return true;
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const release = adapter.releaseForIdle();
    const closed = adapter.end();
    await Promise.all([release, closed]);

    expect(events).toEqual([
      "release:ssh2-end",
      "release:closed",
      "teardown:client.end",
    ]);
  });

  test("the first dial acquires, so teardown cannot run the client down under it", async () => {
    // core's open() dials and its close() tears down; nothing above the adapter
    // orders them. A teardown that ran ssh2-sftp-client's end() under a live
    // handshake would short-circuit on the session that handshake has not
    // established yet, resolving WITHOUT ending the ssh2 Client -- so close()
    // would return while an SSH dial still holds a ref'd socket.
    const wrapper = wrapperMethods();
    const state = { live: false };
    const events: string[] = [];
    let dialsInFlight = 0;
    const connect = vi.fn().mockImplementation(async () => {
      dialsInFlight += 1;
      events.push("dial:start");
      try {
        await new Promise((settle) => setTimeout(settle, 20));
        state.live = true;
      } finally {
        dialsInFlight -= 1;
        events.push("dial:end");
      }
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn(async () => {
        events.push(`teardown:client.end (dialsInFlight=${dialsInFlight})`);
        return true;
      }),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    const dial = adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const closed = adapter.end();
    await Promise.all([dial, closed]);

    expect(events).toEqual([
      "dial:start",
      "dial:end",
      "teardown:client.end (dialsInFlight=0)",
    ]);
  });

  test("a transition that rejects releases the serialization rather than pinning every later one", async () => {
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    rawClient.end = vi.fn(() => {
      throw new Error("socket already destroyed");
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    // Two transitions queued behind a release that raises out of its body. The
    // rejection handler is attached in the same synchronous run, so the failure is
    // never momentarily unhandled.
    const failing = adapter.releaseForIdle();
    const rejected = expect(failing).rejects.toThrow(
      "socket already destroyed",
    );
    const queued = Promise.allSettled([
      adapter.ensureConnected(),
      adapter.releaseForIdle(),
    ]);
    await rejected;

    // Both reached the front and ran: the reconnect found the session the failed
    // release never closed, and the second release raised out of the same end().
    const outcome = await Promise.race([
      queued.then((results) => results.map((result) => result.status).join()),
      new Promise((resolve) => setTimeout(() => resolve("pinned"), 250)),
    ]);
    expect(outcome).toBe("fulfilled,rejected");
    // And the queue is still usable for the transition after them.
    await expect(adapter.end()).resolves.toBeUndefined();
    expect(client.end).toHaveBeenCalledOnce();
  });

  test("a dial or a close driven outside the transition that owns it fails loudly", async () => {
    // The chokepoint: ssh2-sftp-client's connect() and end(), the ssh2 Client's
    // own end(), and the forced socket destroys all reach the transport through
    // one of these three, so each refusing to run unlocked is what makes "every
    // dial and every close is serialized" a check rather than a reading of the
    // call graph. Each is handed a FOREIGN transition token, which is the form the
    // check has to catch: an abandoning teardown drives its forced close while
    // another transition is running, so a chokepoint that asked only whether SOME
    // transition was in progress would pass every one of these the moment one was.
    const { client, connect } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = adapter as any;
    const foreign = { kind: "connect", recordBoundary: () => {} };

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    await expect(
      internals.connectLocked({ host: "h" }, foreign) as Promise<void>,
    ).rejects.toThrow("outside the SFTP session transition that owns it");
    await expect(
      internals.closeTerminally(foreign) as Promise<void>,
    ).rejects.toThrow("outside the SFTP session transition that owns it");
    await expect(
      internals.awaitBoundedTeardown(
        foreign,
        Promise.resolve(),
        10,
        undefined,
        false,
      ) as Promise<unknown>,
    ).rejects.toThrow("outside the SFTP session transition that owns it");
    // Each refused BEFORE it drove anything: no second dial, and no close on a
    // connection the adapter is not tearing down.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.end).not.toHaveBeenCalled();

    // And the same three, driven from inside a transition that IS running but is
    // not theirs: the release below holds the queue while each is driven with the
    // token of a transition that has already left.
    const held: unknown[] = [];
    const release = internals.runTransition({
      kind: "releaseForIdle",
      skipped: () => undefined,
      abandoned: () => undefined,
      run: async (mine: unknown) => {
        held.push(
          await internals
            .connectLocked({ host: "h" }, foreign)
            .then(() => "dialed")
            .catch((error: Error) => error.message),
        );
        // The token of the transition actually running is accepted, which is what
        // makes the three failures above a check on identity rather than on the
        // shape of the argument.
        expect(() =>
          internals.assertTransitionHeld("a probe", mine),
        ).not.toThrow();
      },
    }) as Promise<void>;
    await release;
    expect(held).toEqual([
      expect.stringContaining(
        "outside the SFTP session transition that owns it",
      ),
    ]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("the abandoned teardown's forced close is exempt only while teardown is latched", async () => {
    // The one mechanism that runs while ANOTHER transition holds the client, so it
    // cannot present the holder's token -- and it must not be free of a check
    // either. What makes it safe is the teardown latch: end() latches before it
    // enqueues, so every transition behind the abandoning teardown skips its body
    // and the holder ahead of it is the only one that can be running. Driven here
    // with no latch, which is the state that must fail.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = adapter as any;

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const socket = rawClient._sock as { destroy: ReturnType<typeof vi.fn> };

    expect(() => internals.forceCloseAbandonedTeardown()).toThrow(
      "with no teardown latched",
    );
    expect(socket.destroy).not.toHaveBeenCalled();

    internals.closing = true;
    internals.forceCloseAbandonedTeardown();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  test("an abandoned teardown that cannot close the transport still stops the keepalive", async () => {
    // The degraded branch reports this teardown DONE over a transport it could not
    // close, so the keepalive must not go on beating against that connection --
    // which is why the stop precedes the seam, exactly as it does in the terminal
    // close. Driven in the default held-session mode, the one that arms a heartbeat.
    vi.useFakeTimers();
    try {
      const { client, rawClient } = ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter();
      stub(adapter);
      install(adapter, client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internals = adapter as any;

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      // An ssh2 that relocated the socket's destroy, the one seam this path drives.
      delete (rawClient._sock as { destroy?: unknown }).destroy;
      internals.closing = true;
      internals.forceCloseAbandonedTeardown();

      expect(adapterLog(adapter).warn).toHaveBeenCalledWith(
        expect.stringContaining("client._sock.destroy()"),
      );
      await vi.advanceTimersByTimeAsync(SFTP_HEARTBEAT_INTERVAL_MS * 3);
      expect(client.realPath).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an operation on a live session takes no session transition at all", async () => {
    // The gate's fast path: with no release outstanding and none standing
    // unreconciled, an operation is issued with no acquire and not even a
    // microtask of delay, so the steady state inside a cycle costs exactly what
    // it did before the mode existed.
    const { client } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const log = recordTransitions(adapter);

    await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

    expect(log).toEqual([]);
  });

  test("a release whose ssh2 seams went away after the dial fails loudly", async () => {
    // The release resolves the seams again where it drives them, not only at the
    // dial: an ssh2 that relocated one between the two would otherwise reach a
    // TypeError at the idle boundary instead of the actionable error the dial-time
    // check gives.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    delete rawClient.end;

    const release = adapter.releaseForIdle();
    await expect(release).rejects.toThrow("client.end()");
    await expect(release).rejects.toThrow("DEPENDENCY_PINS.md");
  });

  test("a transition that needs the retained connect options and has none fails loudly", async () => {
    // Neither re-dial is reachable before the first connect -- the recovery
    // classifier refuses with no retained options, and core dials before it polls
    // -- so each states that as a check rather than dialing with undefined.
    const { client, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);
    // No session either, so each reaches its dial rather than returning on a live
    // one.
    state.live = false;

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).redialForRecovery() as Promise<void>,
    ).rejects.toThrow("a server-driven operation ran before connect()");
    await expect(adapter.ensureConnected()).rejects.toThrow(
      "a poll cycle ran before connect()",
    );
  });

  // --- the bounded acquire, and what an expired wait means -------------------
  //
  // The wait for the transition ahead is bounded; the transition being waited on
  // is not. A waiter whose bound expires abandons its OWN transition and proceeds
  // into no session action of its own -- teardown's forced socket destroy being
  // the single, narrow exception.

  // The bound the adapter arms on every queued acquire. Duplicated from the
  // adapter (the constant is deliberately not exported: it is a liveness backstop,
  // not a seam), so the cases below can sit either side of it.
  const ACQUIRE_BOUND_MS = 10_000;

  // The two bounds a release spends in its worst case, duplicated from the adapter
  // for the same reason, so the case that drives their sum against the bound above
  // can sit either side of each.
  const CLIENT_CLOSE_BOUND_MS = 5_000;
  const FORCED_CLOSE_BOUND_MS = 1_000;

  // A dial that never settles on its own but DOES settle when something destroys the
  // transport beneath it, because that is what the real stack does: a destroy
  // mid-handshake cuts the parked attempt short and it rejects with an
  // unexpected-close error indistinguishable from a peer's (measured; see
  // docs/spec/DEPENDENCY_PINS.md). A dial that stayed parked through the destroy
  // would hide what this adapter reports about that rejection, which is the
  // operator-facing half of what an abandoning teardown does.
  function parkDialUntilTransportDestroyed(
    connect: ReturnType<typeof vi.fn>,
    rawClient: EventEmitter,
  ): void {
    connect.mockImplementation(
      () =>
        new Promise<void>((_settle, reject) => {
          rawClient.once("close", () => {
            reject(
              Object.assign(
                new Error("getConnection: Unexpected close event"),
                {
                  code: "ERR_GENERIC_CLIENT",
                },
              ),
            );
          });
        }),
    );
  }

  // A cycle-start dial parked that way, entered on an idle queue so it HOLDS the
  // transition while everything requested behind it waits. Its own ceiling is its
  // caller's, which is exactly what the lock does not bound.
  function neverSettlingHolder(
    adapter: SSH2SFTPClientAdapter,
    connect: ReturnType<typeof vi.fn>,
    state: { live: boolean },
    rawClient: EventEmitter,
  ): Promise<boolean> {
    state.live = false;
    parkDialUntilTransportDestroyed(connect, rawClient);
    const holder = adapter.ensureConnected();
    void holder.catch(() => {});
    return holder;
  }

  test("the acquire is bounded: a queued transition gives up rather than waiting out the one ahead of it", async () => {
    // The counterpart of the property this lock shipped with. What is unbounded is
    // the transition being waited on -- the never-settling dial below is still
    // parked ten minutes later, because its ceiling is its caller's -- while the
    // WAIT for it is the adapter's own and ends at the bound.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      let holderSettled = false;
      const holder = neverSettlingHolder(adapter, connect, state, rawClient);
      void holder.then(
        () => {
          holderSettled = true;
        },
        () => {
          holderSettled = true;
        },
      );
      const released = adapter.releaseForIdle();
      const ready = adapter.ensureConnected();

      await vi.advanceTimersByTimeAsync(10 * 60_000);

      await expect(released).resolves.toBeUndefined();
      await expect(ready).resolves.toBe(false);
      expect(holderSettled).toBe(false);
      // Neither drove its own close or dial: the dial ahead of them still holds
      // the client.
      expect(rawClient.end).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("each transition kind enqueued behind a never-settling sibling abandons at the bound", async () => {
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      neverSettlingHolder(adapter, connect, state, rawClient);

      const settled: Record<string, string> = {};
      const record = (name: string, promise: Promise<unknown>): Promise<void> =>
        promise.then(
          (value) => {
            settled[name] = `resolved ${String(value)}`;
          },
          (error: unknown) => {
            settled[name] = `rejected ${String((error as Error).message)}`;
          },
        );
      // All five kinds, requested before end() latches so each takes a real queue
      // slot. Teardown is last for that reason.
      const waiters = [
        record("connect", adapter.connect({ host: "h" })),
        record("ensureConnected", adapter.ensureConnected()),
        record(
          "redialForRecovery",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (adapter as any).redialForRecovery() as Promise<string>,
        ),
        record("releaseForIdle", adapter.releaseForIdle()),
        record("teardown", adapter.end()),
      ];

      // Just inside the bound, every one of them is still waiting.
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS - 1_000);
      expect(settled).toEqual({});
      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.all(waiters);

      // Each on the terms its kind states: the cycle-start dial reports a cycle to
      // skip, the release that it released nothing, the recovery re-dial that no
      // session is live for the re-issue, teardown that the close is done (it
      // closed the transport from this side), and the first dial -- which has no
      // value that could mean "no session was established" -- rejects.
      expect(settled).toEqual({
        connect: expect.stringContaining(
          `waited ${ACQUIRE_BOUND_MS} ms for the session transition ahead of it`,
        ),
        ensureConnected: "resolved false",
        redialForRecovery: "resolved noSession",
        releaseForIdle: "resolved undefined",
        teardown: "resolved undefined",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a recovery re-dial that abandons over a held dead session fails the operation rather than re-issuing it", async () => {
    // The other arm of the abandoned re-dial's reading. Giving up the wait clears
    // nothing, so a session the partner dropped while withholding its close is
    // still held over a transport that can carry nothing: a re-issue there would
    // ride the per-operation deadline a second time to reach the loss the
    // operation already has.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      neverSettlingHolder(adapter, connect, state, rawClient);
      // The partner dropped this cycle's session and withheld its close while the
      // dial above still holds the transition.
      state.live = true;
      socket.writableEnded = true;
      client.delete.mockRejectedValueOnce(
        new TransportOperationStalledError(
          "SFTP file delete of /remote/x.json stalled: no response from the " +
            "server; refusing to wait on the server further",
        ),
      );

      const failing = adapter.delete("/remote/x.json").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS + 1_000);

      expect(await failing).toBeInstanceOf(TransportOperationStalledError);
      expect(client.delete).toHaveBeenCalledOnce();
      // The abandon drove nothing on the client the dial ahead of it holds, and
      // established nothing to count or report as a survived drop.
      expect(socket.destroy).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledTimes(2);
      expect(adapter.midExchangeReconnectCount).toBe(0);
      expect(adapterLog(adapter).warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("both cycle-boundary signals pace their declined-wait warning, on their own counts", async () => {
    // Core drives ensureConnected and releaseForIdle once each per poll cycle, and
    // one stuck transition declines both of them every cycle for as long as it
    // holds, so each line follows the cadence a chronic condition already gets
    // here: the first, then every SFTP_REDIAL_WARN_INTERVAL-th. The two are paced
    // on separate counts -- a shared one would escalate each line on the other
    // path's occurrences and misstate both numbers.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      neverSettlingHolder(adapter, connect, state, rawClient);

      const cycles = SFTP_REDIAL_WARN_INTERVAL + 2;
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        const ready = adapter.ensureConnected();
        const released = adapter.releaseForIdle();
        await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS + 1_000);
        await expect(ready).resolves.toBe(false);
        await expect(released).resolves.toBeUndefined();
      }
      // One release declined with no cycle-start dial beside it, so the two counts
      // are no longer the same number and the end-of-run total below can only be
      // the release's own.
      const lastRelease = adapter.releaseForIdle();
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS + 1_000);
      await expect(lastRelease).resolves.toBeUndefined();

      const warned = adapterLog(adapter).warn.mock.calls.flat() as string[];
      const declinedRedials = warned.filter((line) =>
        line.includes("ephemeral SFTP re-dial declined:"),
      );
      const declinedReleases = warned.filter((line) =>
        line.includes(
          "The connection-per-poll idle release did not close the SFTP session:",
        ),
      );
      expect(declinedRedials).toHaveLength(2);
      expect(declinedReleases).toHaveLength(2);
      expect(warned).toHaveLength(4);
      // The number in each escalated line is that path's own total, which is what
      // tells the operator how many cycles the condition has now cost.
      expect(declinedRedials[1]).toContain(
        `${SFTP_REDIAL_WARN_INTERVAL} cycles skipped this way`,
      );
      expect(declinedReleases[1]).toContain(
        `${SFTP_REDIAL_WARN_INTERVAL} idle boundaries released nothing this way`,
      );
      // What the end-of-run summary reports is every occurrence, not the paced
      // subset the log carries -- and the two signals total separately there too,
      // the release having declined once more than the cycle-start dial did. A
      // decline closed nothing, so it is neither a forced release nor a boundary
      // the partner closed on request, and none of the totals share a tally.
      expect(adapter.declinedReleaseCount).toBe(cycles + 1);
      expect(adapter.declinedCycleRedialCount).toBe(cycles);
      expect(adapter.forcedReleaseCount).toBe(0);
      expect(adapter.releasedBoundaryCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an abandoning waiter drives no connect, no client end(), and no destroy", async () => {
    // Asserted through the chokepoint rather than by counting calls alone: every
    // dial and every close presents the transition it runs inside, and the only
    // one that reaches the transport here is the holder's own dial. A chokepoint
    // that asked merely whether SOME transition was in progress would pass an
    // abandoning waiter's dial or close, since the sibling it gave up on is still
    // holding -- which is why the reading is identity. Teardown is excluded: it is
    // the one kind whose abandon does drive something, and it has its own case.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internals = adapter as any;

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      const chokepoint: string[] = [];
      const assertHeld = internals.assertTransitionHeld.bind(adapter);
      internals.assertTransitionHeld = (mechanism: string, held: unknown) => {
        chokepoint.push(
          `${mechanism} owner=${String(held === internals.transitionInProgress)}`,
        );
        assertHeld(mechanism, held);
      };

      neverSettlingHolder(adapter, connect, state, rawClient);
      const waiters = Promise.all([
        adapter.connect({ host: "h" }).catch(() => "rejected"),
        adapter.ensureConnected(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).redialForRecovery() as Promise<boolean>,
        adapter.releaseForIdle(),
      ]);
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS + 1_000);
      await waiters;

      // One dial reached the transport, the holder's, and it presented the
      // transition that was running.
      expect(chokepoint).toEqual(["ssh2-sftp-client's connect() owner=true"]);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(client.end).not.toHaveBeenCalled();
      expect(rawClient.end).not.toHaveBeenCalled();
      expect(socket.destroy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an abandoned transition frees the queue rather than pinning every later one", async () => {
    // Two halves, and the second is the trap: an abandoning waiter must give up its
    // own turn WITHOUT resolving its queue slot, because its successor waits on IT
    // rather than on the transition actually holding the client. A slot resolved on
    // the way out would admit that successor into its critical section alongside a
    // holder that has not settled -- two overlapping transitions on the one shared
    // client, which is the corruption the lock exists to prevent.
    vi.useFakeTimers();
    try {
      const { client, connect, state, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      const log = recordTransitions(adapter);

      // A dial that settles well past both waiters' bounds.
      state.live = false;
      connect.mockImplementation(async () => {
        await new Promise((settle) => setTimeout(settle, 25_000));
        state.live = true;
        socket.writableEnded = false;
        socket.destroyed = false;
      });
      const holder = adapter.ensureConnected();
      const released = adapter.releaseForIdle();

      // The successor acquires late, so its own bound has not expired when the
      // release's does: if the release freed its slot on the way out, this would
      // enter its critical section here, with the dial still holding.
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS - 2_000);
      const successor = adapter.ensureConnected();
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(released).resolves.toBeUndefined();
      expect(log).toEqual(["start:ensureConnected"]);

      // The successor abandons in its own turn rather than running behind the
      // release, and the dial ahead of both is still the only body that has run.
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS);
      await expect(successor).resolves.toBe(false);
      expect(log).toEqual(["start:ensureConnected"]);

      // Then the dial settles and the queue is usable again: nothing was pinned by
      // the two abandons.
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(holder).resolves.toBe(true);
      await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
      expect(log).toEqual([
        "start:ensureConnected",
        "end:ensureConnected",
        "start:releaseForIdle",
        "end:releaseForIdle",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a teardown that abandons still reaches its forced destroy", async () => {
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      const holder = neverSettlingHolder(adapter, connect, state, rawClient);

      const closed = adapter.end();
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS + 1_000);

      await expect(closed).resolves.toBeUndefined();
      // The destroy, and ONLY the destroy: ssh2-sftp-client's end() would
      // short-circuit on the session the live handshake has not restored and
      // resolve having closed nothing, and the ssh2 Client's own end() is the
      // release's mechanism, not teardown's.
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(socket.destroyed).toBe(true);
      expect(client.end).not.toHaveBeenCalled();
      expect(rawClient.end).not.toHaveBeenCalled();
      // The dial the destroy cut short reports the cycle it could not carry, and
      // reports it SILENTLY: its rejection is the one a peer close produces, so
      // warning about a transient dial failure -- and promising a retry on a next
      // tick this closing run does not have -- would tell the operator the partner
      // dropped a connection this adapter closed itself.
      await expect(holder).resolves.toBe(false);
      // Reported to the operator at default verbosity, naming the cause: a slow
      // transition of this adapter's own rather than a slow partner. Neither a
      // warning nor an error, so a run that already succeeded still reads as one.
      expect(adapterLog(adapter).warn).not.toHaveBeenCalled();
      expect(adapterLog(adapter).error).not.toHaveBeenCalled();
      expect(adapterLog(adapter).info.mock.calls.flat()).toEqual([
        expect.stringContaining(
          `did not complete within the ${ACQUIRE_BOUND_MS} ms teardown wait`,
        ),
      ]);
      // And nothing counted the deliberate close as a mid-exchange drop.
      expect(adapter.reconnectCount).toBe(0);
      expect(adapter.midExchangeReconnectCount).toBe(0);
      expect(adapter.forcedReleaseCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an operation whose recovery re-dial the teardown cut short surfaces the loss it was recovering from", async () => {
    // The other half of the same misattribution. A recovery re-dial can be the dial
    // an abandoning teardown destroys the transport beneath, and that rejection is
    // the one a peer close produces -- so the operation would surface this adapter's
    // own close in place of the session loss it was recovering from. Told apart by
    // the adapter's own reading of what it did, never by matching the error. Driven
    // in the default held-session mode, the one mid-exchange recovery was built for.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter();
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      // The session drops mid-operation, and the re-dial that follows parks on a
      // handshake that never settles.
      state.live = false;
      parkDialUntilTransportDestroyed(connect, rawClient);
      const listed = adapter.exists("/remote/out.json").then(
        () => "listed",
        (error: unknown) => (error as Error).message,
      );
      // The operation's own rejection and the recovery round after it are several
      // microtasks deep, so the re-dial is awaited into place: the teardown has to
      // queue BEHIND it rather than enter an idle queue ahead of it.
      await vi.advanceTimersByTimeAsync(10);
      expect(connect).toHaveBeenCalledTimes(2);
      // Now the re-dial holds the transition, so the teardown behind it gives up its
      // wait and destroys the transport beneath that dial.
      const closed = adapter.end();
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS + 1_000);

      await expect(closed).resolves.toBeUndefined();
      expect(socket.destroy).toHaveBeenCalledOnce();
      // The loss it was recovering from, not the unexpected-close error the destroy
      // produced on the dial.
      await expect(listed).resolves.toBe(
        "exists: No SFTP connection available",
      );
      expect(adapterLog(adapter).warn).not.toHaveBeenCalled();
      // The partner took this session before any teardown began, so it is counted
      // as the lost session it was; what the teardown cut short is the RECOVERY,
      // and no line reports one, because none completed.
      expect(adapter.reconnectCount).toBe(1);
      expect(adapter.midExchangeReconnectCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a teardown queued behind a release that spends its whole close budget waits it out", async () => {
    // The relationship the acquire bound's value rests on, driven rather than
    // derived: a release's worst case is CLIENT_CLOSE_TIMEOUT_MS and then
    // FORCED_CLOSE_TIMEOUT_MS, and a teardown queued behind one of those must wait
    // it out rather than destroy the transport from under it. Three independent
    // constants with no arithmetic in the source tying them together, so nothing but
    // a driven case can hold the relationship.
    vi.useFakeTimers();
    try {
      const { client, rawClient, socket } = ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      const log = recordTransitions(adapter);

      // A partner that answers neither the ssh2 Client's end() nor the destroy
      // beneath it, which is what makes the release spend both bounds in full: its
      // end() leaves the transport ended with the session still set, and the forced
      // close's own wait for the 'close' that would clear it expires too.
      rawClient.end = vi.fn(() => {
        socket.writableEnded = true;
      });
      socket.destroy = vi.fn(() => {
        socket.destroyed = true;
      });

      const settled: string[] = [];
      const released = adapter.releaseForIdle().then(
        () => settled.push("released"),
        () => settled.push("release raised"),
      );
      const closed = adapter.end().then(() => settled.push("closed"));

      // Past the release's first bound and into its second, the teardown behind it
      // is still waiting rather than giving up.
      await vi.advanceTimersByTimeAsync(
        CLIENT_CLOSE_BOUND_MS + FORCED_CLOSE_BOUND_MS - 1,
      );
      expect(settled).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toEqual(["release raised", "closed"]);
      await Promise.all([released, closed]);
      // The teardown ran its BODY: it drove ssh2-sftp-client's end(), which the
      // abandon path never does, and the only destroy is the release's own -- a
      // second one would be the abandon's.
      expect(log).toEqual([
        "start:releaseForIdle",
        "end:releaseForIdle",
        "start:teardown",
        "end:teardown",
      ]);
      expect(client.end).toHaveBeenCalledOnce();
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(adapterLog(adapter).info).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a caller that gives up waiting for end() still gets the forced destroy", async () => {
    // What this bound owes the budget end()'s CALLER holds: nothing. Core races
    // end() against one of its own that a low peer_timeout_ms can put under this
    // bound, and abandoning that wait closes nothing -- the destroy is what closes
    // the transport, and the abandon drives it whether or not anything is still
    // waiting on it, which is what leaves that caller an exited process rather
    // than a half-open socket.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      neverSettlingHolder(adapter, connect, state, rawClient);

      const callerBudgetMs = 3_000;
      const closed = adapter.end();
      const callerWait = Promise.race([
        closed.then(() => "closed"),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("gave up"), callerBudgetMs);
        }),
      ]);

      await vi.advanceTimersByTimeAsync(callerBudgetMs);
      await expect(callerWait).resolves.toBe("gave up");
      expect(socket.destroy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(
        ACQUIRE_BOUND_MS - callerBudgetMs + 1_000,
      );
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(socket.destroyed).toBe(true);
      await expect(closed).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a sibling that settles just inside the bound leaves the waiter running its transition normally", async () => {
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      const log = recordTransitions(adapter);

      state.live = false;
      connect.mockImplementation(async () => {
        await new Promise((settle) =>
          setTimeout(settle, ACQUIRE_BOUND_MS - 500),
        );
        state.live = true;
        socket.writableEnded = false;
        socket.destroyed = false;
      });
      const holder = adapter.ensureConnected();
      const released = adapter.releaseForIdle();

      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS);

      await expect(holder).resolves.toBe(true);
      await expect(released).resolves.toBeUndefined();
      // The release ran its body and closed the session the dial established: no
      // premature abandon, and nothing warned.
      expect(log).toEqual([
        "start:ensureConnected",
        "end:ensureConnected",
        "start:releaseForIdle",
        "end:releaseForIdle",
      ]);
      expect(rawClient.end).toHaveBeenCalledOnce();
      // Nothing was abandoned, so neither the declined-release nor the declined
      // cycle-redial line fired. The dial's own line is the drop this setup
      // stages -- the session was cleared before it ran, which that dial absorbed
      // and reports -- and is not what this case is about.
      expect(
        adapterLog(adapter).warn.mock.calls.filter(([message]: [string]) =>
          String(message).includes("did not complete within"),
        ),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the acquire bound's timer is ref'd", async () => {
    // A liveness bound the process can exit out from under is not a bound, and the
    // abandon this one arms is what closes a transport nothing else will. Nothing
    // measures a process-exit difference behind the ref -- the transition being
    // waited on is itself parked on a ref'd socket handle -- so it is the safe
    // default rather than a driven consequence, and dropping it would otherwise be
    // a silent change.
    vi.useFakeTimers();
    const armed: { delayMs: number; handle: { hasRef(): boolean } }[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((
        callback: (...args: unknown[]) => void,
        delayMs?: number,
        ...rest: unknown[]
      ) => {
        const handle = realSetTimeout(callback, delayMs, ...rest);
        armed.push({
          delayMs: delayMs ?? 0,
          handle: handle as unknown as { hasRef(): boolean },
        });
        return handle;
      }) as unknown as typeof setTimeout);
    try {
      const { client, connect, state, rawClient } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      neverSettlingHolder(adapter, connect, state, rawClient);
      const released = adapter.releaseForIdle();

      // Identified by its (unexported, liveness-backstop) delay, read before the
      // wait settles and clears it.
      const acquireBound = armed.filter(
        (timer) => timer.delayMs === ACQUIRE_BOUND_MS,
      );
      expect(acquireBound).toHaveLength(1);
      expect(acquireBound[0].handle.hasRef()).toBe(true);

      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS + 1);
      await expect(released).resolves.toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test("a wait that is won leaves no timer behind it", async () => {
    // The bound's timer is ref'd, so one still pending after its wait was won
    // would hold an otherwise drained process for the remainder of the bound --
    // on the ORDINARY path, at every queued acquire, with nothing having gone
    // wrong. What a leak looks like is growth, one timer per acquire, so the
    // steady state across cycles is the reading rather than any fixed count; the
    // cycles stay well inside the bound, past which a leaked timer would have
    // fired and read the same as one that was cleared.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      const dialMs = 1_000;
      connect.mockImplementation(async () => {
        await new Promise((settle) => setTimeout(settle, dialMs));
        state.live = true;
        socket.writableEnded = false;
        socket.destroyed = false;
      });

      const timersAfterCycle: number[] = [];
      for (let cycle = 0; cycle < 3; cycle += 1) {
        state.live = false;
        const dialed = adapter.ensureConnected();
        // Queued behind that dial, so its acquire arms the bound and then wins it
        // well inside it.
        const released = adapter.releaseForIdle();
        await vi.advanceTimersByTimeAsync(dialMs + 1);
        await expect(dialed).resolves.toBe(true);
        await expect(released).resolves.toBeUndefined();
        timersAfterCycle.push(vi.getTimerCount());
      }

      // Each release ran its BODY rather than abandoning, which is what makes
      // these waits won ones.
      expect(rawClient.end).toHaveBeenCalledTimes(3);
      expect(timersAfterCycle).toEqual([
        timersAfterCycle[0],
        timersAfterCycle[0],
        timersAfterCycle[0],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a dial behind a latched teardown stops retrying between attempts", async () => {
    // The other half of the fix, and not a substitute for the bound: with the wait
    // bounded, an abandoning teardown destroys the socket beneath a mid-handshake
    // dial and that attempt rejects as an unexpected close -- but the retry loop
    // would then mint a FRESH socket and keep a torn-down connection, and a process
    // that exits by drain, alive for the remainder of the dial budget (measured
    // against the real stack). So the loop reads the teardown latch between
    // attempts, exactly as runTransition reads it before a transition's body.
    vi.useFakeTimers();
    try {
      const { client, connect, state } = ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      stub(adapter);
      install(adapter, client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internals = adapter as any;

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

      // The control: the same rejection with no teardown latched spends the whole
      // retry budget, so the case below is the latch and not the rejection.
      state.live = false;
      let attempts = 0;
      connect.mockImplementation(async () => {
        attempts += 1;
        throw new Error("getConnection: Unexpected close event");
      });
      const control = adapter.ensureConnected();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(control).resolves.toBe(false);
      expect(attempts).toBe(3);

      attempts = 0;
      connect.mockImplementation(async () => {
        attempts += 1;
        // What an abandoning teardown leaves behind: the latch set, and the socket
        // beneath this very attempt destroyed under it.
        internals.closing = true;
        throw new Error("getConnection: Unexpected close event");
      });
      const latched = adapter.ensureConnected();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(latched).resolves.toBe(false);
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- terminal close bound (a partner that never closes) ----------------------
//
// Closing an SFTP connection is a two-party act: this side disconnects and the
// server closes the connection. ssh2-sftp-client's end() settles only from the
// ssh2 Client's 'close', so a partner that accepts the disconnect and then goes
// quiet leaves it pending forever on a transport this side has already ended --
// and the half-open socket, a ref'd handle, keeps a completed run alive. The
// adapter bounds that wait and closes the connection from its own side. Common to
// BOTH session modes: nothing on the path is gated on connection-per-poll.

describe("terminal close against a partner that withholds its close", () => {
  const wrapper = () => ({
    open: vi.fn(),
    close: vi.fn(),
    opendir: vi.fn(),
    readdir: vi.fn(),
    on: vi.fn(),
  });

  interface TerminalCloseSocket {
    setKeepAlive: () => void;
    writableEnded: boolean;
    destroyed: boolean;
    destroy?: () => void;
  }

  // An ssh2-sftp-client stand-in modeling the pinned library against such a
  // partner: client.end() ends the transport and then stays PENDING, because the
  // ssh2 Client's 'close' it settles from never arrives. Destroying the socket
  // beneath it settles that same pending end() rather than rejecting it -- the
  // sequence measured against a real ssh2 server -- so the stand-in resolves it
  // from destroy(), the way the library does.
  function partnerThatNeverCloses(options: { closes?: boolean } = {}) {
    const state = { live: true };
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    const socket: TerminalCloseSocket = {
      setKeepAlive: () => {},
      writableEnded: false,
      destroyed: false,
    };
    let settleEnd: (() => void) | undefined;
    socket.destroy = vi.fn(() => {
      socket.destroyed = true;
      state.live = false;
      rawClient.emit("close");
      settleEnd?.();
      settleEnd = undefined;
    });
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: socket,
      end: vi.fn(() => {
        socket.writableEnded = true;
      }),
    });
    const session = wrapper();
    const client = {
      get sftp() {
        return state.live ? session : null;
      },
      connect: vi.fn().mockResolvedValue(undefined),
      client: rawClient,
      end: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            socket.writableEnded = true;
            if (options.closes === true) {
              socket.destroyed = true;
              state.live = false;
              resolve();
              return;
            }
            settleEnd = resolve;
          }),
      ),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    return { client, rawClient, socket };
  }

  function loggedAdapter(options: { ephemeralSessions?: boolean } = {}) {
    const adapter = new SSH2SFTPClientAdapter(options);
    const log = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      error: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = log;
    return { adapter, log };
  }

  const install = (adapter: SSH2SFTPClientAdapter, client: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = client;
  };

  // The adapter's own bounds (not exported; liveness backstops, not tunables).
  const TERMINAL_CLOSE_BOUND_MS = 5_000;
  const FORCED_CLOSE_BOUND_MS = 1_000;

  test.each([
    { mode: "connection-per-poll", ephemeralSessions: true },
    { mode: "the default held session", ephemeralSessions: false },
  ])(
    "a teardown whose close never arrives settles within the bound in $mode",
    async ({ ephemeralSessions }) => {
      vi.useFakeTimers();
      try {
        const { client, socket } = partnerThatNeverCloses();
        const { adapter, log } = loggedAdapter({ ephemeralSessions });
        install(adapter, client);
        await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

        let settled = false;
        const closing = adapter.end().then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(TERMINAL_CLOSE_BOUND_MS - 1);
        // Still inside the bound: nothing has been forced and the close is the
        // partner's to complete.
        expect(settled).toBe(false);
        expect(socket.destroy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(FORCED_CLOSE_BOUND_MS + 2);
        await closing;

        expect(settled).toBe(true);
        // The socket is gone, so the process holds no half-open handle: this is
        // what the bound exists for, not merely returning the caller.
        expect(socket.destroy).toHaveBeenCalledOnce();
        expect(socket.destroyed).toBe(true);
        // Informational, at default verbosity, once: teardown's close runs last,
        // so nothing here reads as a failure.
        expect(log.info).toHaveBeenCalledTimes(1);
        const message = log.info.mock.calls[0][0] as string;
        expect(message).toContain("did not close the connection");
        expect(message).toContain("this side closed it");
        // end() runs from core's close() on EVERY teardown -- a failed run and a
        // bare connect/close included -- and the adapter has no notion of which,
        // so the line may claim nothing about the exchange or what it produced.
        expect(message).not.toMatch(/exchange|nothing was lost/i);
        expect(log.warn).not.toHaveBeenCalled();
        // Not the connection-per-poll release's boundary, so it is not counted as
        // one -- under either mode, and by neither of that boundary's two counts --
        // and no session was lost, so it is not a reconnection either.
        expect(adapter.forcedReleaseCount).toBe(0);
        expect(adapter.declinedReleaseCount).toBe(0);
        expect(adapter.reconnectCount).toBe(0);
        expect(adapter.midExchangeReconnectCount).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("a teardown against a partner that closes settles on that close, with no added wait", async () => {
    // The healthy path must be untouched: end() resolves on the partner's own
    // close, the bound never expires, and nothing is destroyed or logged. Under
    // fake timers a resolution that needed the bound could not land at all, so
    // completing here IS the no-added-wait assertion.
    vi.useFakeTimers();
    try {
      const { client, socket } = partnerThatNeverCloses({ closes: true });
      const { adapter, log } = loggedAdapter();
      install(adapter, client);
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      await adapter.end();

      expect(client.end).toHaveBeenCalledOnce();
      expect(socket.destroy).not.toHaveBeenCalled();
      expect(log.info).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a teardown whose end() rejects still closes the connection from this side", async () => {
    // ssh2-sftp-client's end() rejects from its temporary 'error' listener on a
    // non-ECONNRESET client error during teardown, having closed nothing: its
    // end/close listeners are gated off by endCalled, so the socket is left
    // exactly as a withheld close leaves it. A rejection is therefore not
    // "the partner closed" -- reading it that way skips the forced close and
    // hands the caller a live half-open socket, which is the process that never
    // exits.
    const { client, socket } = partnerThatNeverCloses();
    const { adapter, log } = loggedAdapter();
    install(adapter, client);
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const failure = new Error("Unexpected close event");
    client.end = vi.fn(() => {
      socket.writableEnded = true;
      return Promise.reject(failure);
    });

    await expect(adapter.end()).rejects.toBe(failure);

    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(socket.destroyed).toBe(true);
    // The operator hears what actually happened: nothing timed out here, so the
    // line names the failed close rather than a partner that ran out the bound.
    expect(log.info).toHaveBeenCalledTimes(1);
    const message = log.info.mock.calls[0][0] as string;
    expect(message).toContain("Unexpected close event");
    expect(message).toContain("this side closed");
    expect(message).not.toContain("teardown bound");
    // This line lands where a failed run's operator reads the verdict, so it may
    // not claim an outcome the adapter cannot know.
    expect(message).not.toMatch(/exchange|nothing was lost/i);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test.each([
    { seam: "client.once" },
    { seam: "client.removeListener" },
    { seam: "client._sock.writableEnded" },
  ])(
    "a teardown still closes the connection when only $seam has moved",
    async ({ seam }) => {
      // The terminal close drives client._sock.destroy() and reads
      // _sock.destroyed; it touches none of the seams the connection-per-poll
      // release needs. Giving up on one of those would disable the forced destroy
      // over a member this path never calls -- and in the default mode connect()
      // checks nothing, so the first sign would be a completed run that never
      // exits.
      vi.useFakeTimers();
      try {
        const { client, rawClient, socket } = partnerThatNeverCloses();
        const { adapter, log } = loggedAdapter();
        install(adapter, client);
        await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
        // Defined as an inert accessor rather than assigned: the stand-in's own
        // end() writes writableEnded back to true, so a plain assignment would
        // be undone before the close reads it and the case would pass vacuously.
        const relocate = (host: object, member: string): void => {
          Object.defineProperty(host, member, {
            get: () => undefined,
            set: () => {},
            configurable: true,
          });
        };
        if (seam === "client._sock.writableEnded")
          relocate(socket, "writableEnded");
        else relocate(rawClient, seam.slice("client.".length));

        const closing = adapter.end();
        await vi.advanceTimersByTimeAsync(
          TERMINAL_CLOSE_BOUND_MS + FORCED_CLOSE_BOUND_MS + 2,
        );
        await expect(closing).resolves.toBeUndefined();

        expect(socket.destroy).toHaveBeenCalledOnce();
        expect(socket.destroyed).toBe(true);
        expect(log.info).toHaveBeenCalledTimes(1);
        expect(log.warn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("a teardown whose forced close has no mechanism takes its safe branch", async () => {
    // The seams are verified at connect only in connection-per-poll mode, so the
    // default mode meets an ssh2 upgrade that relocated one here, at teardown.
    // Failing a dial over a teardown-only mechanism would ground every
    // default-mode exchange on an upgrade that costs it nothing, so the branch
    // warns and returns bounded instead.
    vi.useFakeTimers();
    try {
      const { client, socket } = partnerThatNeverCloses();
      delete socket.destroy;
      const { adapter, log } = loggedAdapter();
      install(adapter, client);
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      let settled = false;
      const closing = adapter.end().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(TERMINAL_CLOSE_BOUND_MS + 2);
      await closing;

      expect(settled).toBe(true);
      expect(log.warn).toHaveBeenCalledTimes(1);
      const message = log.warn.mock.calls[0][0] as string;
      expect(message).toContain("client._sock.destroy()");
      // Named alongside the checklist that re-verifies it.
      expect(message).toContain("DEPENDENCY_PINS.md");
      expect(log.info).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a teardown whose destroyed socket does not close warns rather than throwing", async () => {
    // The one premise connect() cannot check, because nothing at connect time
    // destroys the socket: it is read back where it is driven. Nothing here may
    // throw -- core logs an end() rejection at debug, so a throw would be
    // invisible and would accomplish nothing.
    vi.useFakeTimers();
    try {
      const { client, socket } = partnerThatNeverCloses();
      socket.destroy = vi.fn();
      const { adapter, log } = loggedAdapter();
      install(adapter, client);
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      const closing = adapter.end();
      await vi.advanceTimersByTimeAsync(
        TERMINAL_CLOSE_BOUND_MS + FORCED_CLOSE_BOUND_MS + 2,
      );
      await expect(closing).resolves.toBeUndefined();

      expect(socket.destroyed).toBe(false);
      expect(log.warn).toHaveBeenCalledTimes(1);
      const message = log.warn.mock.calls[0][0] as string;
      expect(message).toContain("did not close after this side destroyed it");
      expect(message).toContain("DEPENDENCY_PINS.md");
      // The connection was not closed on this branch, so the operator is not
      // told it was: the informational line follows the close it reports.
      expect(log.info).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a teardown whose forced close throws warns rather than rejecting", async () => {
    // A throw out of net.Socket's destroy() must not become an end() rejection:
    // core logs one at debug, so it would tell the operator nothing while
    // suppressing the branch that does.
    vi.useFakeTimers();
    try {
      const { client, socket } = partnerThatNeverCloses();
      socket.destroy = vi.fn(() => {
        throw new Error("socket already destroyed");
      });
      const { adapter, log } = loggedAdapter();
      install(adapter, client);
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      const closing = adapter.end();
      await vi.advanceTimersByTimeAsync(TERMINAL_CLOSE_BOUND_MS + 2);
      await expect(closing).resolves.toBeUndefined();

      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0][0] as string).toContain(
        "socket already destroyed",
      );
      // Nothing closed here either, so nothing claims it did.
      expect(log.info).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a repeat close after a bounded teardown is a clean no-op", async () => {
    // The client was abandoned mid-end() and its socket destroyed under it, so a
    // second close must not re-enter it, re-destroy, or tell the operator twice.
    vi.useFakeTimers();
    try {
      const { client, socket } = partnerThatNeverCloses();
      const { adapter, log } = loggedAdapter();
      install(adapter, client);
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      const closing = adapter.end();
      await vi.advanceTimersByTimeAsync(
        TERMINAL_CLOSE_BOUND_MS + FORCED_CLOSE_BOUND_MS + 2,
      );
      await closing;

      // No timer advance: a repeat that re-entered the client would sit out the
      // whole bound again rather than returning here.
      await expect(adapter.end()).resolves.toBeUndefined();

      expect(client.end).toHaveBeenCalledOnce();
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    { when: "in the same tick", advanceMs: 0 },
    { when: "inside the bound", advanceMs: TERMINAL_CLOSE_BOUND_MS - 1 },
  ])(
    "a second close issued $when while the first is in flight forces the teardown once between them",
    async ({ advanceMs }) => {
      // Two closes can be in flight at once: withSessionRecovery issues a
      // re-entrant one when a re-dial lands inside a teardown an external close
      // has already latched. The forced close belongs to the CONNECTION, not to a
      // caller -- one client.end(), one destroy(), one line to the operator,
      // however many callers are waiting on it.
      vi.useFakeTimers();
      try {
        const { client, socket } = partnerThatNeverCloses();
        const { adapter, log } = loggedAdapter();
        install(adapter, client);
        await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

        const first = adapter.end();
        if (advanceMs > 0) await vi.advanceTimersByTimeAsync(advanceMs);
        let secondSettled = false;
        const second = adapter.end().then(() => {
          secondSettled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        // The second caller waits for the close in flight rather than returning
        // over a connection still being closed.
        expect(secondSettled).toBe(false);
        expect(socket.destroy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(
          TERMINAL_CLOSE_BOUND_MS + FORCED_CLOSE_BOUND_MS + 2,
        );
        await Promise.all([first, second]);

        expect(secondSettled).toBe(true);
        expect(client.end).toHaveBeenCalledOnce();
        expect(socket.destroy).toHaveBeenCalledOnce();
        expect(socket.destroyed).toBe(true);
        expect(log.info).toHaveBeenCalledTimes(1);
        expect(log.warn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("a terminally closed adapter refuses to connect again", async () => {
    // The close is memoized for the CONNECTION and never cleared, so a second
    // session dialed on this adapter would answer a later close() from that
    // settled memo and never be ended at all -- a live session and a ref'd handle
    // left behind on a run that believes it closed. Every caller in the tree
    // builds a fresh adapter per connection, so the refusal is what keeps that
    // true rather than a note asking a future caller to.
    const { client, socket } = partnerThatNeverCloses({ closes: true });
    const { adapter } = loggedAdapter();
    install(adapter, client);
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await adapter.end();
    expect(socket.destroyed).toBe(true);

    await expect(
      adapter.connect({ host: "h", maxReconnectAttempts: 0 }),
    ).rejects.toThrow("cannot be reopened");
    expect(client.connect).toHaveBeenCalledOnce();
  });

  test("a connect issued during an in-flight teardown parks, then refuses", async () => {
    // connect() takes the transition queue like every other transition, in both
    // session modes, so one issued while a teardown is still closing waits that
    // teardown out and refuses on the far side of it rather than refusing at once.
    // The alternative -- reading the teardown latch before the acquire -- would be
    // a second reading of it outside the lock, for a faster failure with the same
    // wording on a path nothing in the tree takes. A dial issued once the teardown
    // has settled does not park at all: the queue is drained by then.
    vi.useFakeTimers();
    try {
      const { client, socket } = partnerThatNeverCloses();
      const { adapter } = loggedAdapter();
      install(adapter, client);
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      const closing = adapter.end();
      const reopen = adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      const refused = expect(reopen).rejects.toThrow("cannot be reopened");
      let reopenSettled = false;
      void reopen.catch(() => {
        reopenSettled = true;
      });

      await vi.advanceTimersByTimeAsync(TERMINAL_CLOSE_BOUND_MS - 1);
      expect(reopenSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(FORCED_CLOSE_BOUND_MS + 2);
      await Promise.all([closing, refused]);
      expect(socket.destroyed).toBe(true);
      // The parked dial refused rather than reaching the client.
      expect(client.connect).toHaveBeenCalledOnce();

      // No timer stands between this caller and its refusal: under fake timers a
      // refusal that needed one could not land at all.
      await expect(
        adapter.connect({ host: "h", maxReconnectAttempts: 0 }),
      ).rejects.toThrow("cannot be reopened");
      expect(client.connect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a close that rejects is shared by a repeat rather than re-attempted", async () => {
    // The connection has one terminal close and one outcome. The rejection is only
    // ever visible over a connection this side has already closed -- the memo does
    // not settle until the forced close has run -- so re-driving the client has
    // nothing left to close, and core logs an end() rejection at debug either way.
    const { client, socket } = partnerThatNeverCloses({ closes: true });
    const { adapter } = loggedAdapter();
    install(adapter, client);
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const failure = new Error("Unexpected close event");
    client.end = vi.fn().mockRejectedValue(failure);

    await expect(adapter.end()).rejects.toBe(failure);
    expect(socket.destroyed).toBe(true);
    await expect(adapter.end()).rejects.toBe(failure);

    expect(client.end).toHaveBeenCalledOnce();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
});

describe("SFTP adapter session accounting", () => {
  // A stand-in whose session lifecycle a case drives directly: the ssh2 Client's
  // EventEmitter surface the release and the recovery re-dial reach past the
  // public API for, and a socket whose half-close flags a case sets to stage the
  // three ways a session can end at an idle boundary.
  function accountingClient() {
    const state = { live: true, closesOnRequest: true };
    const wrapper = Object.assign(new EventEmitter(), {
      open: vi.fn(),
      close: vi.fn(),
      opendir: vi.fn(),
      readdir: vi.fn(),
    });
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    const socket = {
      setKeepAlive: vi.fn(),
      writableEnded: false,
      readableEnded: false,
      destroyed: false,
      destroy: vi.fn(() => {
        socket.destroyed = true;
        state.live = false;
        rawClient.emit("close");
      }),
    };
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: socket,
      end: vi.fn(() => {
        if (!state.closesOnRequest) {
          socket.writableEnded = true;
          return;
        }
        state.live = false;
        rawClient.emit("close");
      }),
    });
    let failInFlight: ((error: unknown) => void) | undefined;
    const connect = vi.fn().mockImplementation(async () => {
      // ssh2 mints a fresh socket per dial, so no half of it is ended.
      socket.writableEnded = false;
      socket.readableEnded = false;
      socket.destroyed = false;
      state.live = true;
    });
    const notConnected = () =>
      Object.assign(new Error("exists: No SFTP connection available"), {
        code: "ERR_NOT_CONNECTED",
      });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
      exists: vi.fn(
        () =>
          new Promise<boolean>((resolve, reject) => {
            if (!state.live) {
              reject(notConnected());
              return;
            }
            const answer = setTimeout(() => resolve(true), 0);
            failInFlight = (error: unknown) => {
              clearTimeout(answer);
              reject(error);
            };
          }),
      ),
    };
    // The partner drops the session, tearing whatever is on the wire with it.
    const dropFromServer = () => {
      state.live = false;
      failInFlight?.(notConnected());
      failInFlight = undefined;
    };
    return { client, connect, state, socket, wrapper, dropFromServer };
  }

  function install(adapter: SSH2SFTPClientAdapter, client: object): void {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (adapter as any).log = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      error: vi.fn(),
    };
    (adapter as any).client = client;
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  // The scenario's guard is the per-cause assertion each step makes below:
  // WHICH cause was charged, and that its total moved by exactly one. The
  // balance sum(losses) === generationsEnded is deliberately not asserted --
  // it is an arithmetic identity of the ledger (losses rise only where `live`
  // clears, and the ended count is derived from `live`), so it holds whatever
  // the adapter does and a missed or mis-attributed charge cannot move it.
  // What holds INV-L1 at runtime is structural instead: the dial charges any
  // pending end before advancing, and the ledger raises if one slips through.
  function lossesAfter(
    adapter: SSH2SFTPClientAdapter,
  ): Readonly<Record<string, number>> {
    return adapter.sessionAccounting.losses;
  }

  test("every generation a driven scenario ends records exactly one cause", async () => {
    vi.useFakeTimers();
    try {
      const { client, connect, state, socket, wrapper, dropFromServer } =
        accountingClient();
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 4 });
      expect(lossesAfter(adapter)).toEqual({
        partner: 0,
        deliberate: 0,
        teardown: 0,
        fatal: 0,
      });

      // The ordinary release: this side drove the close and the partner answered.
      await adapter.releaseForIdle();
      expect(lossesAfter(adapter).deliberate).toBe(1);

      // A second boundary over the same already-ended generation adds nothing.
      await adapter.releaseForIdle();
      expect(adapter.sessionAccounting.losses.deliberate).toBe(1);

      // The peer's FIN consumed before the boundary: the session was the peer's to
      // take, and the release runs its course over one it did not end.
      await adapter.ensureConnected();
      socket.readableEnded = true;
      await adapter.releaseForIdle();
      expect(lossesAfter(adapter).partner).toBe(1);

      // The session already cleared when the boundary fell.
      await adapter.ensureConnected();
      state.live = false;
      await adapter.releaseForIdle();
      expect(lossesAfter(adapter).partner).toBe(2);

      // The partner's disconnect answered by ssh2 ending its own half, with
      // nothing on the wire: the release takes the session, the partner took what
      // the session was running on.
      await adapter.ensureConnected();
      socket.writableEnded = true;
      await adapter.releaseForIdle();
      expect(lossesAfter(adapter).partner).toBe(3);

      // A drop that tore an operation, recovered by the arm's own re-dial.
      await adapter.ensureConnected();
      const torn = adapter.exists("/remote/out.json");
      dropFromServer();
      // The re-issue's own round trip answers a tick later, which under this
      // case's fake clock has to be advanced to.
      await vi.advanceTimersByTimeAsync(10);
      await expect(torn).resolves.toBe(true);
      expect(lossesAfter(adapter).partner).toBe(4);

      // A partner that never answers the close, so this side forces it: a boundary
      // this side ended all the same.
      state.closesOnRequest = false;
      const forced = adapter.releaseForIdle();
      await vi.advanceTimersByTimeAsync(7_000);
      await forced;
      expect(adapter.forcedReleaseCount).toBe(1);
      expect(lossesAfter(adapter).deliberate).toBe(2);

      // A fatal SFTP protocol error kills the wrapper: the generation ends with a
      // cause of its own, and the teardown behind it records nothing over it.
      state.closesOnRequest = true;
      await adapter.ensureConnected();
      wrapper.emit("error", new Error("malformed SFTP packet"));
      expect(lossesAfter(adapter).fatal).toBe(1);

      await adapter.end();
      const losses = lossesAfter(adapter);
      expect(losses.teardown).toBe(0);

      // The boundary partition is total: every invocation of the release recorded
      // exactly one outcome.
      const releaseInvocations = 6;
      const boundaries = adapter.sessionAccounting.boundaries;
      expect(
        Object.values(boundaries).reduce((total, count) => total + count, 0),
      ).toBe(releaseInvocations);
      // And the counters an operator reads are those losses projected, never a
      // tally of their own.
      expect(adapter.midExchangeReconnectCount).toBe(losses.partner);
      expect(adapter.reconnectCount).toBe(losses.partner);
      expect(connect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a teardown of a live session records the teardown that ended it", async () => {
    const { client } = accountingClient();
    const adapter = new SSH2SFTPClientAdapter();
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await adapter.end();

    const accounting = adapter.sessionAccounting;
    expect(accounting.losses).toEqual({
      partner: 0,
      deliberate: 0,
      teardown: 1,
      fatal: 0,
    });
    expect(accounting.generationsEnded).toBe(1);
    // Teardown mechanics, so nothing an operator reads as a drop.
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
  });

  test("a repeat connect() over a live session charges the replaced generation as deliberate", async () => {
    const { client } = accountingClient();
    const adapter = new SSH2SFTPClientAdapter();
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const accounting = adapter.sessionAccounting;
    expect(accounting.losses).toEqual({
      partner: 0,
      deliberate: 1,
      teardown: 0,
      fatal: 0,
    });
    expect(accounting.generationsEnded).toBe(1);
    // Replacing a session this side still held is this side's doing, so nothing
    // an operator reads as a drop.
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
  });

  test("a drop the exhausted budget refuses is charged like every other", async () => {
    // The budget bounds sessions LOST rather than re-dials made, so the drop it
    // refuses is recorded exactly as the ones it allowed: the generation ended,
    // and INV-L1 admits no generation that ends uncharged.
    const { client, connect, dropFromServer } = accountingClient();
    const adapter = new SSH2SFTPClientAdapter();
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 1 });

    const first = adapter.exists("/remote/out.json");
    dropFromServer();
    await expect(first).resolves.toBe(true);
    expect(adapter.midExchangeReconnectCount).toBe(1);

    const refused = adapter.exists("/remote/out.json");
    dropFromServer();
    await expect(refused).rejects.toBeInstanceOf(UsageError);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.midExchangeReconnectCount).toBe(2);
    expect(lossesAfter(adapter).partner).toBe(2);

    await adapter.end();
    // The refused drop already took the session, so the teardown ends nothing.
    expect(lossesAfter(adapter)).toEqual({
      partner: 2,
      deliberate: 0,
      teardown: 0,
      fatal: 0,
    });
  });
});
