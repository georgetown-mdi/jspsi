import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";
import yargs from "yargs";
import type { Arguments } from "yargs";
import logLibrary from "loglevel";
import YAML from "yaml";
import {
  decodeInvitation,
  deriveRelayKey,
  getDefaultLinkageTerms,
  getLogger,
  inferMetadata,
  MAX_RELAY_LOCATOR_URL_LENGTH,
  MAX_RELAY_LOCATOR_URLS,
  mintRunRelayCredential,
  UsageError,
} from "@alcove/core";
import type { ExchangeSpec, WebRTCConnectionConfig } from "@alcove/core";

import {
  builder as inviteBuilder,
  relayUrlFlag,
  validateInvite,
} from "../../../src/commands/invite";
import { saveConfig } from "../../../src/config";
import { exitCodeForError } from "../../../src/util/exit";
import type { CommonBootstrapOptions } from "../../../src/optionDefinitions";

const OWN_TURN = "turns:relay.example.org:443?transport=tcp";
const OWN_STUN = "stun:relay.example.org:3478";
const STATIC_TURN = "turn:static-relay.example.org:3478";
const STATIC_USERNAME = "static-operator-name";
const STATIC_CREDENTIAL = "static-turn-credential-value";
const BROKER_KEY = "private-broker-api-key";
const BROKER_USERNAME = "broker-user-name";

// A turn: url of exactly `length` UTF-16 code units, padded with host labels.
function turnUrlOfLength(length: number): string {
  const prefix = "turn:";
  const suffix = ".example.org:3478";
  let host = "";
  while (prefix.length + host.length + suffix.length < length) {
    const room = length - prefix.length - host.length - suffix.length;
    host += (host === "" ? "" : ".") + "a".repeat(Math.min(63, room - 1) || 1);
  }
  const url = `${prefix}${host}${suffix}`;
  if (url.length !== length) throw new Error(`built ${url.length} units`);
  return url;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-invite-relay-"));
  tmpDirs.push(dir);
  return dir;
}

function optionsIn(
  dir: string,
  overrides: Partial<CommonBootstrapOptions> = {},
): CommonBootstrapOptions {
  return {
    configFile: path.join(dir, "alcove.yaml"),
    keyFile: path.join(dir, ".alcove.key"),
    identity: "Agency A",
    record: false,
    eventStream: false,
    logLevel: logLibrary.levels.SILENT,
    verbosity: 0,
    ...overrides,
  };
}

function writeInput(dir: string): string {
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  return input;
}

function writeWebRTCConfig(
  dir: string,
  connection: Partial<Omit<WebRTCConnectionConfig, "channel">>,
): string {
  const configPath = path.join(dir, "alcove.yaml");
  const spec: ExchangeSpec = {
    connection: {
      channel: "webrtc",
      role: "inviter",
      ...connection,
      server: connection.server ?? { host: "peers.example.org" },
    },
    linkageTerms: getDefaultLinkageTerms(
      "Agency A",
      inferMetadata(["first_name", "last_name", "dob", "ssn"], []),
    ),
  };
  saveConfig(configPath, spec);
  return configPath;
}

function quietLog(name: string) {
  const log = getLogger(name);
  log.setLevel("silent");
  return { log, warn: vi.spyOn(log, "warn") };
}

function warned(
  warn: ReturnType<typeof quietLog>["warn"],
  fragment: string,
): boolean {
  return warn.mock.calls.some(
    (call) => typeof call[0] === "string" && call[0].includes(fragment),
  );
}

// Every value the invitation must not hold: the connection's own credentials,
// and the relay key and run credential derived from the invitation's shared
// secret. Both the serialized token and the encoded string are checked.
async function expectNoCredentialIn(
  invitation: string,
  extra: string[] = [],
): Promise<void> {
  const token = await decodeInvitation(invitation);
  const serialized = JSON.stringify(token);
  const relayKey = await deriveRelayKey(token.sharedSecret);
  const minted = await mintRunRelayCredential(token.sharedSecret, new Date());
  for (const secret of [relayKey, minted.credential, ":alcove", ...extra]) {
    expect(serialized).not.toContain(secret);
    expect(invitation).not.toContain(secret);
  }
}

