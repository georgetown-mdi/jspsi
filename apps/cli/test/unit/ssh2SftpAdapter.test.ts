import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  DirectoryListingBoundsError,
  FileTransportClient,
  FrameSizeExceededError,
  TransportOperationStalledError,
  UsageError,
} from "@psilink/core";

import {
  SSH2SFTPClientAdapter,
  SFTP_REDIAL_WARN_INTERVAL,
} from "../../src/connection/ssh2SftpAdapter";
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
// and its socket's destroy() and half-close flag.
const releasableClient = () =>
  Object.assign(new EventEmitter(), {
    setNoDelay: () => {},
    _sock: { setKeepAlive: () => {}, writableEnded: false, destroy: () => {} },
    end: () => {},
  });

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
    // outcome; CONTRIBUTING.md's "Upgrading the SFTP stack" checklist names
    // confirming this fragment as a per-bump obligation, which this pins.
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
        // in CONTRIBUTING.md ("Upgrading the SFTP stack"); if a future bump
        // renames it, that checklist and this string move together.
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

    // connect() registers nothing on the ssh2 Client itself unless keyboard-
    // interactive is enabled (the fatal-error listener goes on the SFTPWrapper).
    expect(client.on).not.toHaveBeenCalled();
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

    expect(client.on).not.toHaveBeenCalled();
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

    expect(client.on).toHaveBeenCalledTimes(1);
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
    expect(client.on).toHaveBeenCalledTimes(1);
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
      expect((err as Error).message).toContain("withheld the rename response");
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
      expect((err as Error).message).toContain("withheld the delete response");
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
      expect((err as Error).message).toContain("withheld the stat response");
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
      expect((err as Error).message).toContain("made no upload progress");
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
      expect((err as Error).message).toContain("made no upload progress");
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
      expect((err as Error).message).toContain("made no upload progress");
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
      expect((err as Error).message).toContain("Malformed DATA packet");
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
      expect((err as Error).message).toContain("Malformed DATA packet");
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

  test("emitting 'error' on the wrapper does not crash (listener handles it)", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    const wrapper = makeWrapper();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      sftp: wrapper,
      connect: vi.fn().mockResolvedValue(undefined),
      client: noDelayClient(),
    };
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // Node throws on an 'error' event only when there are zero listeners; the
    // guard makes this a no-op instead of an uncaught exception.
    expect(() =>
      wrapper.emit("error", new Error("Malformed NAME packet")),
    ).not.toThrow();
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
    // Idempotent on the same wrapper instance: no second listener (which would
    // eventually trip MaxListenersExceeded), because the wrapper identity is
    // unchanged.
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
    expect((listErr as Error).message).toContain("Malformed NAME packet");
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
    expect((putErr as Error).message).toContain("Malformed DATA packet");
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
      client: noDelayClient(),
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
    // "re-dialed the maximum 0 times" would misdescribe an exchange that never
    // reconnected at all.
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
    expect((err as Error).message).not.toContain("re-dialed the maximum");
    // Both remedies are still named by their operator-reachable names.
    expect((err as Error).message).toContain("--connection-per-poll");
    // No re-dial: the budget permits none, so only the initial connect ran.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(adapter.midExchangeReconnectCount).toBe(0);
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
      client: noDelayClient(),
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
      client: noDelayClient(),
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
    // A recovery aborted by teardown is not counted as a survived reconnection.
    expect(adapter.reconnectCount).toBe(0);
  });

  test("preserves the original rename error when the re-issue's exists() probe rejects", async () => {
    // rename()'s re-issue confirms a landed pre-drop rename via exists(dest); if
    // that probe itself rejects, the ambiguity is unresolved and the ORIGINAL
    // rename error must surface, not the probe's failure (mirrors
    // createExclusiveOnce's SFTPv3 fallback to the original openErr).
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
    // The original rename error (code 2), not the exists() rejection.
    expect((err as NodeJS.ErrnoException).code).toBe(2);
    expect((err as Error).message).toContain("No such file");
    expect(connect).toHaveBeenCalledTimes(2);
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
    // No re-dial and no count for the refused drop.
    expect(connect).toHaveBeenCalledTimes(4);
    expect(adapter.midExchangeReconnectCount).toBe(3);
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
    expect(adapter.midExchangeReconnectCount).toBe(2);
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
  // idle release. Private state with no public surface, read directly by the tests
  // below whose case -- a release that released nothing, or one during teardown --
  // leaves no behavior to read it through; each of those also asserts the behavior
  // wherever one exists.
  const releaseBoundaryStands = (adapter: SSH2SFTPClientAdapter) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((adapter as any).sessionBoundary as string) === "deliberatelyReleased";

  // The error ssh2-sftp-client's haveConnection() raises once its `sftp` property
  // has been cleared -- what every high-level op below rejects with on a released
  // session, so an op that reached the server without re-establishing first shows
  // up as a counted, warned re-dial rather than passing silently.
  const notConnected = (name: string) =>
    Object.assign(new Error(`${name}: No SFTP connection available`), {
      code: "ERR_NOT_CONNECTED",
    });

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
      delete: vi.fn(onLiveSession("delete", undefined)),
      rename: vi.fn(onLiveSession("rename", undefined)),
      exists: vi.fn(onLiveSession("exists", true)),
    };
    return { client, connect, state, rawClient, socket };
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
    };
    return { client, connect, state, rawClient };
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
    let failInFlight: ((error: unknown) => void) | undefined;
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: { setKeepAlive: vi.fn(), writableEnded: false, destroy: vi.fn() },
      end: vi.fn(() => {
        state.ending = true;
        state.live = false;
        failInFlight?.(notConnected("exists"));
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
            const answer = setTimeout(() => resolve(true), 0);
            failInFlight = (error: unknown) => {
              clearTimeout(answer);
              reject(error);
            };
          }),
      ),
    };
    return { client, connect, state, rawClient };
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

  test("an op after the idle release re-establishes, uncounted and unwarned", async () => {
    // The poll cycle releases the session at its idle boundary and a send driven
    // by the protocol continuation resumes into that gap, ahead of the next
    // cycle's ensureConnected. The op must re-establish the session the release
    // deliberately closed and complete -- a deliberate lifecycle transition is not
    // a session drop, so it must not reach the reconnect counters or the operator
    // warning that report one.
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
    expect(state.live).toBe(false);

    // No ensureConnected: this is the idle-gap op, not a cycle start.
    await expect(adapter.list("/remote/dir")).resolves.toEqual([]);

    expect(state.live).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
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
    expect(releaseBoundaryStands(adapter)).toBe(false);

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

  test("a release that finds no session does not latch (a tail-of-cycle drop stays a drop)", async () => {
    // releaseForIdle returns early when the session is ALREADY gone, which means
    // the server dropped it before the boundary -- a real drop the operator must
    // still see. Only the branch that drives the close latches, so this early
    // return leaves the next op's re-dial counted and warned.
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

    await expect(adapter.list("/remote/dir")).resolves.toEqual([]);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped mid-exchange"),
    );
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
    expect(releaseBoundaryStands(adapter)).toBe(false);
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
      expect(rawClient.listenerCount("close")).toBe(0);

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

      // The operator still hears about the partner that never closes, described as
      // what now happens rather than as the stall that used to follow.
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
    // SFTP_REDIAL_WARN_INTERVAL-th.
    vi.useFakeTimers();
    try {
      const { client, sock, rawClient } = withheldCloseClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      const warn = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      const cycles = SFTP_REDIAL_WARN_INTERVAL + 2;
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        const release = adapter.releaseForIdle();
        await vi.advanceTimersByTimeAsync(5_000);
        await release;
        await adapter.ensureConnected();
      }

      expect(sock.destroy).toHaveBeenCalledTimes(cycles);
      // Every cycle re-dialed, and none of them was reported as a drop.
      expect(adapter.reconnectCount).toBe(0);
      expect(warn).toHaveBeenCalledTimes(2);
      // The number in the line is the number of boundaries the sentence describes,
      // which is the end-of-run summary's total.
      expect(warn.mock.calls[1][0]).toContain(
        `${SFTP_REDIAL_WARN_INTERVAL} idle boundaries closed this way so far`,
      );
      // Each cycle's release installs and consumes its own close wait, so nothing
      // accumulates on the ssh2 Client the library keeps across reconnects.
      expect(rawClient.listenerCount("close")).toBe(0);
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
      expect(releaseBoundaryStands(adapter)).toBe(false);
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

  test("a release that finds the PEER tearing the connection down does not latch", async () => {
    // ssh2 emits 'end' on the peer's FIN and 'close' only after, and
    // ssh2-sftp-client's global 'end' listener leaves its session property set, so
    // a release can walk into a server-initiated teardown and find a session that
    // still reads live. Its end() closes nothing there -- the peer already did --
    // so latching would hand a genuine drop the release's own exemption and the
    // operator would never hear about it.
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

    expect(releaseBoundaryStands(adapter)).toBe(false);
    expect(state.live).toBe(false);

    // The next operation observes the cleared session, and it is reported as the
    // server-side drop it is.
    await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped mid-exchange"),
    );
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
    expect(releaseBoundaryStands(adapter)).toBe(false);
    expect(rawClient.listenerCount("close")).toBe(0);
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
    // recovery-wrapped, so it has no counter and no warning to protect; adding a
    // second such op is a deliberate edit of this list, not an omission.
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
    expect(adapter.midExchangeReconnectCount).toBe(1);

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

  test("a recovery re-dial waits the in-flight release out before dialing", async () => {
    // An operation already on the wire when the boundary falls is torn by the
    // release's own end(): ssh2-sftp-client clears the session and rejects it, so
    // it reaches the recovery path -- the one re-establishment that does not enter
    // through the gate. Dialing there, between the ssh2 Client's end() and its
    // 'close', hands the release's stale 'close' to the temp listeners connect()
    // installs and fails the handshake, charging a healthy exchange a re-dial
    // retry (or, at max_reconnect_attempts=0, failing the operation outright) for
    // a session the adapter closed on purpose.
    const { client, connect, state, rawClient } =
      midWireTearClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = { warn, trace: vi.fn(), error: vi.fn() };
    install(adapter, client);

    // No reconnection budget at all, so a handshake lost to the release's close
    // is terminal rather than quietly retried a second later.
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const op = adapter.exists("/remote/out.json");
    // The boundary falls with that operation outstanding.
    const release = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();

    await expect(op).resolves.toBe(true);
    await release;

    // The initial dial plus the re-dial that re-issued the torn operation, taken
    // after the close rather than across it.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(state.live).toBe(true);
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
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
    // teardown, and nothing was classified as a deliberate idle release.
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(releaseBoundaryStands(adapter)).toBe(false);
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
    // Two re-establishment paths can be parked on one release: the recovery re-dial
    // of the operation the release tore off the wire, and the gate of an operation
    // issued during the release, which re-establishes before its first attempt.
    // ssh2's Client.connect() on a still-writable socket ends the socket and
    // re-connects from its 'close', which kills the first handshake and rejects the
    // SECOND dial -- so a recovery that dialed alongside the other path would fail
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
        failInFlight?.(notConnected("exists"));
        failInFlight = undefined;
        setTimeout(() => rawClient.emit("close"), 0);
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
    // The boundary falls with that operation outstanding, and a second operation
    // is issued into the release window: one reaches the recovery path, the other
    // the gate, and both are parked on the same release.
    const release = adapter.releaseForIdle();
    const queued = adapter.exists("/remote/in.json");
    await Promise.all([release, torn, queued]);

    await expect(torn).resolves.toBe(true);
    await expect(queued).resolves.toBe(true);

    // One dial at a time, and only one re-establishment in total: the recovery
    // re-issued the torn operation on the session the gate had already dialed.
    expect(peakDialsInFlight).toBe(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
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
    // The recovery of the operation the release tore off the wire and the
    // teardown both queue behind that release, and the recovery queues FIRST, so
    // it reaches the front first -- with the teardown latch set behind it. Dialing
    // there is wrong twice over: a handshake runs against the teardown's
    // client.end() on the one shared Ssh2SftpClient, and ssh2-sftp-client's own
    // end() short-circuits on the cleared session, resolving WITHOUT ending the
    // ssh2 Client -- so close() returns while an SSH handshake still holds a
    // ref'd socket, and the CLI's clean close lingers for the dial's budget.
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
        failInFlight?.(notConnected("exists"));
        failInFlight = undefined;
        setTimeout(() => rawClient.emit("close"), 0);
      }),
    });
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
    // The boundary falls with that operation on the wire: the release publishes
    // itself, tears the operation, and owes a 'close' a macrotask later.
    const release = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    // Let the torn operation's rejection travel its promise chain into the
    // recovery path, so the recovery is parked on the release before the
    // teardown parks behind it. Draining microtasks cannot advance the release's
    // 'close', which lands on a macrotask, so the wait is still in flight here.
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    const closed = adapter.end();
    await Promise.allSettled([release, torn, closed]);

    expect(events).not.toContainEqual(
      expect.stringMatching(/^teardown:.*dialsInFlight=[1-9]/),
    );
    // Nothing was dialed at all: the recovery woke into a begun teardown and
    // turned back rather than establishing a session for close() to reclaim.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(events).not.toContain("dial:start");
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
  function landedOnTearClient(wrapper: ReturnType<typeof wrapperMethods>) {
    const state = { live: true, ending: false };
    const landed = new Set<string>();
    let failInFlight: ((error: unknown) => void) | undefined;
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: { setKeepAlive: vi.fn(), writableEnded: false, destroy: vi.fn() },
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
          reject(noSuchFile(name));
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
    return { client, connect, state, rawClient, landed };
  }

  test("a delete torn off the wire by the boundary resolves through its recovery resolver, uncounted and unwarned", async () => {
    // The one operation no entry gate can cover: it is already on the wire when
    // the idle boundary falls, so the release's own end() tears it. It must come
    // back through the recovery path -- re-dial, re-issue, and the delete
    // resolver reading the now-absent source as the landed attempt it was -- and
    // the boundary that tore it is this adapter's own, so nothing about it may
    // reach the reconnect counters or the operator warning.
    const { client, connect, rawClient, landed } =
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
    expect(rawClient.end).toHaveBeenCalledOnce();

    await expect(removal).resolves.toBeUndefined();
    await release;

    expect(landed.has("/remote/out.json")).toBe(true);
    // The initial dial plus the one re-establishment the recovery took after the
    // close, not across it.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a rename torn off the wire by the boundary resolves through its recovery resolver, uncounted and unwarned", async () => {
    // The same tear on the publish that matters most: a temp-file rename to its
    // final name. The re-issue sees the source gone, confirms the self-prefixed
    // destination present, and reports the landed publish as the success it was.
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
    expect(rawClient.end).toHaveBeenCalledOnce();

    await expect(publish).resolves.toBeUndefined();
    await release;

    expect(landed.has("/remote/id-0-12.json")).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
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
    expect(releaseBoundaryStands(adapter)).toBe(false);

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
    expect(releaseBoundaryStands(adapter)).toBe(false);

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
      (adapter as any).redialForRecovery() as Promise<boolean>,
    ).resolves.toBe(false);
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

  test("a transition on an idle queue still enters in the same tick, with no bound armed", async () => {
    // The ordinary path costs nothing: with the queue drained a transition enters
    // its critical section in THIS tick rather than a microtask later, which is
    // what a blanket race around the acquire would silently take away. It is
    // load-bearing (see the adapter's `pendingTransitions` field): an idle-boundary
    // release must have driven the ssh2 Client's end() by the time releaseForIdle()
    // returns, or an operation issued in the same tick is admitted onto the session
    // that release is about to tear down.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const released = adapter.releaseForIdle();
    // Read with no await between it and the call above.
    expect(rawClient.end).toHaveBeenCalledOnce();
    await expect(released).resolves.toBeUndefined();
  });

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
          (adapter as any).redialForRecovery() as Promise<boolean>,
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
        redialForRecovery: "resolved false",
        releaseForIdle: "resolved undefined",
        teardown: "resolved undefined",
      });
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
      // subset the log carries. A decline closed nothing, so it is not a forced
      // release and the two totals never share a tally.
      expect(adapter.declinedReleaseCount).toBe(cycles + 1);
      expect(adapter.forcedReleaseCount).toBe(0);
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
      expect(adapter.reconnectCount).toBe(0);
      expect(adapter.midExchangeReconnectCount).toBe(0);
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
      expect(adapterLog(adapter).warn).not.toHaveBeenCalled();
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
    return { client, rawClient, socket, state };
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

  test("end() surfaces the transport's own end() rejection, as an unbounded await did", async () => {
    const { client } = partnerThatNeverCloses({ closes: true });
    const { adapter } = loggedAdapter();
    install(adapter, client);
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    client.end = vi.fn().mockRejectedValue(new Error("Unexpected close event"));

    await expect(adapter.end()).rejects.toThrow("Unexpected close event");
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
