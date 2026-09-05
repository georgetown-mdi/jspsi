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
import type { IRealm } from "@psilink/peerjs-broker/models/realm";

// The sink behind the signaling server's `error` event: that a released socket
// reaches an operator-readable log line at all, that the line says which release
// path raised it, that a peer looping parse failures is shed rather than allowed
// to flood the log and the notices name which classes lost reports, and that the
// peer's own bytes arrive escaped so they cannot forge a line of their own. The
// release paths that RAISE these reports are covered in signalingServer.test.ts;
// what is measured here is what becomes of a report afterwards.

/** The broker's logger context, which is what marks its lines in a capture that
 * sees every prefixed logger in the process. */
const BROKER_LOG_CONTEXT = "peerjs-broker";

/** Room for everything on a diagnostic line that is not the escaped detail: the
 * ISO timestamp, the level and context labels, and the fixed copy the detail is
 * appended to. Generous on purpose -- what the bound below is about is the
 * detail's own cap holding, not the width of the first-party text. */
const FIXED_LINE_ALLOWANCE = 200;

/** A C0 control byte, none of which may survive to a line the sink wrote: CR/LF
 * would end it and let whatever follows head a line of its own, and ESC would
 * open an ANSI sequence in the operator's terminal. */
// eslint-disable-next-line no-control-regex -- the control bytes are the subject
const CONTROL_BYTE = /[\u0000-\u001f]/;

/** A payload that is not JSON and whose bytes the parser quotes back in its own
 * message: an ESC that would open an ANSI sequence, a CR/LF that would end the
 * log line, and a forged context behind them to head a line of the peer's own. */
const HOSTILE_FRAME = "\u001b\r\n[forged] not json";

/** The same shape as a SOURCE rather than a frame. `emit` is untyped, so a raise
 * can hand the sink any string at all; one holding control bytes is what would
 * drive a terminal sequence or head a line of its own were the source written
 * into the line rather than resolved to a tag this sink knows. */
const HOSTILE_SOURCE = "\u001b\r\n[forged] not-a-real-source";

/** The pair a relay round trip runs between: the peer whose socket raises the
 * diagnostic, and the peer it addresses once the sink has thrown on it. */
const RELAY_SENDER_ID = "peer-relay-sender";
const RELAY_DESTINATION_ID = "peer-relay-destination";

/** A signaling payload of the shape a real offer has, so the frame the relay
 * moves across is one an exchange would produce. */
const OFFER_PAYLOAD = {
  sdp: { type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n" },
  type: "data",
  connectionId: "dc_9c1d",
};

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
 * emitting during a test must not be treated as a broker diagnostic. */
function brokerLines(): Array<string> {
  return capturedLines.filter((line) =>
    line.includes(`[${BROKER_LOG_CONTEXT}]`),
  );
}

interface Broker {
  port: number;
  wss: WebSocketServer;
}

interface SignalingFrame {
  type?: unknown;
  src?: unknown;
  payload?: unknown;
}

/** Stop a loopback HTTP server at the end of the test that started it. */
function closeWithTest(server: http.Server): void {
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
}

/** A co-resident `upgrade` listener beside the signaling server -- the shared
 * dev server's shape, and the only wiring in which an upgrade this server
 * declines is left for somebody. Registered after the signaling server's own
 * listener, since what is being driven is what becomes of an upgrade it
 * declined. */
function attachCoResidentUpgrade(
  server: http.Server,
  behavior: "answers" | "ignores",
): void {
  const adopter =
    behavior === "answers" ? new WsServer({ noServer: true }) : null;
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/peerjs")) return;
    adopter?.handleUpgrade(req, socket, head, (adopted) => {
      adopted.on("error", () => {});
    });
  });
}

/** A signaling server whose `error` event a test raises on directly, for what a
 * real socket cannot drive on demand: the budget, the window's clock, and a
 * source no raise site of this server's would pass. */
async function startBroker(): Promise<Broker> {
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    realm: new Realm(),
    config: { path: "/", key: "peerjs", concurrent_limit: 5000 },
  });
  attachSignalingDiagnostics(wss);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closeWithTest(server);
  return { port: (server.address() as AddressInfo).port, wss };
}

/** A signaling server built by `CreatePeerServerWSOnly` -- the single builder
 * the web app's mount and the standalone runner both go through -- so a test
 * driving a real socket at it measures the shipped wiring rather than a
 * restatement of it. */