describe("relayUrlFlag", () => {
  test("reads repeated flags from the invite parser without taking a positional", async () => {
    const argv = await yargs()
      .command("invite [args..]", "", inviteBuilder)
      .parseAsync([
        "invite",
        "--turn",
        OWN_TURN,
        "wss://peers.example.org/psi",
        "--turn",
        "turn:second.example.org:3478",
        "--stun",
        OWN_STUN,
        "input.csv",
      ]);
    expect(relayUrlFlag(argv, "turn")).toEqual([
      OWN_TURN,
      "turn:second.example.org:3478",
    ]);
    expect(relayUrlFlag(argv, "stun")).toEqual([OWN_STUN]);
    expect(argv["args"]).toEqual(["wss://peers.example.org/psi", "input.csv"]);
  });

  test("reads an absent flag as none, and each occurrence in order", () => {
    expect(relayUrlFlag({ _: [], $0: "" }, "turn")).toBeUndefined();
    expect(relayUrlFlag({ _: [], $0: "", turn: OWN_TURN }, "turn")).toEqual([
      OWN_TURN,
    ]);
    expect(
      relayUrlFlag(
        {
          _: [],
          $0: "",
          stun: [OWN_STUN, "stun:second.example.org"],
        } as Arguments,
        "stun",
      ),
    ).toEqual([OWN_STUN, "stun:second.example.org"]);
  });

  test("refuses a url outside the grammar, naming the flag and not the value", () => {
    const pasted = "turns:someone:hunter2@relay.example.org:443";
    let caught: unknown;
    try {
      relayUrlFlag({ _: [], $0: "", turn: [OWN_TURN, pasted] }, "turn");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    const message = (caught as Error).message;
    expect(message).toMatch(/^--turn \(occurrence 2\): /);
    expect(message).not.toContain("hunter2");
    expect(() =>
      relayUrlFlag({ _: [], $0: "", stun: "turn:relay.example.org" }, "stun"),
    ).toThrow(UsageError);
  });
});

describe("online invite", () => {
  test("names the --turn and --stun relay in the invitation and the written config", async () => {
    const dir = scratch();
    const options = optionsIn(dir);
    const ready = await validateInvite({
      resolved: {
        mode: "online",
        url: new URL("wss://peers.example.org/psi"),
        input: writeInput(dir),
      },
      options,
      acceptTimeout: 900,
      ownRelay: { turn: [OWN_TURN], stun: [OWN_STUN] },
      log: quietLog("invite-relay-online").log,
    });
    if (ready.mode !== "online") throw new Error("expected online mode");

    const token = await decodeInvitation(ready.invitation);
    expect(token.connectionEndpoint).toEqual({
      channel: "webrtc",
      host: "peers.example.org",
      path: "/psi",
      relay: { turn: [OWN_TURN], stun: [OWN_STUN] },
    });
    await expectNoCredentialIn(ready.invitation);

    // The bootstrap writes this connection as the configuration's block.
    saveConfig(options.configFile, {
      connection: ready.connection,
      ...ready.dataSpec,
    });
    const written = YAML.parse(fs.readFileSync(options.configFile, "utf8"));
    expect(written.connection.turn).toEqual([{ url: OWN_TURN }]);
    expect(written.connection.stun).toEqual([OWN_STUN]);
    expect(written.connection).not.toHaveProperty("invitation_relay");
  });

  test("names no relay without the flags", async () => {
    const dir = scratch();
    const ready = await validateInvite({
      resolved: {
        mode: "online",
        url: new URL("wss://peers.example.org/psi"),
        input: writeInput(dir),
      },
      options: optionsIn(dir),
      acceptTimeout: 900,
      log: quietLog("invite-relay-online-none").log,
    });
    if (ready.mode !== "online") throw new Error("expected online mode");
    const token = await decodeInvitation(ready.invitation);
    expect(token.connectionEndpoint).not.toHaveProperty("relay");
    expect(ready.connection).not.toHaveProperty("turn");
    expect(ready.connection).not.toHaveProperty("stun");
  });

  test("reports the flags ignored on a file-sync URL", async () => {
    const dir = scratch();
    const shareDir = path.join(dir, "share");
    fs.mkdirSync(shareDir);
    const { log, warn } = quietLog("invite-relay-online-filedrop");
    const ready = await validateInvite({
      resolved: {
        mode: "online",
        url: pathToFileURL(shareDir),
        input: writeInput(dir),
      },
      options: optionsIn(dir),
      acceptTimeout: 900,
      ownRelay: { turn: [OWN_TURN] },
      log,
    });
    if (ready.mode !== "online") throw new Error("expected online mode");
    expect(warned(warn, "--turn applies only to a ws:// or wss:// URL")).toBe(
      true,
    );
    expect(ready.connection).not.toHaveProperty("turn");
    const token = await decodeInvitation(ready.invitation);
    expect(token.connectionEndpoint).not.toHaveProperty("relay");
  });
});

describe("relay locator bounds", () => {
  const onlineWithTurn = (dir: string, turn: string[]) =>
    validateInvite({
      resolved: {
        mode: "online",
        url: new URL("wss://peers.example.org/psi"),
        input: writeInput(dir),
      },
      options: optionsIn(dir),
      acceptTimeout: 900,
      ownRelay: { turn },
      log: quietLog("invite-relay-bounds-online").log,
    });

  const offlineWithTurn = (dir: string, turn: string[]) =>
    validateInvite({
      resolved: { mode: "offline" },
      options: optionsIn(dir, {
        configFile: writeWebRTCConfig(dir, {
          turn: turn.map((url) => ({ url })),
        }),
      }),
      acceptTimeout: 900,
      log: quietLog("invite-relay-bounds-offline").log,
    });

  const turnUrls = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `turn:relay${index}.example.org:3478`,
    );

  test("refuses one --turn url too many as a usage error naming the flag", async () => {
    const dir = scratch();
    const error = await onlineWithTurn(
      dir,
      turnUrls(MAX_RELAY_LOCATOR_URLS + 1),
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UsageError);
    expect(exitCodeForError(error)).toBe(64);
    expect(String((error as Error).message)).toContain("--turn");
    expect(String((error as Error).message)).toContain(
      `${MAX_RELAY_LOCATOR_URLS + 1} > ${MAX_RELAY_LOCATOR_URLS}`,
    );
    expect(String((error as Error).message)).not.toContain("relay0");
    expect(fs.existsSync(optionsIn(dir).keyFile)).toBe(false);
  });

  test("refuses a connection.turn url one unit too long, naming the field and not the url", async () => {
    const dir = scratch();
    const tooLong = turnUrlOfLength(MAX_RELAY_LOCATOR_URL_LENGTH + 1);
    const error = await offlineWithTurn(dir, [tooLong]).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UsageError);
    expect(exitCodeForError(error)).toBe(64);
    expect(String((error as Error).message)).toContain(
      `a connection.turn url is too long to hold in an invitation (${MAX_RELAY_LOCATOR_URL_LENGTH + 1} > ${MAX_RELAY_LOCATOR_URL_LENGTH} characters)`,
    );
    expect(String((error as Error).message)).not.toContain(tooLong);
  });

  test("admits the most urls, and the longest url, an invitation holds", async () => {
    const longest = turnUrlOfLength(MAX_RELAY_LOCATOR_URL_LENGTH);
    const online = await onlineWithTurn(
      scratch(),
      turnUrls(MAX_RELAY_LOCATOR_URLS),
    );
    const onlineToken = await decodeInvitation(online.invitation);
    expect(onlineToken.connectionEndpoint).toMatchObject({
      relay: { turn: turnUrls(MAX_RELAY_LOCATOR_URLS) },
    });
    const offline = await offlineWithTurn(scratch(), [longest]);
    const offlineToken = await decodeInvitation(offline.invitation);
    expect(offlineToken.connectionEndpoint).toMatchObject({
      relay: { turn: [longest] },
    });
  });
});

