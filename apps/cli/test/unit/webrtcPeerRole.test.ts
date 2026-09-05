import { expect, test } from "vitest";
import { safeParseConnectionConfig } from "@psilink/core";
import type {
  FileDropConnectionConfig,
  SFTPConnectionConfig,
  WebRTCConnectionConfig,
} from "@psilink/core";

import { withWebRTCPeerRole } from "../../src/webrtcPeerRole";

const webrtcConnection: WebRTCConnectionConfig = {
  channel: "webrtc",
  server: { host: "peer.example.org", port: 443, path: "/psi" },
  stun: ["stun:stun.example.org:3478"],
};

const sftpConnection: SFTPConnectionConfig = {
  channel: "sftp",
  server: { host: "sftp.example.org", username: "alice", path: "/exchange" },
};

const filedropConnection: FileDropConnectionConfig = {
  channel: "filedrop",
  path: "/mnt/share/drop",
};

test("the inviting side's stamp is the label its rendezvous id derives from", () => {
  const stamped = withWebRTCPeerRole(webrtcConnection, "inviter");
  expect(stamped.role).toBe("inviter");
  // Everything else the connection locates the partner by stays unchanged.
  expect(stamped.server).toEqual(webrtcConnection.server);
  expect(stamped.stun).toEqual(webrtcConnection.stun);
});

test("the accepting side's stamp is the complementary label", () => {
  const inviter = withWebRTCPeerRole(webrtcConnection, "inviter");
  const acceptor = withWebRTCPeerRole(webrtcConnection, "acceptor");
  expect(acceptor.role).toBe("acceptor");
  // The pair is what makes the two derived peer ids meet: two configs stamped
  // from the same connection must not name the same side.
  expect(inviter.role).not.toBe(acceptor.role);
});

test("a stamped role parses back off the connection schema", () => {
  // The stamp lands on the field the schema defines, so a config written with it
  // is loadable rather than rejected as an unknown key.
  const parsed = safeParseConnectionConfig(
    withWebRTCPeerRole(webrtcConnection, "acceptor"),
  );
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.channel).toBe("webrtc");
  if (parsed.data.channel !== "webrtc") return;
  expect(parsed.data.role).toBe("acceptor");
});

test.each([
  ["sftp", sftpConnection],
  ["filedrop", filedropConnection],
] as const)(
  "a %s connection is left without a role",
  (_channel, connection) => {
    const stamped = withWebRTCPeerRole(connection, "inviter");
    // `role` is a WebRTC-only field: no other channel's schema defines one, so a
    // non-WebRTC connection must come back with no such key at all -- not one set
    // to undefined, which would serialize into the written config.
    expect(Object.keys(stamped)).not.toContain("role");
    expect(stamped).toEqual(connection);
  },
);

test("the caller's connection is not mutated", () => {
  const connection: WebRTCConnectionConfig = {
    channel: "webrtc",
    server: { host: "peer.example.org" },
  };
  withWebRTCPeerRole(connection, "inviter");
  expect(connection.role).toBeUndefined();
});
