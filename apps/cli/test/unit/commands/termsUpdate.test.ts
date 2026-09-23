import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import YAML from "yaml";
import {
  decodeTermsUpdate,
  deriveAcceptedLinkageTerms,
  deriveOutboundPayloadConsent,
  encodeTermsUpdate,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
  parseExchangeSpec,
} from "@psilink/core";
import type { ExchangeSpec, LinkageTerms, Metadata } from "@psilink/core";

vi.mock("../../../src/util/prompt", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/util/prompt")
  >("../../../src/util/prompt");
  return { ...actual, promptConfirm: vi.fn() };
});

import { handler as applyHandler } from "../../../src/commands/apply";
import { handler as updateHandler } from "../../../src/commands/update";
import { saveConfig } from "../../../src/config";
import { saveKeyFile } from "../../../src/keyFile";
import { promptConfirm } from "../../../src/util/prompt";
import { captureProcessExit } from "../../exitCapture";
import { captureStdio } from "../../loggingTestSupport";

const promptConfirmMock = vi.mocked(promptConfirm);

const LINKAGE_COLUMNS = ["first_name", "last_name", "dob", "ssn"];

interface Party {
  config: string;
  key: string;
}

interface Partnership {
  dir: string;
  a: Party;
  b: Party;
  secret: string;
  aTerms: LinkageTerms;
}

let partnership: Partnership;

function metadataWith(...extra: string[]): Metadata {
  return inferMetadata([...LINKAGE_COLUMNS, ...extra], []);
}

/**
 * An established partnership as `psilink invite` and `psilink accept` leave
 * it: Agency A's configuration discloses `notes`, Agency B's records that
 * commitment and discloses `program`, and both key files hold one secret.
 */
function establishPartnership(): Partnership {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-terms-update-"));
  const a = { config: path.join(dir, "a.yaml"), key: path.join(dir, "a.key") };
  const b = { config: path.join(dir, "b.yaml"), key: path.join(dir, "b.key") };
  const aTerms = getDefaultLinkageTerms(
    "Agency A",
    inferMetadata(LINKAGE_COLUMNS, []),
  );
  saveConfig(a.config, {
    connection: { channel: "filedrop", path: "/mnt/a" },
    linkageTerms: aTerms,
    metadata: metadataWith("notes"),
    disclosedPayloadColumns: ["notes"],
  });
  const bTerms = deriveAcceptedLinkageTerms(aTerms, "Agency B");
  const bMetadata = metadataWith("program");
  const bOutbound = deriveOutboundPayloadConsent(bTerms.output, bMetadata);
  saveConfig(b.config, {
    connection: { channel: "filedrop", path: "/mnt/b" },
    linkageTerms: bTerms,
    metadata: bMetadata,
    expectedPayloadColumns: ["notes"],
    expectedPartnerDeduplicate: false,
    ...(bOutbound !== undefined ? { outboundPayloadConsent: bOutbound } : {}),
  });
  const secret = generateSharedSecret();
  saveKeyFile(a.key, { sharedSecret: secret });
  saveKeyFile(b.key, { sharedSecret: secret });
  return { dir, a, b, secret, aTerms };
}

/** Agency A's edit: one linkage key fewer, and `county` disclosed too. */
function editAgencyA(): LinkageTerms {
  const edited: LinkageTerms = {
    ...partnership.aTerms,
    linkageKeys: partnership.aTerms.linkageKeys.slice(1),
  };
  saveConfig(partnership.a.config, {
    ...readSpec(partnership.a.config),
    linkageTerms: edited,
    metadata: metadataWith("notes", "county"),
  });
  return edited;
}

function readSpec(configPath: string): ExchangeSpec {
  return parseExchangeSpec(YAML.parse(fs.readFileSync(configPath, "utf8")));
}

function argv(
  command: string,
  party: Party,
  extra: Record<string, unknown> = {},
): Arguments {
  return {
    _: [command],
    $0: "psilink",
    "config-file": party.config,
    "key-file": party.key,
    "log-level": "info",
    ...extra,
  } as unknown as Arguments;
}

/** Run `psilink update` for Agency A, returning the printed update. */
async function runUpdate(): Promise<string> {
  const printedLines: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      printedLines.push(args.map(String).join(" "));
    });
  const stdio = captureStdio();
  try {
    await updateHandler(argv("update", partnership.a));
  } finally {
    stdio.restore();
    logSpy.mockRestore();
  }
  const printed = printedLines.join("\n").trim();
  expect(printed).not.toBe("");
  return printed;
}

/** Run `psilink apply` for Agency B; returns stderr and the exit code. */
async function runApply(
  update: string,
  party: Party = partnership.b,
): Promise<{ stderr: string; exit: string | undefined }> {
  const exitSpy = captureProcessExit();
  const stdio = captureStdio();
  let exit: string | undefined;
  try {
    await applyHandler(argv("apply", party, { args: [update] }));
  } catch (err) {
    exit = err instanceof Error ? err.message : String(err);
  } finally {
    stdio.restore();
    exitSpy.mockRestore();
  }
  return { stderr: stdio.stderrWrites.join(""), exit };
}

beforeEach(() => {
  partnership = establishPartnership();
  promptConfirmMock.mockReset();
});

