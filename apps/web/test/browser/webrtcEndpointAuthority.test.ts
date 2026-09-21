/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import Peer from "peerjs";

import { generateSharedSecret } from "@psilink/core";

import {
  WEBRTC_ENDPOINT_HOST_REFUSED,
  WEBRTC_ENDPOINT_PATH_REFUSED,
  dialAsAcceptor,
} from "@psi/transport/rendezvous";

import type { WebRTCEndpoint } from "@psilink/core";

/**
 * What an invitation endpoint's `host` and `path` can do to the address the
 * acceptor dials, measured against the real pinned PeerJS client in real
 * Chromium, and the refusal the acceptor's own dial path applies to each shape.
 *
 * The endpoint is written by the remote partner and its two fields are bounded
 * only by length, so this file is the evidence for what the refusal in
 * `acceptorLocationFromEndpoint` is worth: for each shape it drives a real
 * `Peer`, records the address that client assembles, and resolves that address
 * with the browser's own URL parser -- the parse that decides which server a
 * socket would reach.
 *
 * Nothing is dialed. The recorded address is resolved rather than opened, so
 * the measurement is offline and names no server that has to exist.
 */

/**
 * The one module this file substitutes. `@psi/transport/rendezvous` loads its
 * config at module scope through `ConfigManager`, whose env read needs
 * `process`, absent in the browser runner; the rest of this suite stubs the
 * whole rendezvous module for that reason (`moduleMocks.ts`), which would leave
 * nothing here to measure. Stubbing the config one level below keeps the dial
 * path the app's own. The values are the schema's defaults, which is what an
 * unset environment resolves to.
 */
vi.mock("@utils/clientConfig", () => {
  class ConfigManager {
    load(): Promise<{
      PEERJS_DEBUG_LEVEL: number;
      LOG_LEVEL: string;
      DEPLOYMENT_PROFILE: string;
      PSILINK_VERSION: string;
    }> {
      return Promise.resolve({
        PEERJS_DEBUG_LEVEL: 1,
        LOG_LEVEL: "INFO",
        DEPLOYMENT_PROFILE: "hosted",
        PSILINK_VERSION: "",
      });
    }
  }
  return { ConfigManager };
});

/** The address the client assembles, for one endpoint, in its recorded form. */
interface AssembledAddress {
  /** The string the PeerJS client built and would have handed a WebSocket. */
  url: string;
  /** The host that address resolves to, or `undefined` if it does not parse. */
  host: string | undefined;
}

/** The host a well-formed endpoint names. */
const INVITER_HOST = "inviter.example.org";

/** The host a partner would be moving the dial to. */
const OTHER_HOST = "evil.example.org";

/** A valid PeerJS id (lowercase hex, the shape the rendezvous derives). */
const MEASURED_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

/**
 * A WebSocket that records the address it was handed and connects to nothing.
 * The PeerJS client reads `WebSocket` off the global at the moment it dials,
 * so this stands in for the real one for exactly the one call the measurement
 * is about.
 */
function recordingSocketClass(recorded: Array<string>): typeof WebSocket {
  class RecordingSocket {
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 0;
    constructor(url: string) {
      recorded.push(url);
    }
    send(): void {}
    close(): void {}
  }
  return RecordingSocket as unknown as typeof WebSocket;
}

/**
 * The address the real client assembles for a signaling location, and what the
 * browser's URL parser resolves it to. `secure` is set rather than inferred so
 * the measurement describes a `wss:` deployment regardless of the scheme this
 * test page was served over.
 */
function assembleAddress(location: {
  host: string;
  port: number;
  path: string;
}): AssembledAddress {
  const recorded: Array<string> = [];
  vi.stubGlobal("WebSocket", recordingSocketClass(recorded));
  try {
    const peer = new Peer(MEASURED_ID, {
      host: location.host,
      port: location.port,
      path: location.path,
      secure: true,
      debug: 0,
    });
    peer.on("error", () => {});
    peer.destroy();
  } finally {
    vi.unstubAllGlobals();
  }
  const url = recorded[0];
  expect(url).toBeDefined();
  let host: string | undefined;
  try {
    host = new URL(url).host;
  } catch {
    host = undefined;
  }
  return { url, host };
}

