import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import YAML from "yaml";

import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_PEER_TIMEOUT_MS,
  DEFAULT_POLLING_FREQUENCY_MS,
  DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
  getDefaultLinkageTerms,
  parseExchangeSpec,
} from "@psilink/core";
import type { ExchangeSpec } from "@psilink/core";

import { saveConfig } from "../../src/config";
import {
  CONNECTION_BLOCK_DOC_URL,
  CONNECTION_BLOCK_NOTICE,
} from "../../src/connectionGuidance";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-guidance-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(spec: ExchangeSpec): string {
  const configPath = path.join(dir, "psilink.yaml");
  saveConfig(configPath, spec);
  return fs.readFileSync(configPath, "utf8");
}

/** The placeholder connection block an offline `psilink invite` writes. */
function placeholderSpec(): ExchangeSpec {
  return {
    connection: {
      channel: "sftp",
      server: { host: "REPLACE_WITH_SFTP_HOST", username: "REPLACE_WITH_USER" },
    },
    linkageTerms: getDefaultLinkageTerms("Agency A"),
  };
}

/**
 * Un-comment the guidance block the writer attaches, returning it as loadable
 * YAML: the `#` markers and one space of the comment indent come off each line,
 * and the prose lines (which are not `key: value`) are dropped.
 */
function uncommentedOptions(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => /^\s*#\s+\S+:( |$)/.test(line))
    .map((line) => line.replace(/^(\s*)#\s?/, "$1"))
    .join("\n");
}

test("the written connection block names every channel and the block for each", () => {
  const raw = write(placeholderSpec());
  expect(raw).toContain("# How to reach your exchange partner.");
  expect(raw).toContain("sftp, filedrop");
  expect(raw).toContain("webrtc");
  expect(raw).toContain(`# ${CONNECTION_BLOCK_DOC_URL}`);
});

test("the written connection block shows the tuning commented at its defaults", () => {
  const raw = write(placeholderSpec());
  expect(raw).toContain(
    `#   poll_interval_ms: ${DEFAULT_POLLING_FREQUENCY_MS}`,
  );
  expect(raw).toContain(
    `#   server_connect_timeout_ms: ${DEFAULT_SERVER_CONNECT_TIMEOUT_MS}`,
  );
  expect(raw).toContain(`#   peer_timeout_ms: ${DEFAULT_PEER_TIMEOUT_MS}`);
  expect(raw).toContain(
    `#   max_reconnect_attempts: ${DEFAULT_MAX_RECONNECT_ATTEMPTS}`,
  );
  // Commented, so the config still takes whatever the running version defaults
  // to: nothing in the block is active.
  const parsed = parseExchangeSpec(YAML.parse(raw));
  expect(parsed.connection).toEqual(placeholderSpec().connection);
});

test("the commented tuning example loads once the operator uncomments it", () => {
  const raw = write(placeholderSpec());
  const enabled = YAML.parse(
    "connection:\n  channel: sftp\n  server:\n    host: h\n    username: u\n" +
      uncommentedOptions(raw) +
      "\n",
  ) as Record<string, unknown>;
  const spec = parseExchangeSpec({
    ...enabled,
    linkage_terms: YAML.parse(YAML.stringify(placeholderSpec().linkageTerms)),
  });
  expect(spec.connection).toMatchObject({
    channel: "sftp",
    options: {
      pollIntervalMs: DEFAULT_POLLING_FREQUENCY_MS,
      serverConnectTimeoutMs: DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
      peerTimeoutMs: DEFAULT_PEER_TIMEOUT_MS,
      maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS,
    },
  });
});

test("a webrtc block omits poll_interval_ms, which its schema rejects", () => {
  const raw = write({
    connection: {
      channel: "webrtc",
      server: { host: "api.peerjs.com", port: 443 },
      role: "acceptor",
    },
    linkageTerms: getDefaultLinkageTerms("Agency A"),
  });
  expect(raw).not.toContain("poll_interval_ms");
  expect(raw).toContain(`#   peer_timeout_ms: ${DEFAULT_PEER_TIMEOUT_MS}`);
});

test("a seeded options block keeps its own fields and is not shown them twice", () => {
  const raw = write({
    connection: {
      channel: "filedrop",
      inboundPath: "/mnt/from-partner",
      outboundPath: "/mnt/to-partner",
      options: {
        retainFiles: true,
        locklessRendezvous: true,
        timestampInFilename: true,
        pollIntervalMs: 250,
      },
    },
    linkageTerms: getDefaultLinkageTerms("Agency A"),
  });
  // The seeded value stands, and the example does not offer the field again.
  expect(raw).toContain("poll_interval_ms: 250");
  expect(raw).not.toContain(
    `# poll_interval_ms: ${DEFAULT_POLLING_FREQUENCY_MS}`,
  );
  // The fields the seeded block leaves unset are still offered, indented under
  // the live `options` key rather than beside it.
  expect(raw).toContain(`    # peer_timeout_ms: ${DEFAULT_PEER_TIMEOUT_MS}`);
  const parsed = parseExchangeSpec(YAML.parse(raw));
  expect(parsed.connection).toMatchObject({
    options: { pollIntervalMs: 250, retainFiles: true },
  });
});

test("the notice and the config comment name a section of the reference that exists", () => {
  const fragment = CONNECTION_BLOCK_DOC_URL.split("#")[1];
  expect(CONNECTION_BLOCK_NOTICE).toContain(CONNECTION_BLOCK_DOC_URL);
  const reference = fs.readFileSync(
    path.join(import.meta.dirname, "../../../../docs/EXCHANGE_REFERENCE.md"),
    "utf8",
  );
  const headings = reference
    .split("\n")
    .filter((line) => line.startsWith("#"))
    .map((line) =>
      line
        .replace(/^#+\s*/, "")
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s/g, "-"),
    );
  expect(headings).toContain(fragment);
});