afterEach(() => {
  fs.rmSync(partnership.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("psilink update", () => {
  test("prints the edited terms and disclosed columns, authenticated under the key file's secret", async () => {
    const edited = editAgencyA();
    const keyBefore = fs.readFileSync(partnership.a.key, "utf8");
    const printed = await runUpdate();

    const update = await decodeTermsUpdate(printed, partnership.secret);
    expect(update.linkageTerms).toEqual(edited);
    expect(update.disclosedPayloadColumns).toEqual(["notes", "county"]);
    expect(printed).not.toContain(partnership.secret);

    const after = readSpec(partnership.a.config);
    expect(after.disclosedPayloadColumns).toEqual(["notes", "county"]);
    expect(after.outboundPayloadConsent).toBeUndefined();
    expect(fs.readFileSync(partnership.a.key, "utf8")).toBe(keyBefore);
  });

  test("refuses without a key file, printing nothing", async () => {
    fs.rmSync(partnership.a.key);
    const exitSpy = captureProcessExit();
    const printed: unknown[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        printed.push(...args);
      });
    const stdio = captureStdio();
    try {
      await expect(
        updateHandler(argv("update", partnership.a)),
      ).rejects.toThrow("exit:64");
    } finally {
      stdio.restore();
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
    expect(printed).toEqual([]);
    expect(stdio.stderrWrites.join("")).toContain("no key file at");
  });
});

describe("psilink apply", () => {
  test("rewrites the linkage terms and refreshes every record in one write", async () => {
    const edited = editAgencyA();
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue(true);

    const { exit } = await runApply(update);
    expect(exit).toBeUndefined();
    expect(promptConfirmMock).toHaveBeenCalledTimes(1);

    const after = readSpec(partnership.b.config);
    expect(after.linkageTerms).toEqual(
      deriveAcceptedLinkageTerms(edited, "Agency B", false),
    );
    expect(after.expectedPayloadColumns).toEqual(["notes", "county"]);
    expect(after.expectedPartnerDeduplicate).toBe(edited.deduplicate);
    expect(after.outboundPayloadConsent).toEqual(
      deriveOutboundPayloadConsent(after.linkageTerms.output, after.metadata),
    );
  });

  test("records the partner's changed deduplicate and keeps this party's own", async () => {
    const edited: LinkageTerms = { ...partnership.aTerms, deduplicate: true };
    saveConfig(partnership.a.config, {
      ...readSpec(partnership.a.config),
      linkageTerms: edited,
    });
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue(true);

    const { exit, stderr } = await runApply(update);
    expect(exit).toBeUndefined();
    expect(stderr).toContain("your partner's deduplicate");
    const after = readSpec(partnership.b.config);
    expect(after.expectedPartnerDeduplicate).toBe(true);
    expect(after.linkageTerms.deduplicate).toBe(false);
  });

  test("neither rotates the shared secret nor touches the connection block", async () => {
    editAgencyA();
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue(true);
    const keyBefore = fs.readFileSync(partnership.b.key, "utf8");
    const connectionBefore = readSpec(partnership.b.config).connection;

    const { exit } = await runApply(update);
    expect(exit).toBeUndefined();
    expect(fs.readFileSync(partnership.b.key, "utf8")).toBe(keyBefore);
    expect(readSpec(partnership.b.config).connection).toEqual(connectionBefore);
  });

  test("states a disclosed-column change on its own line, apart from the terms", async () => {
    editAgencyA();
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue(false);

    const { stderr } = await runApply(update);
    const lines = stderr.split("\n");
    expect(lines).toContain("  columns you will receive: change");
    expect(
      lines.some((line) => line.startsWith("  linkage terms: linkage_keys")),
    ).toBe(true);
    expect(lines).toContain("      county");
  });

  test("a disclosure-only update reports the linkage terms unchanged", async () => {
    saveConfig(partnership.a.config, {
      ...readSpec(partnership.a.config),
      metadata: metadataWith("notes", "county"),
    });
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue(false);

    const { stderr } = await runApply(update);
    const lines = stderr.split("\n");
    expect(lines).toContain("  linkage terms: no change");
    expect(lines).toContain("  columns you will receive: change");
  });

  test("declining leaves the configuration byte-identical", async () => {
    editAgencyA();
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue(false);
    const before = fs.readFileSync(partnership.b.config, "utf8");

    const { exit, stderr } = await runApply(update);
    expect(exit).toBeUndefined();
    expect(stderr).toContain(
      "update declined; the configuration was not changed",
    );
    expect(fs.readFileSync(partnership.b.config, "utf8")).toBe(before);
  });

  test("an update altered after it was made is refused by the MAC check before anything is shown", async () => {
    const encoded = await encodeTermsUpdate(
      { linkageTerms: partnership.aTerms, disclosedPayloadColumns: ["notes"] },
      partnership.secret,
    );
    const [body, mac] = encoded.split(".") as [string, string];
    const content = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    content["disclosedPayloadColumns"] = ["notes", "ssn"];
    const tampered = `${Buffer.from(JSON.stringify(content)).toString(
      "base64url",
    )}.${mac}`;
    const before = fs.readFileSync(partnership.b.config, "utf8");

    const { exit, stderr } = await runApply(tampered);
    expect(exit).toBe("exit:64");
    expect(stderr).toContain("refused by the MAC check");
    expect(stderr).not.toContain("Terms update details");
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(partnership.b.config, "utf8")).toBe(before);
  });

  test("an update made for another partnership is refused by the partnership check", async () => {
    const encoded = await encodeTermsUpdate(
      { linkageTerms: partnership.aTerms },
      generateSharedSecret(),
    );
    const before = fs.readFileSync(partnership.b.config, "utf8");

    const { exit, stderr } = await runApply(encoded);
    expect(exit).toBe("exit:64");
    expect(stderr).toContain("refused by the partnership check");
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(partnership.b.config, "utf8")).toBe(before);
  });

  test("an update made from this party's own configuration is refused", async () => {
    editAgencyA();
    const update = await runUpdate();
    const before = fs.readFileSync(partnership.a.config, "utf8");

    const { exit, stderr } = await runApply(update, partnership.a);
    expect(exit).toBe("exit:64");
    expect(stderr).toContain("names your own identity");
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(partnership.a.config, "utf8")).toBe(before);
  });
});
