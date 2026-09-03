import { describe, expect, it } from "vitest";
import {
  parseSource,
  readSource,
  sourceModules,
} from "./lib/typeScriptSources.mjs";
import {
  directoryDrift,
  providerOptionsReads,
} from "./check-webrtc-provider-options-unread.mjs";

const CLI_WEBRTC_DIR = "apps/cli/src/connection/webrtc";

const CLI_FILES = [
  "apps/cli/src/connection/webrtc/brokerClient.ts",
  "apps/cli/src/connection/webrtc/inboundBounds.ts",
  "apps/cli/src/connection/webrtc/peerjsWire.ts",
  "apps/cli/src/connection/webrtc/webrtcMessageConnection.ts",
  "apps/cli/src/connection/webrtc/weriftPeer.ts",
];

const WEB_FILES = [
  "apps/web/src/psi/rendezvous.ts",
  "apps/web/src/psi/managedRendezvous.ts",
  "apps/web/src/psi/peerMessageConnection.ts",
  "apps/web/src/psi/waitForConnection.ts",
  "apps/web/src/psi/peerLogging.ts",
  "apps/web/src/psi/invitationLocation.ts",
  "apps/web/src/psi/invitation.ts",
  "apps/web/src/psi/managedExchangeRecord.ts",
  "apps/web/src/psi/boundedReassembly.ts",
  "apps/web/src/psi/waitForOpen.ts",
  "apps/web/src/psi/waitForPeerClose.ts",
  "apps/web/src/utils/diagnostics.ts",
  "apps/web/src/utils/clientConfig.ts",
];

const readsIn = (source, file = "fixture.ts") =>
  providerOptionsReads(parseSource(file, source));

describe("WebRTC provider_options unread check", () => {
  it("the tree as it stands passes: no scanned file reads either spelling", () => {
    for (const file of [...CLI_FILES, ...WEB_FILES])
      expect(readsIn(readSource(file), file)).toEqual([]);
  });

  it("CLI_FILES is exactly the CLI WebRTC directory's real listing", () => {
    expect(directoryDrift(CLI_WEBRTC_DIR, CLI_FILES)).toEqual({
      added: [],
      removed: [],
    });
  });

  it("catches a property read of either spelling, optional chaining included", () => {
    expect(readsIn("const v = connection.providerOptions;\n")).toMatchObject([
      { line: 1, text: "connection.providerOptions" },
    ]);
    expect(readsIn("const v = connection?.provider_options;\n")).toMatchObject([
      { line: 1, text: "connection?.provider_options" },
    ]);
  });

  it("catches a bracket access keyed by the literal, either spelling", () => {
    expect(readsIn('const v = connection["providerOptions"];\n')).toMatchObject(
      [{ line: 1, text: 'connection["providerOptions"]' }],
    );
    expect(
      readsIn('const v = connection?.["provider_options"];\n'),
    ).toMatchObject([{ line: 1, text: 'connection?.["provider_options"]' }]);
  });

  it("catches a destructured binding naming it as the source key", () => {
    // Plain and renamed destructuring, and the same shapes in a parameter.
    expect(readsIn("const { providerOptions } = connection;\n")).toMatchObject([
      { line: 1 },
    ]);
    expect(
      readsIn("const { providerOptions: opts } = connection;\n"),
    ).toMatchObject([{ line: 1 }]);
    expect(
      readsIn("const { provider_options: opts } = connection;\n"),
    ).toMatchObject([{ line: 1 }]);
    // The binding itself is the read; a plain identifier reference to the bound
    // local afterwards is not one of the matched shapes.
    expect(
      readsIn(
        "function f({ providerOptions }) {\n  return providerOptions;\n}\n",
      ),
    ).toMatchObject([{ line: 1 }]);
  });

  it("reports the line a read sits on, across earlier lines", () => {
    expect(
      readsIn("const a = 1;\nconst b = 2;\nuse(connection.providerOptions);\n"),
    ).toMatchObject([{ line: 3 }]);
  });

  it("leaves a mention inside a comment or an unrelated string alone", () => {
    expect(
      readsIn(
        "// connection.providerOptions is inert on this channel\nconst v = 1;\n",
      ),
    ).toEqual([]);
    expect(readsIn('const msg = "provider_options";\n')).toEqual([]);
    expect(readsIn('log(`dropped key ${"providerOptions"}`);\n')).toEqual([]);
  });

  it("cannot see a dynamic key, stated as a limit in the module header", () => {
    expect(
      readsIn('const key = "providerOptions";\nconst v = connection[key];\n'),
    ).toEqual([]);
  });

  it("cannot see a re-export under another name, stated as a limit in the module header", () => {
    expect(
      readsIn('export { providerOptions as somethingElse } from "./x";\n'),
    ).toEqual([]);
  });

  it("fails a fixture that reads the option the way a real consumer would", () => {
    // The shape a WebRTC PeerOptions consumer would actually write: destructure
    // the option straight off the connection block and pass it through.
    const fixture = [
      "function toPeerOptions(connection) {",
      "  const { providerOptions } = connection;",
      "  return { ...providerOptions };",
      "}",
      "",
    ].join("\n");
    const reads = readsIn(fixture);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads[0].line).toBe(2);
  });

  it("reports both directions of directory drift", () => {
    const real = sourceModules(CLI_WEBRTC_DIR);
    expect(real.length).toBeGreaterThan(0);

    // A file on disk the list forgot: drop one from the list handed in.
    const shrunk = real.slice(1);
    expect(directoryDrift(CLI_WEBRTC_DIR, shrunk)).toEqual({
      added: [real[0]],
      removed: [],
    });

    // A file the list still names that is no longer on disk.
    const gone = `${CLI_WEBRTC_DIR}/gone.ts`;
    expect(directoryDrift(CLI_WEBRTC_DIR, [...real, gone])).toEqual({
      added: [],
      removed: [gone],
    });
  });
});