/**
 * One measured endpoint shape: the field it puts a delimiter in, and the host
 * the assembled address resolves to, as the URL parser reports a host (a
 * scheme's default port is left off): `OTHER_HOST` where the authority moves to
 * the partner's second name, `INVITER_HOST` where it stays with the host the
 * endpoint names, and `undefined` where the address does not parse at all.
 */
interface Shape {
  what: string;
  host: string;
  path: string;
  resolvesTo: string | undefined;
}

const PORT = 443;

const hostShapes: Array<Shape> = [
  {
    what: "userinfo",
    host: `${INVITER_HOST}@${OTHER_HOST}`,
    path: "/api/",
    // The measured move: the client concatenates, so the name the endpoint
    // shows becomes the userinfo of the host it actually reaches.
    resolvesTo: OTHER_HOST,
  },
  {
    what: "a path of its own",
    host: `${INVITER_HOST}/${OTHER_HOST}`,
    path: "/api/",
    resolvesTo: INVITER_HOST,
  },
  {
    what: "a query",
    host: `${INVITER_HOST}?${OTHER_HOST}`,
    path: "/api/",
    resolvesTo: INVITER_HOST,
  },
  {
    what: "a fragment",
    host: `${INVITER_HOST}#${OTHER_HOST}`,
    path: "/api/",
    resolvesTo: INVITER_HOST,
  },
  {
    what: "a backslash",
    host: `${INVITER_HOST}\\${OTHER_HOST}`,
    path: "/api/",
    resolvesTo: INVITER_HOST,
  },
  {
    what: "a space",
    // Percent-encoded into the host rather than refused, so the address still
    // parses and still names neither of the two hosts in it.
    host: `${INVITER_HOST} ${OTHER_HOST}`,
    path: "/api/",
    resolvesTo: `${INVITER_HOST}%20${OTHER_HOST}`,
  },
  {
    what: "a tab",
    // The parser deletes a tab from anywhere in the address, so the two names
    // join into a third the endpoint never showed -- an authority the partner
    // can hold, which is why whitespace is refused rather than trimmed.
    host: `${INVITER_HOST}\t${OTHER_HOST}`,
    path: "/api/",
    resolvesTo: `${INVITER_HOST}${OTHER_HOST}`,
  },
  {
    what: "a newline",
    host: `${INVITER_HOST}\n${OTHER_HOST}`,
    path: "/api/",
    resolvesTo: `${INVITER_HOST}${OTHER_HOST}`,
  },
];

const pathShapes: Array<Shape> = [
  {
    what: "userinfo",
    host: INVITER_HOST,
    path: `/api/@${OTHER_HOST}`,
    resolvesTo: INVITER_HOST,
  },
  {
    what: "a query",
    host: INVITER_HOST,
    path: `/api/?${OTHER_HOST}`,
    resolvesTo: INVITER_HOST,
  },
  {
    what: "a fragment",
    host: INVITER_HOST,
    path: `/api/#${OTHER_HOST}`,
    resolvesTo: INVITER_HOST,
  },
  {
    what: "a backslash",
    host: INVITER_HOST,
    path: `/api\\${OTHER_HOST}/`,
    resolvesTo: INVITER_HOST,
  },
  {
    what: "a space",
    host: INVITER_HOST,
    path: "/api /",
    resolvesTo: INVITER_HOST,
  },
  {
    what: "a tab",
    host: INVITER_HOST,
    path: "/api\t/",
    resolvesTo: INVITER_HOST,
  },
  {
    what: "no leading separator",
    host: INVITER_HOST,
    path: "api/",
    resolvesTo: INVITER_HOST,
  },
];

/**
 * One alternative label separator: a character the URL parser folds onto `.`
 * and the shared rule's denylist does not hold.
 */
interface MappedSeparator {
  what: string;
  separator: string;
}

const mappedSeparators: Array<MappedSeparator> = [
  { what: "U+3002", separator: "\u3002" },
  { what: "U+FF61", separator: "\uFF61" },
  { what: "U+FF0E", separator: "\uFF0E" },
];

