import net from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  sanitizeErrorForDisplay,
} from "@psilink/core";

import {
  PEER_ANSWER_READ_MAX_BYTES,
  PEER_EXCERPT_MAX_BYTES,
  diagnosePeerAnswer,
  explainPeerIdentificationFailure,
  isPreIdentificationDialFailure,
  observePeerAnswer,
  peerProbeTargetFromConnectOptions,
} from "../../src/connection/sftpPeerIdentification";
import type { PeerAnswer } from "../../src/connection/sftpPeerIdentification";

// The diagnosis of a dial that died before the peer identified itself as an SSH
// server. The five peers the acceptance case names are DRIVEN rather than
// stubbed -- a real listener answering a real socket -- because what is being
// asserted is what arrives on a socket, which a stub would only restate: an HTTP
// error page, a TLS alert record, an accept-then-clean-close, an
// accept-then-reset, and a valid SSH identification string. The control against
// a real SSH server, whose banner these listeners only imitate, is the
// integration suite's probe against the SFTP test server.

const listeners: net.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    listeners
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

/** A listener that answers one connection the way `answer` says, on a port the
 * kernel picks. */
function peerAnswering(
  answer: (socket: net.Socket) => void,
): Promise<{ host: string; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      sockets.push(socket);
      // A reset peer's own socket errors on the write side; nothing here reads
      // it, and an unhandled 'error' would fail the file.
      socket.on("error", () => {});
      answer(socket);
    });
    listeners.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        host: "127.0.0.1",
        port:
          typeof address === "object" && address !== null ? address.port : 0,
      });
    });
  });
}

const HTTP_ERROR_PAGE =
  "HTTP/1.0 403 Forbidden\r\n" +
  "Content-Type: text/html\r\n" +
  "\r\n" +
  "<html><head><title>Tunnel or SSL Forbidden</title></head></html>\r\n";

/** A TLS record: content type 21 (alert), version 3.3, one fatal
 * handshake_failure alert. */
const TLS_ALERT_RECORD = Buffer.from([
  0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28,
]);

const BUDGET_MS = 2_000;

const rendered = (error: unknown): string => sanitizeErrorForDisplay(error);

