import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";

import WebSocket, { WebSocketServer as WsServer } from "ws";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getDiagnosticSink, setDiagnosticSink } from "@psilink/core";

import {
  DIAGNOSTICS_PER_RATE_LIMIT_WINDOW,
  DIAGNOSTIC_DETAIL_MAX_LENGTH,
  DIAGNOSTIC_RATE_LIMIT_WINDOW_MS,
  attachSignalingDiagnostics,
} from "@psilink/peerjs-broker/diagnostics";
import {
  SOCKET_RELEASE_TIMEOUT_MS,
  WebSocketServer,
} from "@psilink/peerjs-broker/services/webSocketServer/index";
import { CreatePeerServerWSOnly } from "@psilink/peerjs-broker";
import { Realm } from "@psilink/peerjs-broker/models/realm";

import type { AddressInfo } from "node:net";
import type { DiagnosticSink } from "@psilink/core";

// The sink behind the signaling server's `error` event: that a released socket
// reaches an operator-readable log line at all, that the line says which release
// path raised it, that a peer looping parse failures is shed rather than allowed
// to flood the log, and that the peer's own bytes arrive escaped so they cannot
// forge a line of their own. The release paths that RAISE these reports are
// covered in signalingServer.test.ts; what is measured here is what becomes of a
// report afterwards.

/** The broker's logger context, which is what marks its lines in a capture that
 * sees every prefixed logger in the process. */
const BROKER_LOG_CONTEXT = "peerjs-broker";

/** A payload that is not JSON and whose bytes the parser quotes back in its own
 * message: an ESC that would open an ANSI sequence, a CR/LF that would end the
 * log line, and a forged context behind them to head a line of the peer's own. */
/** Room for everything on a diagnostic line that is not the escaped detail: the
 * ISO timestamp, the level and context labels, and the fixed copy the detail is
 * appended to. Generous on purpose -- what the bound below is about is the
 * detail's own cap holding, not the width of the first-party text. */
const FIXED_LINE_ALLOWANCE = 200;

const HOSTILE_FRAME = "\u001b\r\n[forged] not json";

const cleanups: Array<() => Promise<void>> = [];

let capturedLines: Array<string>;
let priorSink: DiagnosticSink | undefined;

beforeEach(() => {
  capturedLines = [];
  priorSink = getDiagnosticSink();
  // Core's process-wide diagnostic sink is where a prefixed logger's output goes
  // once a consumer installs one, so it reads what the broker wrote without
  // stubbing the broker's own logger.
  setDiagnosticSink((_method, prefix, args) => {
    capturedLines.push([prefix, ...args.map((arg) => String(arg))].join(" "));
  });
});

afterEach(async () => {
  setDiagnosticSink(priorSink);
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()?.();
});

/** Only the broker's lines: the capture is process-wide, so another core logger
 * emitting during a test must not be read as a broker diagnostic. */
function brokerLines(): Array<string> {
  return capturedLines.filter((line) =>
    line.includes(`[${BROKER_LOG_CONTEXT}]`),
  );
}

interface Broker {
  port: number;
  wss: WebSocketServer;
}

/** A signaling server on a loopback HTTP server with the diagnostics sink
 * attached, which is the wiring `CreateInstanceWSOnly` ships. */
async function startBroker(
  opts: { coResidentUpgrade?: "answers" | "ignores" } = {},
): Promise<Broker> {
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    realm: new Realm(),
    config: { path: "/", key: "peerjs", concurrent_limit: 5000 },
  });
  attachSignalingDiagnostics(wss);

  if (opts.coResidentUpgrade !== undefined) {
    // Registered after the signaling server's own listener, so an upgrade it
    // declines is left for this one -- the shared dev server's shape.
    const adopter =
      opts.coResidentUpgrade === "answers"
        ? new WsServer({ noServer: true })
        : null;
    server.on("upgrade", (req, socket, head) => {
      if (req.url?.startsWith("/peerjs")) return;
      adopter?.handleUpgrade(req, socket, head, (adopted) => {
        adopted.on("error", () => {});
      });
    });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, wss };
}