/** The host a mapped separator between the two names resolves to. */
const MAPPED_HOST = `${INVITER_HOST}.${OTHER_HOST}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the address the real client assembles from an endpoint", () => {
  test("a well-formed endpoint reaches the host it names", () => {
    const { url, host } = assembleAddress({
      host: INVITER_HOST,
      port: PORT,
      path: "/api/",
    });
    // The assembly the refusal exists for: host, port and path are joined into
    // one string, so each is read back out of it by the URL parser rather than
    // kept as the field it was set from.
    expect(url).toContain(`wss://${INVITER_HOST}:${PORT}/api/peerjs?key=`);
    expect(host).toBe(INVITER_HOST);
  });

  test.each(hostShapes)(
    "a host carrying $what resolves to $resolvesTo",
    ({ host, path, resolvesTo }) => {
      expect(assembleAddress({ host, port: PORT, path }).host).toBe(resolvesTo);
    },
  );

  test.each(pathShapes)(
    "a path carrying $what resolves to $resolvesTo",
    ({ host, path, resolvesTo }) => {
      expect(assembleAddress({ host, port: PORT, path }).host).toBe(resolvesTo);
    },
  );

  // Nothing downstream fails closed on any of these: every shape assembles an
  // address the browser accepts, so refusing the shape is the only control
  // between a partner's delimiter and the socket.
  test.each([...hostShapes, ...pathShapes])(
    "$what still assembles an address that parses",
    ({ host, path }) => {
      expect(assembleAddress({ host, port: PORT, path }).host).toBeDefined();
    },
  );

  // No path shape moves the authority: the client has already written the host
  // and port by the time it appends a path. The path refusal is therefore the
  // conservative half -- it keeps a partner from reshaping the rest of the
  // address, not from moving the server.
  test("no path shape reaches another host", () => {
    for (const { host, path } of pathShapes)
      expect(assembleAddress({ host, port: PORT, path }).host).toBe(
        INVITER_HOST,
      );
  });
});

describe("the acceptor's dial path", () => {
  const endpoint: WebRTCEndpoint = {
    channel: "webrtc",
    host: INVITER_HOST,
    port: PORT,
    path: "/api/",
  };

  /** A peer factory that fails the test if the dial path ever reaches it. */
  const refusingFactory = (): never => {
    throw new Error("a Peer was constructed for a refused endpoint");
  };

  test.each(hostShapes)(
    "refuses a host carrying $what before any peer exists",
    async ({ host }) => {
      await expect(
        dialAsAcceptor(
          generateSharedSecret(),
          { ...endpoint, host },
          { peerFactory: refusingFactory },
        ),
      ).rejects.toThrow(WEBRTC_ENDPOINT_HOST_REFUSED);
    },
  );

  test.each(pathShapes)(
    "refuses a path carrying $what before any peer exists",
    async ({ path }) => {
      await expect(
        dialAsAcceptor(
          generateSharedSecret(),
          { ...endpoint, path },
          { peerFactory: refusingFactory },
        ),
      ).rejects.toThrow(WEBRTC_ENDPOINT_PATH_REFUSED);
    },
  );
});

/**
 * The shared rule is a denylist of delimiters, so a separator the URL parser
 * folds onto `.` passes it and the client dials the joined name. That name is
 * one the endpoint spells itself, so this is measured rather than refused.
 */
describe("a host holding a mapped label separator", () => {
  const endpoint: WebRTCEndpoint = {
    channel: "webrtc",
    host: INVITER_HOST,
    port: PORT,
    path: "/api/",
  };

  /** What a peer factory the dial path reaches throws, to tell it from a refusal. */
  const REACHED_THE_DIAL = "the dial reached peer construction";

  test.each(mappedSeparators)(
    "$what is not refused before the peer",
    async ({ separator }) => {
      await expect(
        dialAsAcceptor(
          generateSharedSecret(),
          { ...endpoint, host: `${INVITER_HOST}${separator}${OTHER_HOST}` },
          {
            peerFactory: (): never => {
              throw new Error(REACHED_THE_DIAL);
            },
          },
        ),
      ).rejects.toThrow(REACHED_THE_DIAL);
    },
  );

  test.each(mappedSeparators)(
    "$what dials the mapped name",
    ({ separator }) => {
      expect(
        assembleAddress({
          host: `${INVITER_HOST}${separator}${OTHER_HOST}`,
          port: PORT,
          path: "/api/",
        }).host,
      ).toBe(MAPPED_HOST);
    },
  );
});
