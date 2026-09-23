/// <reference types="@vitest/browser-playwright/context" />

import { expect, inject, test, vi } from "vitest";

import Peer from "peerjs";

import {
  ConnectionError,
  deriveRendezvousPeerId,
  generateSharedSecret,
} from "@psilink/core";

import { dialAsAcceptor } from "@psi/transport/rendezvous";
import { openPeerMessageConnection } from "@psi/transport/peerMessageConnection";
import { waitForIncomingConnection } from "@psi/transport/waitForConnection";

import { canReachServer } from "../utils/pspiFixtures.js";

import type { PeerOptions } from "peerjs";

/**
 * A browser exchange whose only relay cannot be reached, in real Chromium over
 * the app's own broker: both seats fail naming the relay url and the error the
 * browser reported for it, rather than a bare open timeout.
 *
 * Both peers run on one machine, where a host candidate would connect them
 * whatever the relay does, so each is held to relay candidates alone -- the
 * position of a party whose network leaves the relay as the only path.
 */

/** `@psi/transport/rendezvous` reads its config through `ConfigManager` at
 * module scope, whose env read needs `process`; the schema defaults stand in
 * (the same substitution as webrtcEndpointAuthority.test.ts). */
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

const brokerPort = inject("webDevServerPort") ?? 3000;
const brokerHost = "127.0.0.1";
const hostString = `http://${brokerHost}:${String(brokerPort)}`;

/** A TLS relay under a reserved name that never resolves (RFC 6761), which
 * Chromium reports as an `icecandidateerror` within a fraction of a second. */
const UNREACHABLE_RELAY_URL = "turns:relay.invalid:443";

/** Well past Chromium's report of the unresolvable relay, short of the
 * defaults. */
const OPEN_TIMEOUT_MS = 8_000;

function relayOnly(options: PeerOptions): PeerOptions {
  return {
    ...options,
    config: { ...options.config, iceTransportPolicy: "relay" },
  };
}

function expectNamesRelay(error: unknown): void {
  expect(error).toBeInstanceOf(ConnectionError);
  const message = (error as ConnectionError).message;
  expect(message).toContain("no relay candidate was gathered");
  expect(message).toContain(UNREACHABLE_RELAY_URL);
  expect(message).toMatch(/\(error \d+: [^)]+\)/);
  expect(message).not.toContain("timed out");
}

test(
  "both seats name the unreachable relay and the browser's error",
  { timeout: 60_000 },
  async (ctx) => {
    if (!(await canReachServer(hostString)))
      return ctx.skip(
        `PeerJS coordination server at ${hostString} unreachable`,
      );
    const secret = generateSharedSecret();
    const relay = { turn: [UNREACHABLE_RELAY_URL], stun: [] };

    const inviterPeer = new Peer(
      await deriveRendezvousPeerId(secret, "inviter"),
      relayOnly({
        host: brokerHost,
        port: brokerPort,
        path: "/api/",
        config: {
          iceServers: [
            { urls: [UNREACHABLE_RELAY_URL], username: "u", credential: "c" },
          ],
        },
      }),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        inviterPeer.once("open", () => resolve());
        inviterPeer.once("error", reject);
      });
      const inviterSide = waitForIncomingConnection(inviterPeer).then((conn) =>
        openPeerMessageConnection(conn, { openTimeoutMs: OPEN_TIMEOUT_MS }),
      );
      const acceptorSide = dialAsAcceptor(
        secret,
        {
          channel: "webrtc",
          host: brokerHost,
          port: brokerPort,
          path: "/api/",
        },
        {
          relay,
          openTimeoutMs: OPEN_TIMEOUT_MS,
          peerFactory: (id, options) => new Peer(id, relayOnly(options)),
        },
      );
      const [inviterResult, acceptorResult] = await Promise.allSettled([
        inviterSide,
        acceptorSide,
      ]);
      expect(inviterResult.status).toBe("rejected");
      expect(acceptorResult.status).toBe("rejected");
      if (inviterResult.status === "rejected")
        expectNamesRelay(inviterResult.reason);
      if (acceptorResult.status === "rejected")
        expectNamesRelay(acceptorResult.reason);
    } finally {
      inviterPeer.destroy();
    }
  },
);