describe("observePeerAnswer reads what answered the port", () => {
  test("names an HTTP response and carries its first bytes", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.end(HTTP_ERROR_PAGE),
    );
    const answer = await observePeerAnswer(endpoint, BUDGET_MS);
    expect(answer.kind).toBe("non-ssh");
    if (answer.kind !== "non-ssh") return;
    expect(answer.shape).toBe("http");
    expect(answer.excerpt).toContain("403 Forbidden");
    expect(answer.excerpt).toContain("Tunnel or SSL Forbidden");
  });

  test("names a TLS alert record", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.end(TLS_ALERT_RECORD),
    );
    const answer = await observePeerAnswer(endpoint, BUDGET_MS);
    expect(answer).toEqual({
      kind: "non-ssh",
      shape: "tls-alert",
      // latin1, so each byte the peer sent is one code point the display
      // boundary escapes back to the byte it was.
      excerpt: "\x15\x03\x03\x00\x02\x02\x28",
    });
  });

  test("reads an unrecognized answer as non-SSH without naming a shape", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.end("220 ftp.example.test FTP service ready\r\n"),
    );
    const answer = await observePeerAnswer(endpoint, BUDGET_MS);
    expect(answer.kind).toBe("non-ssh");
    if (answer.kind !== "non-ssh") return;
    expect(answer.shape).toBe("unrecognized");
  });

  test("distinguishes an accept-then-clean-close from a peer that sent bytes", async () => {
    const endpoint = await peerAnswering((socket) => socket.end());
    expect(await observePeerAnswer(endpoint, BUDGET_MS)).toEqual({
      kind: "closed-unanswered",
    });
  });

  test("reads an accept-then-reset as the same sent-nothing case", async () => {
    const endpoint = await peerAnswering((socket) => socket.resetAndDestroy());
    expect(await observePeerAnswer(endpoint, BUDGET_MS)).toEqual({
      kind: "closed-unanswered",
    });
  });

  test("reports a real identification string as an identified SSH server", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.end("SSH-2.0-OpenSSH_9.6p1\r\n"),
    );
    expect(await observePeerAnswer(endpoint, BUDGET_MS)).toEqual({
      kind: "identified",
    });
  });

  test("reads past the excerpt so a preamble ahead of the identification string does not decide it", async () => {
    const preamble = "authorized use only\r\n".repeat(8);
    expect(preamble.length).toBeGreaterThan(PEER_EXCERPT_MAX_BYTES);
    expect(preamble.length).toBeLessThan(PEER_ANSWER_READ_MAX_BYTES);
    const endpoint = await peerAnswering((socket) => {
      socket.write(preamble);
      socket.end("SSH-2.0-OpenSSH_9.6p1\r\n");
    });
    expect(await observePeerAnswer(endpoint, BUDGET_MS)).toEqual({
      kind: "identified",
    });
  });

  test("reads a preamble past the read bound as non-SSH, identification string and all", async () => {
    // The FAILING side of the bound above, driven because the copy is written
    // around it: a real SSH server whose banner outruns the read lands in the
    // non-SSH classification, so the operator's message states what the first
    // bytes carried rather than what the peer is.
    const preamble = "authorized use only\r\n".repeat(32);
    expect(preamble.length).toBeGreaterThan(PEER_ANSWER_READ_MAX_BYTES);
    const endpoint = await peerAnswering((socket) => {
      socket.write(preamble);
      socket.end("SSH-2.0-OpenSSH_9.6p1\r\n");
    });
    const answer = await observePeerAnswer(endpoint, BUDGET_MS);
    expect(answer.kind).toBe("non-ssh");
    if (answer.kind !== "non-ssh") return;
    expect(answer.shape).toBe("unrecognized");
  });

  test("reads an identification string that arrives after the budget as non-SSH", async () => {
    // The other half of the same bound: the deadline. A peer whose preamble
    // fits but whose identification string arrives late is classified on what
    // was read by then.
    const endpoint = await peerAnswering((socket) => {
      socket.write("authorized use only\r\n");
      // Unref'd: the case settles on the deadline, and nothing here should hold
      // the loop open waiting for a write whose whole point is arriving late.
      setTimeout(() => socket.end("SSH-2.0-OpenSSH_9.6p1\r\n"), 400).unref();
    });
    const answer = await observePeerAnswer(endpoint, 100);
    expect(answer.kind).toBe("non-ssh");
    if (answer.kind !== "non-ssh") return;
    expect(answer.shape).toBe("unrecognized");
  });

  test("bounds the excerpt and stops reading against a peer answering with megabytes", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.write(
        "HTTP/1.0 500 Internal Server Error\r\n" + "X".repeat(4_000_000),
      ),
    );
    const answer = await observePeerAnswer(endpoint, BUDGET_MS);
    expect(answer.kind).toBe("non-ssh");
    if (answer.kind !== "non-ssh") return;
    expect(answer.excerpt.length).toBe(PEER_EXCERPT_MAX_BYTES);
  });

  test("establishes nothing when the connection is refused", async () => {
    // A port nothing listens on: bound, then released before the read.
    const endpoint = await peerAnswering(() => {});
    await new Promise<void>((resolve) =>
      listeners.splice(0)[0].close(() => resolve()),
    );
    expect(await observePeerAnswer(endpoint, BUDGET_MS)).toEqual({
      kind: "unobserved",
    });
  });

  test("establishes nothing from a peer that accepts and then holds the connection open", async () => {
    const endpoint = await peerAnswering(() => {});
    expect(await observePeerAnswer(endpoint, 150)).toEqual({
      kind: "unobserved",
    });
  });
});

describe("isPreIdentificationDialFailure gates on the stack's own wording", () => {
  test("recognizes a rejection a re-raise kept as its cause", () => {
    // The gate reads a chain rather than one message, so a diagnostic that
    // replaced the message and kept the stack's own rejection behind it -- the
    // shape every re-raise on the dial paths composes -- stays matched.
    const rejection = new Error(
      "getConnection: Connection lost before handshake",
    );
    const wrapped = new Error("the SFTP dial failed", { cause: rejection });
    expect(isPreIdentificationDialFailure(wrapped)).toBe(true);
  });

  test("recognizes a reset at accept", () => {
    expect(
      isPreIdentificationDialFailure(
        new Error("getConnection: connect ECONNRESET 10.0.0.4:22"),
      ),
    ).toBe(true);
  });

  test("leaves an unreachable host to the rejection it already has", () => {
    expect(
      isPreIdentificationDialFailure(
        new Error("getConnection: connect ECONNREFUSED 10.0.0.4:22"),
      ),
    ).toBe(false);
  });

  test("does not loop on a cause chain that revisits a link", () => {
    const looped = new Error("outer");
    Object.defineProperty(looped, "cause", { value: looped });
    expect(isPreIdentificationDialFailure(looped)).toBe(false);
  });
});