describe("offline invite from a webrtc configuration", () => {
  test("names the coordination server and the url-only relay, leaving out a static turn entry", async () => {
    const dir = scratch();
    const configPath = writeWebRTCConfig(dir, {
      server: {
        host: "peers.example.org",
        port: 8443,
        key: BROKER_KEY,
        username: BROKER_USERNAME,
      },
      stun: [OWN_STUN],
      turn: [
        {
          url: STATIC_TURN,
          username: STATIC_USERNAME,
          credential: STATIC_CREDENTIAL,
        },
        { url: OWN_TURN },
      ],
    });
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: optionsIn(dir, { configFile: configPath }),
      acceptTimeout: 900,
      log: quietLog("invite-relay-offline").log,
    });
    expect(ready.mode).toBe("offlineFromConfig");

    const token = await decodeInvitation(ready.invitation);
    // The mount point is named as this CLI dials it: "/" for an absent one.
    expect(token.connectionEndpoint).toEqual({
      channel: "webrtc",
      host: "peers.example.org",
      port: 8443,
      path: "/",
      relay: { turn: [OWN_TURN], stun: [OWN_STUN] },
    });
    await expectNoCredentialIn(ready.invitation, [
      STATIC_TURN,
      STATIC_USERNAME,
      STATIC_CREDENTIAL,
      BROKER_KEY,
      BROKER_USERNAME,
    ]);
  });

  test("names no relay for a configuration with none", async () => {
    const dir = scratch();
    const configPath = writeWebRTCConfig(dir, {
      server: { host: "peers.example.org", path: "/psi" },
    });
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: optionsIn(dir, { configFile: configPath }),
      acceptTimeout: 900,
      log: quietLog("invite-relay-offline-none").log,
    });
    const token = await decodeInvitation(ready.invitation);
    expect(token.connectionEndpoint).toEqual({
      channel: "webrtc",
      host: "peers.example.org",
      path: "/psi",
    });
  });

  test("refuses a coordination server the dial would refuse, before the invitation exists", async () => {
    const dir = scratch();
    const configPath = writeWebRTCConfig(dir, {
      server: { host: "peers.example.org", path: "" },
    });
    const options = optionsIn(dir, { configFile: configPath });
    await expect(
      validateInvite({
        resolved: { mode: "offline" },
        options,
        acceptTimeout: 900,
        log: quietLog("invite-relay-offline-empty-path").log,
      }),
    ).rejects.toThrow(UsageError);
    expect(fs.existsSync(options.keyFile)).toBe(false);
  });

  test("names no relay when every turn entry has a static credential", async () => {
    const dir = scratch();
    const configPath = writeWebRTCConfig(dir, {
      turn: [
        {
          url: STATIC_TURN,
          username: STATIC_USERNAME,
          credential: STATIC_CREDENTIAL,
        },
      ],
    });
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: optionsIn(dir, { configFile: configPath }),
      acceptTimeout: 900,
      log: quietLog("invite-relay-offline-static").log,
    });
    const token = await decodeInvitation(ready.invitation);
    expect(token.connectionEndpoint).not.toHaveProperty("relay");
    await expectNoCredentialIn(ready.invitation, [
      STATIC_TURN,
      STATIC_USERNAME,
      STATIC_CREDENTIAL,
    ]);
  });

  test("uses the configuration's relay, reporting --turn and --stun ignored", async () => {
    const dir = scratch();
    const configPath = writeWebRTCConfig(dir, { stun: [OWN_STUN] });
    const { log, warn } = quietLog("invite-relay-offline-flags");
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: optionsIn(dir, { configFile: configPath }),
      acceptTimeout: 900,
      ownRelay: { turn: [OWN_TURN], stun: ["stun:elsewhere.example.org"] },
      log,
    });
    expect(warned(warn, "--turn applies only to an online")).toBe(true);
    expect(warned(warn, "--stun applies only to an online")).toBe(true);
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes(" and --")),
    ).toBe(false);
    const token = await decodeInvitation(ready.invitation);
    expect(token.connectionEndpoint).toEqual({
      channel: "webrtc",
      host: "peers.example.org",
      path: "/",
      relay: { stun: [OWN_STUN] },
    });
  });

  test("warns that a plaintext coordination server cannot be named", async () => {
    const dir = scratch();
    const configPath = writeWebRTCConfig(dir, {
      server: { host: "127.0.0.1", port: 9000, secure: false },
    });
    const { log, warn } = quietLog("invite-relay-offline-plaintext");
    await validateInvite({
      resolved: { mode: "offline" },
      options: optionsIn(dir, { configFile: configPath }),
      acceptTimeout: 900,
      log,
    });
    expect(warned(warn, "secure: false")).toBe(true);
  });

  test("refuses an invalid webrtc connection block before the invitation exists", async () => {
    const dir = scratch();
    const configPath = writeWebRTCConfig(dir, {});
    const raw = YAML.parse(fs.readFileSync(configPath, "utf8"));
    raw.connection.turn = [{ url: "https://not-a-relay.example.org" }];
    fs.writeFileSync(configPath, YAML.stringify(raw));
    const options = optionsIn(dir, { configFile: configPath });
    await expect(
      validateInvite({
        resolved: { mode: "offline" },
        options,
        acceptTimeout: 900,
        log: quietLog("invite-relay-offline-invalid").log,
      }),
    ).rejects.toThrow(/invalid webrtc connection block: connection\.turn/);
    expect(fs.existsSync(options.keyFile)).toBe(false);
  });
});
