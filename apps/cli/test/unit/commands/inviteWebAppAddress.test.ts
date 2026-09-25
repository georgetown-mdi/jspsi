import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import logLibrary from "loglevel";
import YAML from "yaml";
import { decodeInvitation, getLogger, UsageError } from "@alcove/core";

import {
  resolveInvitePositionals,
  validateInvite,
} from "../../../src/commands/invite";
import { saveConfig } from "../../../src/config";
import {
  coordinationServerURLFromWebAppAddress,
  inviterConnectionFromURL,
  WEB_APP_ADDRESS_REFUSED,
} from "../../../src/connectionFromUrl";
import type { CommonBootstrapOptions } from "../../../src/optionDefinitions";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-invite-web-app-"));
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

function silentLog(name: string) {
  const log = getLogger(name);
  log.setLevel("silent");
  return log;
}

describe("coordinationServerURLFromWebAppAddress", () => {
  test("resolves the app's host, port, /api/ mount point, and TLS from the scheme", () => {
    const cases: Array<[string, string]> = [
      ["https://app.example.org", "wss://app.example.org/api/"],
      ["https://app.example.org/", "wss://app.example.org/api/"],
      ["https://app.example.org:443/", "wss://app.example.org/api/"],
      ["https://app.example.org:8443/", "wss://app.example.org:8443/api/"],
      ["http://app.example.org/", "ws://app.example.org/api/"],
      ["http://127.0.0.1:3000/", "ws://127.0.0.1:3000/api/"],
      ["http://app.example.org:443/", "ws://app.example.org:443/api/"],
    ];
    for (const [address, server] of cases)
      expect(
        coordinationServerURLFromWebAppAddress(new URL(address)).href,
      ).toBe(server);
  });

  test("refuses a path, user, query, or fragment without echoing the URL", () => {
    const token = "secret-invitation-token";
    for (const raw of [
      "https://app.example.org/accept",
      `https://app.example.org/accept#${token}`,
      "https://app.example.org/api/",
      `https://app.example.org/#${token}`,
      "https://someone@app.example.org/",
      "https://someone:hunter2@app.example.org/",
      "https://app.example.org/?key=private",
    ]) {
      let caught: unknown;
      try {
        coordinationServerURLFromWebAppAddress(new URL(raw));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UsageError);
      const message = (caught as Error).message;
      expect(message).toBe(WEB_APP_ADDRESS_REFUSED);
      expect(message).not.toContain(token);
      expect(message).not.toContain("hunter2");
      // The refusal names both forms the command takes.
      expect(message).toContain("https://");
      expect(message).toContain("wss://");
    }
  });
});

describe("inviterConnectionFromURL on a web app address", () => {
  test("builds the webrtc connection the equivalent ws/wss URL builds", () => {
    for (const [address, server] of [
      ["https://app.example.org/", "wss://app.example.org/api/"],
      ["https://app.example.org:8443", "wss://app.example.org:8443/api/"],
      ["http://127.0.0.1:3000", "ws://127.0.0.1:3000/api/"],
    ])
      expect(inviterConnectionFromURL(new URL(address), {})).toEqual(
        inviterConnectionFromURL(new URL(server), {}),
      );
  });

  test("records host, port, path, and the plaintext choice", () => {
    expect(
      inviterConnectionFromURL(new URL("https://app.example.org:8443/"), {}),
    ).toEqual({
      channel: "webrtc",
      server: { host: "app.example.org", port: 8443, path: "/api/" },
    });
    expect(
      inviterConnectionFromURL(new URL("http://app.example.org/"), {}),
    ).toEqual({
      channel: "webrtc",
      server: { host: "app.example.org", path: "/api/", secure: false },
    });
  });

  test("applies the relay flags as on a wss URL", () => {
    const conn = inviterConnectionFromURL(
      new URL("https://app.example.org/"),
      {},
      { stun: ["stun:relay.example.org:3478"] },
    );
    expect(conn).toMatchObject({ stun: ["stun:relay.example.org:3478"] });
  });
});

describe("alcove invite with a web app address", () => {
  test("an http(s) address dispatches online", () => {
    for (const raw of ["https://app.example.org/", "http://127.0.0.1:3000"]) {
      const r = resolveInvitePositionals([raw, "input.csv"]);
      expect(r.mode).toBe("online");
      if (r.mode !== "online") return;
      expect(r.url.href).toBe(new URL(raw).href);
      expect(r.input).toBe("input.csv");
    }
  });

  test("a path on the address fails before the token exists", async () => {
    const dir = scratch();
    const options = optionsIn(dir);
    await expect(
      validateInvite({
        resolved: {
          mode: "online",
          url: new URL("https://app.example.org/accept"),
          input: writeInput(dir),
        },
        options,
        acceptTimeout: 900,
        log: silentLog("invite-web-app-path"),
      }),
    ).rejects.toThrow(WEB_APP_ADDRESS_REFUSED);
    expect(fs.existsSync(options.keyFile)).toBe(false);
  });

  test("the invitation and the written configuration name the resolved server, and the offline form reuses it", async () => {
    const dir = scratch();
    const options = optionsIn(dir);
    const ready = await validateInvite({
      resolved: {
        mode: "online",
        url: new URL("https://app.example.org:8443/"),
        input: writeInput(dir),
      },
      options,
      acceptTimeout: 900,
      log: silentLog("invite-web-app-online"),
    });
    if (ready.mode !== "online") throw new Error("expected online mode");
    const onlineToken = await decodeInvitation(ready.invitation);
    const endpoint = {
      channel: "webrtc",
      host: "app.example.org",
      port: 8443,
      path: "/api/",
    };
    expect(onlineToken.connectionEndpoint).toEqual(endpoint);

    // The bootstrap writes this connection as the configuration's block.
    saveConfig(options.configFile, {
      connection: ready.connection,
      ...ready.dataSpec,
    });
    const written = YAML.parse(fs.readFileSync(options.configFile, "utf8"));
    expect(written.connection).toEqual({
      channel: "webrtc",
      role: "inviter",
      server: { host: "app.example.org", port: 8443, path: "/api/" },
    });

    const offline = await validateInvite({
      resolved: { mode: "offline" },
      options,
      acceptTimeout: 900,
      log: silentLog("invite-web-app-offline"),
    });
    expect(offline.mode).toBe("offlineFromConfig");
    const offlineToken = await decodeInvitation(offline.invitation);
    expect(offlineToken.connectionEndpoint).toEqual(endpoint);
  });
});