describe("explainPeerIdentificationFailure partitions the peer's bytes", () => {
  const endpoint = { host: "sftp.example.test", port: 2222 };
  const dialRejection = new Error(
    "could not read the server's host key: getConnection: Connection lost " +
      "before handshake",
  );

  test("leaves the rejection alone when the peer identified itself", () => {
    expect(
      explainPeerIdentificationFailure(
        dialRejection,
        { kind: "identified" },
        endpoint,
      ),
    ).toBe(dialRejection);
  });

  test("leaves the rejection alone when nothing was established", () => {
    expect(
      explainPeerIdentificationFailure(
        dialRejection,
        { kind: "unobserved" },
        endpoint,
      ),
    ).toBe(dialRejection);
  });

  test("names the firewall case without an excerpt and keeps the rejection", () => {
    const explained = explainPeerIdentificationFailure(
      dialRejection,
      { kind: "closed-unanswered" },
      endpoint,
    );
    const text = rendered(explained);
    expect(text).toContain("closed it having sent nothing");
    expect(text).toContain("source-IP allowlist");
    expect(text).toContain("sftp.example.test:2222");
    expect(text).toContain("Connection lost before handshake");
    expect(text).not.toContain("first bytes the peer sent");
    // Nothing here is anyone else's bytes, so nothing here may be cut: the cap
    // applies to first-party copy exactly as it does to a peer's.
    expect(text).not.toContain(DISPLAY_TRUNCATION_MARKER);
  });

  test("a clean close and a reset take one message, the stack's wording behind it", () => {
    const closeText = rendered(
      explainPeerIdentificationFailure(
        new Error("getConnection: Connection lost before handshake"),
        { kind: "closed-unanswered" },
        endpoint,
      ),
    );
    const resetText = rendered(
      explainPeerIdentificationFailure(
        new Error("getConnection: connect ECONNRESET 10.0.0.4:22"),
        { kind: "closed-unanswered" },
        endpoint,
      ),
    );
    const firstLine = (text: string): string => text.split("\n")[0];
    expect(firstLine(closeText)).toBe(firstLine(resetText));
    expect(closeText).toContain("Connection lost before handshake");
    expect(resetText).toContain("ECONNRESET");
  });

  test("gives the peer's bytes a display link of their own", () => {
    const answer: PeerAnswer = {
      kind: "non-ssh",
      shape: "http",
      excerpt: "HTTP/1.0 403 Forbidden",
    };
    const links = rendered(
      explainPeerIdentificationFailure(dialRejection, answer, endpoint),
    ).split("\ncaused by: ");
    expect(links[0]).toContain("an HTTP response");
    expect(links).toContain(
      "first bytes the peer sent: HTTP/1.0 403 Forbidden",
    );
    expect(
      links.some((link) => link.startsWith("Check that the configured")),
    ).toBe(true);
  });

  // Every shape, because each names its own likely cause and they are not the
  // same length: the longest summary is the one the display cap binds first.
  test.each(["http", "tls-alert", "unrecognized"] as const)(
    "the first-party text survives a maximally long peer excerpt (%s)",
    (shape) => {
      // Every byte escaping to four display characters, at the excerpt bound: the
      // longest a peer's link can render, and the excerpt is what truncates.
      const excerpt = "\x00".repeat(PEER_EXCERPT_MAX_BYTES);
      const links = rendered(
        explainPeerIdentificationFailure(
          dialRejection,
          { kind: "non-ssh", shape, excerpt },
          endpoint,
        ),
      ).split("\ncaused by: ");
      const summary = links[0];
      expect(summary).toContain("did not identify itself");
      // What the peer's first bytes carried, which is what was read -- not a
      // verdict on what the peer is, which the bounded read cannot establish.
      expect(summary).toContain("the first bytes the peer");
      expect(summary).toContain("not an SSH identification string");
      expect(summary.length).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH);
      const guidance = links.find((link) =>
        link.startsWith("Check that the configured"),
      );
      expect(guidance).toBeDefined();
      // The recovery step names the read bound the verdict rests on, so an
      // operator whose server has a long banner can recognize their own case.
      expect(guidance).toContain(String(PEER_ANSWER_READ_MAX_BYTES));
      expect(links.some((link) => link.includes("no credential"))).toBe(true);
      expect(links).toContain(
        `configured endpoint: ${endpoint.host}:${endpoint.port}`,
      );
      const peerLink = links.find((link) =>
        link.startsWith("first bytes the peer sent:"),
      );
      expect(peerLink).toBeDefined();
      expect(peerLink).toContain("\\x00");
      expect(peerLink?.length).toBeLessThanOrEqual(
        DEFAULT_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length,
      );
      // The peer's own link is the ONLY one its bytes can spend: every link the
      // operator has to act on renders whole beside a peer flooding its own.
      expect(
        links.filter((link) => link.includes(DISPLAY_TRUNCATION_MARKER)),
      ).toEqual([peerLink]);
    },
  );

  test("escapes the peer's control bytes rather than letting them reach the terminal", () => {
    const text = rendered(
      explainPeerIdentificationFailure(
        dialRejection,
        {
          kind: "non-ssh",
          shape: "unrecognized",
          excerpt: "\x1b[2Jcleared\r\nfaked line",
        },
        endpoint,
      ),
    );
    expect(text).toContain("\\x1b[2Jcleared\\x0d\\x0afaked line");
    expect(text).not.toContain("\x1b");
  });
});

