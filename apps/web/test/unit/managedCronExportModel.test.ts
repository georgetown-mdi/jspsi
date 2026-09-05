import { describe, expect, test } from "vitest";

import {
  assembleExchangeSpec,
  connectionFromLocator,
  generateSharedSecret,
  getDefaultLinkageTerms,
  parseExchangeSpec,
  parseSensitiveYaml,
} from "@psilink/core";

import {
  CRON_EXPORT_CONFIG_MIME,
  CRON_EXPORT_KEY_MIME,
} from "@psi/managedCronExport";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import { managedCronExportPanelState } from "@bench/managedCronExportModel";

import type { ExchangeLocator, WebRTCExchangeLocator } from "@psilink/core";
import type {
  ManagedExchangeRecord,
  NewManagedExchange,
} from "@psi/managedExchangeRecord";

// The pure model behind the command-line export panel, tested in Node without a
// store or a download: what the panel renders for an exportable record, the two
// schedule lines that run its invocation unattended, and the composer's own
// refusal presented rather than re-derived. The panel's claim that the export
// names no ICE server, falling back to the built-in STUN default, is a check
// here.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

function managedRecord(
  overrides: Partial<NewManagedExchange> = {},
): ManagedExchangeRecord {
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  });
}

/** The state for an exportable record, failing the test if the composer refused
 * one it was expected to compose. */
function exportableState(record: ManagedExchangeRecord) {
  const state = managedCronExportPanelState(record);
  if (state.kind !== "exportable")
    throw new Error(`the model refused an exportable record: ${state.reason}`);
  return state;
}

describe("what the panel gets to render", () => {
  test("the two files have their CLI names, contents, and media types", () => {
    const record = managedRecord();
    const { composed } = exportableState(record);
    expect(composed.config.fileName).toBe("psilink.yaml");
    expect(composed.config.mimeType).toBe(CRON_EXPORT_CONFIG_MIME);
    expect(composed.key.fileName).toBe(".psilink.key");
    expect(composed.key.mimeType).toBe(CRON_EXPORT_KEY_MIME);
    // The secret rides the key half alone, which is what lets the panel tell the
    // operator to handle the two files differently once they land.
    expect(composed.key.text).toContain(record.sharedSecret);
    expect(composed.config.text).not.toContain(record.sharedSecret);
  });

  test("the schedule lines run the composed invocation from the export folder", () => {
    const {
      composed,
      cronLine,
      taskSchedulerLine: windowsLine,
    } = exportableState(managedRecord());
    expect(cronLine).toBe(
      `0 2 * * * cd /path/to/your/exchange-folder && ${composed.command}`,
    );
    expect(windowsLine).toContain("schtasks /Create");
    expect(windowsLine).toContain(
      `cmd /c cd /d C:\\path\\to\\your\\exchange-folder && ${composed.command}`,
    );
  });

  test("the exported connection names no ICE server, as the panel's copy says", () => {
    // The panel tells the operator every scheduled run falls back to the CLI's
    // built-in STUN default. That holds because a managed connection is a
    // credential-free locator: host, port, and path, and nothing else.
    const { composed } = exportableState(managedRecord());
    const parsed = parseExchangeSpec(
      parseSensitiveYaml(composed.config.text, "exported psilink.yaml"),
    );
    expect(parsed.connection.channel).toBe("webrtc");
    expect(parsed.connection).not.toHaveProperty("stun");
    expect(parsed.connection).not.toHaveProperty("turn");
    expect(parsed.connection).not.toHaveProperty("iceProvision");
  });

  test("composing leaves the source record untouched", () => {
    const record = managedRecord({ tokenMaxAgeDays: 90 });
    const before = structuredClone(record);
    exportableState(record);
    expect(record).toEqual(before);
  });
});

describe("a record the composer refuses", () => {
  /** A receipt-signing block, every field of which is live on the operator's
   * scheduled CLI run: `identityFile` is opened as this party's private signing
   * identity, `receiptOutput` is a verbatim local write path, and
   * `partnerFingerprint` is the pin a partner certificate is trusted against. */
  const signing = {
    mode: "certificate",
    identityFile: "@/home/other/psilink-signing.identity",
    partnerFingerprint: "0123456789012345678901234567890123456789abA",
    receiptOutput: "/home/other/receipts/planted-receipt.json",
  } as const;

  const nonWebrtcLocators: Array<[string, ExchangeLocator]> = [
    ["filedrop", { channel: "filedrop", path: "/srv/exchange" }],
    ["sftp", { channel: "sftp", host: "sftp.example.org", path: "/exchange" }],
  ];

  test.each(nonWebrtcLocators)(
    "is presented as the composer's own refusal (%s)",
    (channel, locator) => {
      // Unreachable through the UI, reachable by importing a hand-crafted
      // artifact: the panel presents the composer's decision rather than making
      // its own, so the two cannot disagree about what is exportable.
      const state = managedCronExportPanelState(
        managedRecord({
          exchangeFile: assembleExchangeSpec({
            connection: connectionFromLocator(locator),
            linkageTerms,
          }),
        }),
      );
      expect(state.kind).toBe("refused");
      if (state.kind !== "refused") return;
      expect(state.reason).toMatch(new RegExp(`webrtc[\\s\\S]*${channel}`));
    },
  );

  test("an authentication block on the stored document is refused, secret and all", () => {
    // The panel gate sees the same secret-bearing block the composer refuses, and
    // renders the reason on screen -- so the reason must name the block and none
    // of its values.
    const secret = generateSharedSecret();
    const base = managedRecord();
    const state = managedCronExportPanelState({
      ...base,
      exchangeFile: {
        ...base.exchangeFile,
        authentication: {
          sharedSecret: secret,
          expires: "2026-04-06T14:00:00.000Z",
        },
      },
    });
    expect(state.kind).toBe("refused");
    if (state.kind !== "refused") return;
    expect(state.reason).toContain("authentication");
    expect(state.reason).not.toContain(secret);
  });

  test("an out-of-composition document field is refused, naming no value", () => {
    // A signing block rides a hand-crafted artifact into a record the read path
    // admits (pinned in the composer's own suite), so the panel is a surface the
    // block reaches: every field here would be live on the operator's scheduled
    // run, and the reason names the block rather than any path or fingerprint.
    const state = managedCronExportPanelState(
      managedRecord({
        exchangeFile: assembleExchangeSpec({
          connection: connectionFromLocator(webrtcLocator),
          linkageTerms,
          signing,
        }),
      }),
    );
    expect(state.kind).toBe("refused");
    if (state.kind !== "refused") return;
    expect(state.reason).toContain("signing");
    for (const value of [
      signing.identityFile,
      signing.partnerFingerprint,
      signing.receiptOutput,
    ])
      expect(state.reason).not.toContain(value);
  });
});