async function startShippedBroker(
  opts: { coResidentUpgrade?: "answers" | "ignores" } = {},
): Promise<{ port: number; realm: IRealm }> {
  const server = http.createServer();
  const { realm } = CreatePeerServerWSOnly(server, {
    path: "/",
    key: "peerjs",
  });
  if (opts.coResidentUpgrade !== undefined)
    attachCoResidentUpgrade(server, opts.coResidentUpgrade);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closeWithTest(server);
  return { port: (server.address() as AddressInfo).port, realm };
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

interface RegisteredPeer {
  ws: WebSocket;
  /** Every frame the server sent this socket, in arrival order. Collected from
   * the moment it opens, so a frame the server relays to it cannot be missed
   * between the OPEN and the first assertion. */
  frames: Array<SignalingFrame>;
}

/** Register a client on the signaling path and resolve once the server answers
 * OPEN, so a frame sent afterwards reaches the registered-client message path,
 * collecting what the server sends it. */
function connectCollecting(port: number, id: string): Promise<RegisteredPeer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/peerjs?key=peerjs&id=${id}&token=tok`,
    );
    cleanups.push(() => {
      ws.terminate();
      return Promise.resolve();
    });
    const frames: Array<SignalingFrame> = [];
    ws.on("message", (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as SignalingFrame;
      frames.push(frame);
      if (frame.type === "OPEN") resolve({ ws, frames });
    });
    ws.on("error", reject);
  });
}

/** The socket alone, for a test that only sends on it. */
async function connectRegistered(port: number, id: string): Promise<WebSocket> {
  return (await connectCollecting(port, id)).ws;
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
    const broker = await startShippedBroker({ coResidentUpgrade: "ignores" });
    openRawConnection(broker.port).send(upgradeRequest(broker.port, "/hmr"));

    await waitFor(() => brokerLines().length > 0);
    const [line] = brokerLines();
    expect(line).toContain("[unanswered-upgrade]");
    expect(line).toContain(
      "released an upgrade no co-resident listener answered",
    );
  });

  test("an error the release window catches is attributed apart from an unanswered upgrade", async () => {
    const broker = await startShippedBroker({ coResidentUpgrade: "answers" });
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
    // Escaped, not passed through: no C0 control byte survives to the sink, so the peer
    // can neither drive a terminal sequence nor open a log line of its own.
    expect(line).not.toMatch(CONTROL_BYTE);
    expect(line).toContain("\\x1b");
    expect(line).toContain("\\x0d\\x0a");
    // The forged context is still readable, as escaped text on this line rather
    // than at the head of one of its own.
    expect(line.indexOf("[forged]")).toBeGreaterThan(
      line.indexOf("[client-frame]"),
    );
  });

  test("a fault dispatching a parsed frame is attributed apart from the parse", async () => {
    const broker = await startBroker();
    broker.wss.on("message", () => {
      throw new Error("a message listener faulted");
    });
    const client = await connectRegistered(broker.port, "peer-dispatch");

    // A frame that parses, so what throws is this server's own dispatch rather
    // than the peer's bytes. It is absorbed rather than let out: `ws` calls the
    // message handler from inside its own receiver, where a throw is an uncaught
    // exception and the end of the broker.
    client.send(JSON.stringify({ type: "OFFER", dst: "nobody" }));

    await waitFor(() => brokerLines().length > 0);
    const [line] = brokerLines();
    expect(line).toContain("[frame-dispatch]");
    expect(line).toContain("a message listener faulted");
    expect(line).not.toContain("[client-frame]");

    // And a frame that does not parse is still the peer's, the listener above
    // never being reached by one.
    client.send("not json at all");
    await waitFor(() => brokerLines().length > 1);
    expect(brokerLines()[1]).toContain("[client-frame]");
  });

  test("a frame that parses to null or a primitive is absorbed under client-frame, the peer staying registered", async () => {
    const broker = await startBroker();
    const client = await connectRegistered(broker.port, "peer-null-primitive");

    client.send("null");
    await waitFor(() => brokerLines().length > 0);
    expect(brokerLines()[0]).toContain("[client-frame]");

    client.send("5");
    await waitFor(() => brokerLines().length > 1);
    expect(brokerLines()[1]).toContain("[client-frame]");

    // The socket survives both throws and keeps producing attributed
    // diagnostics: a further real parse failure still lands as this socket's
    // own [client-frame] line.
    client.send("not json at all");
    await waitFor(() => brokerLines().length > 2);
    expect(brokerLines()[2]).toContain("[client-frame]");
  });

  test("a dispatch fault through the real realm wiring -- a non-string destination id queued for an absent destination -- is attributed apart from the parse", async () => {
    const broker = await startShippedBroker();
    const client = await connectRegistered(broker.port, "peer-realdispatch");

    // An OFFER addressed to a destination id that is not a string: nobody has
    // registered it, and `realm.addMessageToQueue` cannot size a frame holding
    // it -- `serializeFrame` throws inside it before the frame is ever queued,
    // so what shows up here is the shipped wiring's own fault rather than a
    // listener this test attached.
    client.send(
      JSON.stringify({
        type: "OFFER",
        dst: { not: "a string" },
      }),
    );

    await waitFor(() => brokerLines().length > 0);
    const [line] = brokerLines();
    expect(line).toContain("[frame-dispatch]");
    expect(line).not.toContain("[client-frame]");

    // The socket survives the dispatch fault and keeps producing attributed
    // diagnostics: a parse failure right after still lands as this socket's
    // own [client-frame] line, not one the fault tore down.
    client.send("not json at all");
    await waitFor(() => brokerLines().length > 1);
    expect(brokerLines()[1]).toContain("[client-frame]");
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

    // The budget is one budget across every source, so a release the window
    // caught mid-flood is shed on what the flood spent. That is the starvation
    // the breakdown below exists to name: the operator cannot see the alarm, so
    // the notices have to tell them which alarm it was.
    const starved = 2;
    for (let sent = 0; sent < starved; sent += 1)
      broker.wss.emit("error", new Error(`reset ${sent}`), "released-socket");

    // The budget, plus one notice saying the rest of the window is being shed.
    // Nothing else: the notice cannot itself become the flood.
    expect(brokerLines()).toHaveLength(DIAGNOSTICS_PER_RATE_LIMIT_WINDOW + 1);
    expect(brokerLines().at(-1)).toContain("rate limited");
    expect(brokerLines().at(-1)).toContain(
      "suppressed so far (client-frame: 1)",
    );

    clock.mockReturnValue(startedAt + DIAGNOSTIC_RATE_LIMIT_WINDOW_MS);
    broker.wss.emit("error", new Error("after the window"), "client-frame");

    const shedFrames = flood - DIAGNOSTICS_PER_RATE_LIMIT_WINDOW;
    expect(brokerLines().at(-2)).toContain(
      `${shedFrames + starved} suppressed while rate limited (client-frame: ${shedFrames}, released-socket: ${starved})`,
    );
    expect(brokerLines().at(-1)).toContain("after the window");
  });

  test("a clock stepped backwards keeps shedding until it has caught back up", async () => {
    // Mocked before construction: the sink snapshots windowStartedAt
    // synchronously inside attachSignalingDiagnostics, which construction calls,
    // so mocking after would leave that snapshot on the real clock while every
    // step below runs on the controlled one -- a gap of even one millisecond
    // between them is enough to put windowStartedAt ahead of startedAt and break
    // the "still inside the window" assertions.
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const broker = await startBroker();

    for (let sent = 0; sent <= DIAGNOSTICS_PER_RATE_LIMIT_WINDOW; sent += 1)
      broker.wss.emit(
        "error",
        new Error(`parse failure ${sent}`),
        "client-frame",
      );
    const atTheLimit = brokerLines().length;
    expect(atTheLimit).toBe(DIAGNOSTICS_PER_RATE_LIMIT_WINDOW + 1);

    // A whole window backwards, which a sink that read the step as a new window
    // would answer by handing the flood a fresh budget.
    clock.mockReturnValue(startedAt - DIAGNOSTIC_RATE_LIMIT_WINDOW_MS);
    broker.wss.emit("error", new Error("stepped back"), "client-frame");
    expect(brokerLines()).toHaveLength(atTheLimit);

    // Shed right up to the reading the window was opened against, so what the
    // step costs is silence for its own length on top of the window's.
    clock.mockReturnValue(startedAt + DIAGNOSTIC_RATE_LIMIT_WINDOW_MS - 1);
    broker.wss.emit("error", new Error("not caught up yet"), "client-frame");
    expect(brokerLines()).toHaveLength(atTheLimit);

    clock.mockReturnValue(startedAt + DIAGNOSTIC_RATE_LIMIT_WINDOW_MS);
    broker.wss.emit("error", new Error("caught up"), "client-frame");
    expect(brokerLines().at(-2)).toContain(
      "3 suppressed while rate limited (client-frame: 3)",
    );
    expect(brokerLines().at(-1)).toContain("caught up");
  });

  test("a report whose source names nothing this sink knows is written unattributed", async () => {
    const broker = await startBroker();

    // `emit` is untyped, so a raise can hand the sink any source at all -- and a
    // source it cannot render is exactly the raise whose report an operator has
    // nothing else to read.
    broker.wss.emit("error", new Error("raised under no known source"), {});

    const [line] = brokerLines();
    expect(line).toContain("[unattributed]");
    expect(line).toContain("raised under no known source");

    // The slot it spent is a slot it used: the rest of the budget writes, and
    // the report past it is shed rather than admitted on a slot a dropped
    // diagnostic had already charged.
    for (let sent = 1; sent < DIAGNOSTICS_PER_RATE_LIMIT_WINDOW; sent += 1)
      broker.wss.emit(
        "error",
        new Error(`parse failure ${sent}`),
        "client-frame",
      );
    expect(brokerLines()).toHaveLength(DIAGNOSTICS_PER_RATE_LIMIT_WINDOW);

    broker.wss.emit("error", new Error("past the budget"), "client-frame");
    expect(brokerLines()).toHaveLength(DIAGNOSTICS_PER_RATE_LIMIT_WINDOW + 1);
    expect(brokerLines().at(-1)).toContain("rate limited");
  });

  test("a report whose source is an unrecognized string is written unattributed", async () => {
    const broker = await startBroker();

    // A string is exactly as untyped a source as the non-string shape above --
    // one that names nothing this sink knows must render under the same tag,
    // and a hostile one must not put its own bytes into the line at all.
    broker.wss.emit(
      "error",
      new Error("raised under an unrecognized string source"),
      HOSTILE_SOURCE,
    );

    const [line] = brokerLines();
    expect(line).toContain("[unattributed]");
    expect(line).toContain("raised under an unrecognized string source");
    // What the tag is worth: none of the bytes the raise chose reach the line,
    // so an unknown source can neither drive a terminal sequence nor head a
    // line of its own, escaped or otherwise.
    expect(line).not.toMatch(CONTROL_BYTE);
    expect(line).not.toContain("[forged]");

    // The slot it spent is a slot it used: the rest of the budget writes, and
    // the report past it is shed rather than admitted on a slot a dropped
    // diagnostic had already charged.
    for (let sent = 1; sent < DIAGNOSTICS_PER_RATE_LIMIT_WINDOW; sent += 1)
      broker.wss.emit(
        "error",
        new Error(`parse failure ${sent}`),
        "client-frame",
      );
    expect(brokerLines()).toHaveLength(DIAGNOSTICS_PER_RATE_LIMIT_WINDOW);

    broker.wss.emit("error", new Error("past the budget"), "client-frame");
    expect(brokerLines()).toHaveLength(DIAGNOSTICS_PER_RATE_LIMIT_WINDOW + 1);
    expect(brokerLines().at(-1)).toContain("rate limited");
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

  test("a peer whose report threw in the sink stays registered and keeps relaying", async () => {
    const broker = await startShippedBroker();
    const sender = await connectCollecting(broker.port, RELAY_SENDER_ID);
    const destination = await connectCollecting(
      broker.port,
      RELAY_DESTINATION_ID,
    );

    // The sink throws from inside the socket's own message handler, where `ws`
    // has nothing between it and the receiver: an escaped throw would end the
    // process, and the registration this peer's rendezvous depends on with it.
    let reachedSink = 0;
    setDiagnosticSink(() => {
      reachedSink += 1;
      throw new Error("the sink is broken");
    });

    sender.ws.send("not json at all");
    await waitFor(() => reachedSink > 0);

    // The realm still holds both registrations, and what they are for still
    // works: an offer from the peer whose report threw reaches the second peer,
    // stamped with the sender's id, so the relay is measured across the throw
    // rather than inferred from the process still standing.
    expect(broker.realm.getClientById(RELAY_SENDER_ID)).toBeDefined();
    expect(broker.realm.getClientById(RELAY_DESTINATION_ID)).toBeDefined();

    sender.ws.send(
      JSON.stringify({
        type: "OFFER",
        dst: RELAY_DESTINATION_ID,
        payload: OFFER_PAYLOAD,
      }),
    );
    await waitFor(() =>
      destination.frames.some((frame) => frame.type === "OFFER"),
    );
    const offer = destination.frames.find((frame) => frame.type === "OFFER");
    expect(offer?.src).toBe(RELAY_SENDER_ID);
    expect(offer?.payload).toEqual(OFFER_PAYLOAD);
  });

  test("the shipped instance wiring sends a report to the sink", async () => {
    const broker = await startShippedBroker();
    const client = await connectRegistered(broker.port, "peer-wiring");
    client.send("not json at all");

    await waitFor(() => brokerLines().length > 0);
    expect(brokerLines()[0]).toContain("[client-frame]");
  });
});