describe("peerProbeTargetFromConnectOptions follows the dial it diagnoses", () => {
  // Every dial enters the dial sequence with ssh2's connect options and never
  // with the config behind them, so this is the one derivation of the endpoint.
  // The port a portless dial reaches is not written here: it is whatever the
  // pinned stack dials, and the integration premise reads that off a portless
  // dial's own rejection and holds this to it, where a number written here would
  // be a second premise nothing checks.
  test("reads the endpoint the connect options carry", () => {
    expect(
      peerProbeTargetFromConnectOptions({
        host: "sftp.example.test",
        port: 2222,
      }),
    ).toEqual({ host: "sftp.example.test", port: 2222 });
  });

  test("reproduces no endpoint from options that name none", () => {
    // A dial this cannot follow: reading some other endpoint would report about
    // a peer it never spoke to, so the caller keeps the rejection it had.
    expect(peerProbeTargetFromConnectOptions({})).toBeUndefined();
    expect(peerProbeTargetFromConnectOptions({ host: "" })).toBeUndefined();
    expect(
      peerProbeTargetFromConnectOptions({
        host: "sftp.example.test",
        port: "2222",
      }),
    ).toBeUndefined();
  });
});

describe("diagnosePeerAnswer says what it read, or nothing", () => {
  // The read and the composition together, as the adapter's dial sequence calls
  // them once its gate has admitted a rejection. The gate itself is above; that
  // the adapter is the only caller, and reads the peer once per diagnosed
  // failure however the dial was entered, is driven over real dials in
  // test/integration/dialPeerIdentification.test.ts.
  const rejection = (): Error =>
    new Error("getConnection: Connection lost before handshake");

  test("names what the live peer answered with, on the endpoint it read", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.end(HTTP_ERROR_PAGE),
    );
    const text = rendered(
      await diagnosePeerAnswer(rejection(), endpoint, undefined),
    );
    expect(text).toContain("an HTTP response");
    expect(text).toContain("403 Forbidden");
    expect(text).toContain(`configured endpoint: 127.0.0.1:${endpoint.port}`);
  });

  test("returns the rejection when the peer turns out to be an SSH server", async () => {
    const endpoint = await peerAnswering((socket) =>
      socket.end("SSH-2.0-OpenSSH_9.6p1\r\n"),
    );
    const dialFailure = rejection();
    expect(await diagnosePeerAnswer(dialFailure, endpoint, undefined)).toBe(
      dialFailure,
    );
  });

  test("clamps the read to the connect budget the dial ran under", async () => {
    // A peer that accepts and holds the connection open with nothing on it, so
    // only a deadline ends the read: a run that shortened its connect gets the
    // shorter deadline, not the read's own default. The margin is wide because
    // what is asserted is which of the two budgets bounded it.
    const endpoint = await peerAnswering(() => {});
    const started = Date.now();
    const dialFailure = rejection();
    expect(await diagnosePeerAnswer(dialFailure, endpoint, 200)).toBe(
      dialFailure,
    );
    expect(Date.now() - started).toBeLessThan(BUDGET_MS / 2);
  });
});