function upgradeRequest(port: number, target: string): string {
  return [
    `GET ${target} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
}

/** A connection opened by hand that answers nothing, so what becomes of it is
 * the server's own doing. */
function openRawConnection(port: number): {
  send: (request: string) => void;
  reset: () => void;
} {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  cleanups.push(() => {
    socket.destroy();
    return Promise.resolve();
  });
  return {
    send: (request: string) => {
      if (socket.connecting)
        socket.once("connect", () => socket.write(request));
      else socket.write(request);
    },
    reset: () => {
      if (!socket.destroyed) socket.resetAndDestroy();
    },
  };
}

/** Register a client on the signaling path and resolve once the server answers
 * OPEN, so a frame sent afterwards reaches the registered-client message path. */
function connectRegistered(port: number, id: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/peerjs?key=peerjs&id=${id}&token=tok`,
    );
    cleanups.push(() => {
      ws.terminate();
      return Promise.resolve();
    });
    ws.on("message", (data: WebSocket.RawData) => {
      const parsed = JSON.parse(data.toString()) as { type?: unknown };
      if (parsed.type === "OPEN") resolve(ws);
    });
    ws.on("error", reject);
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("signaling diagnostics sink", () => {
  test("an upgrade no co-resident listener answered is reported, attributed", async () => {
    const broker = await startBroker({ coResidentUpgrade: "ignores" });
    openRawConnection(broker.port).send(upgradeRequest(broker.port, "/hmr"));

    await waitFor(() => brokerLines().length > 0);
    const [line] = brokerLines();
    expect(line).toContain("[unanswered-upgrade]");
    expect(line).toContain(
      "released an upgrade no co-resident listener answered",
    );
  });

  test("an error the release window catches is attributed apart from an unanswered upgrade", async () => {
    const broker = await startBroker({ coResidentUpgrade: "answers" });
    const raw = openRawConnection(broker.port);
    raw.send(upgradeRequest(broker.port, "/hmr"));

    // Reset inside the release window, which an adopter's answer does not close
    // -- the watch runs to the bound. A reset is what a peer that is killed, or
    // dropped by its network, leaves the server holding.
    await new Promise((resolve) => setTimeout(resolve, 100));
    raw.reset();

    await waitFor(() => brokerLines().length > 0);
    const [line] = brokerLines();
    expect(line).toContain("[released-socket]");
    expect(line).not.toContain("[unanswered-upgrade]");

    // The bound behind it has nothing left to reclaim, so no second report
    // follows for the same socket.
    await new Promise((resolve) =>
      setTimeout(resolve, SOCKET_RELEASE_TIMEOUT_MS + 200),
    );
    expect(brokerLines()).toHaveLength(1);
  });

  test("peer-controlled text in a parse failure reaches the sink escaped", async () => {
    const broker = await startBroker();
    const client = await connectRegistered(broker.port, "peer-escaping");

    client.send(HOSTILE_FRAME);

    await waitFor(() => brokerLines().length > 0);
    const [line] = brokerLines();
    expect(line).toContain("[client-frame]");
    // Escaped, not carried: no C0 control byte survives to the sink, so the peer
    // can neither drive a terminal sequence nor open a log line of its own.
    // eslint-disable-next-line no-control-regex -- the control bytes are the subject
    expect(line).not.toMatch(/[\u0000-\u001f]/);
    expect(line).toContain("\\x1b");
    expect(line).toContain("\\x0d\\x0a");
    // The forged context is still readable, as escaped text on this line rather
    // than at the head of one of its own.
    expect(line.indexOf("[forged]")).toBeGreaterThan(
      line.indexOf("[client-frame]"),
    );
  });

  test("a flood is shed at the rate limit and the shedding is itself reported", async () => {
    const broker = await startBroker();
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);

    const flood = 1_000;
    for (let sent = 0; sent < flood; sent += 1)
      broker.wss.emit(
        "error",
        new Error(`parse failure ${sent}`),
        "client-frame",
      );

    // The budget, plus one notice saying the rest of the window is being shed.
    // Nothing else: the notice cannot itself become the flood.
    expect(brokerLines()).toHaveLength(DIAGNOSTICS_PER_RATE_LIMIT_WINDOW + 1);
    expect(brokerLines().at(-1)).toContain("rate limited");

    clock.mockReturnValue(startedAt + DIAGNOSTIC_RATE_LIMIT_WINDOW_MS);
    broker.wss.emit("error", new Error("after the window"), "client-frame");

    const shed = flood - DIAGNOSTICS_PER_RATE_LIMIT_WINDOW;
    expect(brokerLines().at(-2)).toContain(`${shed} suppressed`);
    expect(brokerLines().at(-1)).toContain("after the window");
  });

  test("a diagnostic's detail is bounded, so one report cannot be the flood", async () => {
    const broker = await startBroker();
    // Bytes the display boundary rewrites to six characters each: the cap is
    // on what is WRITTEN, so a detail that costs six times its own length must
    // not spend six times the budget.
    const flooded = String.fromCodePoint(0x202e).repeat(100_000);

    broker.wss.emit("error", new Error(flooded), "client-frame");

    const [line] = brokerLines();
    expect(line.length).toBeLessThan(
      DIAGNOSTIC_DETAIL_MAX_LENGTH + FIXED_LINE_ALLOWANCE,
    );
    expect(line).toContain("...[truncated]");
  });

  test("the listener absorbs the event even when the sink throws", async () => {
    const broker = await startBroker();
    setDiagnosticSink(() => {
      throw new Error("the sink is broken");
    });

    // An `error` emitted with no listener is thrown rather than dropped, which
    // would end the process over an ordinary peer hang-up; a failing sink must
    // not put that back.
    expect(() =>
      broker.wss.emit("error", new Error("a peer hung up"), "client-socket"),
    ).not.toThrow();
  });

  test("the shipped instance wiring carries a report to the sink", async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    // The single builder the web app's mount and the standalone runner both go
    // through, driven rather than inspected: what is measured is that a report
    // raised inside it reaches the log.
    CreatePeerServerWSOnly(server, { path: "/", key: "peerjs" });

    const port = (server.address() as AddressInfo).port;
    const client = await connectRegistered(port, "peer-wiring");
    client.send("not json at all");

    await waitFor(() => brokerLines().length > 0);
    expect(brokerLines()[0]).toContain("[client-frame]");
  });
});
