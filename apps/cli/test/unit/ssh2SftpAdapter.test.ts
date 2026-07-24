import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  DirectoryListingBoundsError,
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
    (adapter as any).log = { warn: vi.fn(), trace: vi.fn(), error: vi.fn() };
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
    // drop fails terminally with the actionable budget-exhausted message and no
    // re-dial is even attempted. Terminal (a UsageError) so the caller maps it to a
    // non-zero exit, never a silent resolve or hang.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    state.live = false;

    const err = await adapter.list("/remote/dir").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain("max_reconnect_attempts=0");
    expect((err as Error).message).toContain("reconnection budget");
    // No re-dial: the budget was already spent, so only the initial connect ran.
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
    // whose fresh session would outlive teardown.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    stub(adapter);
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
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
    // (c) names the real remedy under the current single-session model -- the
    //     planned connection-per-poll mode -- and is honest that a longer poll
    //     interval helps only for a query-frequency reaction
    expect(message).toContain("--polling-frequency");
    expect(message).toContain("connection-per-poll");
    // (d) does NOT repeat the stale, inaccurate claim that raising the poll
    //     interval holds the session open less often (it does not: one session is
    //     held open for the whole exchange regardless of poll cadence)
    expect(message).not.toContain("held open less often");
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
    // Names the partner-server drop and both remedies.
    expect((err as Error).message).toContain("session-duration or idle limit");
    expect((err as Error).message).toContain("connection-per-poll");
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
    (adapter as any).log = { warn: vi.fn(), trace: vi.fn(), error: vi.fn() };
  };
  const install = (adapter: SSH2SFTPClientAdapter, client: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = client;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapterLog = (adapter: SSH2SFTPClientAdapter) => (adapter as any).log;

  // A droppable client whose underlying ssh2 Client is a real EventEmitter: its
  // end() clears the session (state.live=false) and emits 'close', modeling the
  // ssh2-sftp-client global 'close' listener that clears this.sftp when the
  // connection closes. connect() restores the session. This lets releaseForIdle's
  // "drive the ssh2 Client's end() and await its 'close'" path run against a
  // faithful stand-in without a live server.
  function ephemeralClient(wrapper: ReturnType<typeof wrapperMethods>) {
    const state = { live: true };
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: { setKeepAlive: vi.fn() },
      end: vi.fn(() => {
        state.live = false;
        rawClient.emit("close");
      }),
    });
    const connect = vi.fn().mockImplementation(async () => {
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

  test("within-cycle recovery is NOT bounded by the mid-exchange reconnection cap", async () => {
    // The cumulative cap applies only to the default held-session mode.
    // Connection-per-poll holds no session across the idle gap, so its within-cycle
    // recovery floor is uncapped by the count (bounded instead by the
    // peer-inactivity ceiling): more within-cycle drops than max_reconnect_attempts
    // still recover, where the default mode would have failed terminally.
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
    // All three within-cycle drops recovered past the default cap.
    expect(connect).toHaveBeenCalledTimes(4); // initial + 3 recoveries
    // They still count as mid-exchange recoveries -- only the CAP is off in this mode.
    expect(adapter.midExchangeReconnectCount).toBe(3);
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
      client: noDelayClient(),
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
      client: noDelayClient(),
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
    const { client, connect, rawClient } = ephemeralClient(wrapper);
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
    // end(), clearing this.sftp) and the next cycle's re-dial (ensureConnected) are
    // its designed behavior, NOT a server-forced mid-exchange drop. ensureConnected
    // re-dials at cycle start, repopulating this.sftp BEFORE any op's
    // withSessionRecovery could observe the cleared session as a loss -- so the
    // intentional release must never increment the mid-exchange recovery counter or
    // fire the recovery WARN (reserved for a genuine unexpected drop the operator
    // should see). Proven across several cycles, each running a real op against the
    // freshly re-dialed session so the within-cycle recovery path would show up if
    // the boundary were mistaken for a drop.
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

    // The designed release + re-dial is invisible to the recovery accounting: no
    // server-forced drop happened, so the mid-exchange sub-count stays zero (and no
    // internal connect-retry bumped the merged total either).
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(adapter.reconnectCount).toBe(0);
    // ... and the recovery WARN never fired: no message names a transparently
    // re-dialed mid-exchange drop. (connect() called once per cycle to re-dial,
    // never via the recovery path.)
    const recoveryWarns = warn.mock.calls.filter((c) =>
      (c[0] as string).includes("transparently"),
    );
    expect(recoveryWarns).toEqual([]);
    // Initial dial plus one re-dial per cycle -- all through ensureConnected, none
    // through withSessionRecovery.
    expect(connect).toHaveBeenCalledTimes(4);
  });

  test("two concurrent ensureConnected calls open a single connect (serialized)", async () => {
    // poll()'s cycle-start ensureConnected and close()'s pre-drain ensureConnected
    // can fire concurrently; both must not open a parallel connect() on the one
    // shared Ssh2SftpClient (it shares connection-level listeners, so two handshakes
    // at once is unsafe). The second call must serialize behind the first's
    // published re-dial and observe the now-live session rather than dialing again.
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
      client: noDelayClient(),
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
});
