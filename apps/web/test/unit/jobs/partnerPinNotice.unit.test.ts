import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  partnerCertificatePinnedNotice,
  recordedPartnerFingerprint,
} from "@jobs/partnerPinNotice";
import { JOB_FILE_NAMES } from "@jobs/intentSchemas";
import { JobManager } from "@jobs/jobManager";
import { composeConfigDocument } from "@jobs/intentConfig";

import {
  STUB_CLI_PATH,
  tempDataRoot,
  validIntent,
  validLinkageTerms,
} from "../../utils/jobFixtures";

// What the console tells an operator when a run pinned the partner's signing
// certificate on a first authenticated contact. The CLI's own notice names the
// configuration file it wrote the pin into, a path inside this container, so the
// relay rebuilds the sentence from console copy and the recorded value.

/** A canonical 43-character fingerprint (the final character drawn from the
 * aligned set the config schema requires). */
const ADOPTED_FINGERPRINT = "E".repeat(42) + "A";

const dirs: Array<string> = [];
const managers: Array<JobManager> = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/** A composed exchange configuration on disk, as the manager writes one, with
 * the signing block the intent's mode produces. Composed rather than
 * hand-written: what the reader has to find is the key the composer emits, so a
 * document built any other way would stop testing that pairing. */
function composedConfigFile(pin: string | undefined): string {
  const dir = scratchDir("pin-config");
  const intent = validIntent({
    linkageTerms: { ...validLinkageTerms(), identity: "Agency A" },
    signing: {
      mode: "certificate",
      ...(pin !== undefined ? { partnerFingerprint: pin } : {}),
    },
  });
  const configPath = path.join(dir, JOB_FILE_NAMES.config);
  fs.writeFileSync(
    configPath,
    composeConfigDocument(intent, path.join(dir, "rendezvous"), undefined, {
      identityFile: path.join(dir, ".psilink-signing-identity.json"),
      receiptOutput: path.join(dir, JOB_FILE_NAMES.receipt),
    }),
  );
  return configPath;
}

describe("the recorded pin is read back from the composed configuration", () => {
  test("a pin on file is found under the key the composer emits", () => {
    expect(
      recordedPartnerFingerprint(composedConfigFile(ADOPTED_FINGERPRINT)),
    ).toBe(ADOPTED_FINGERPRINT);
  });

  test("a configuration with no pin yields none", () => {
    expect(recordedPartnerFingerprint(composedConfigFile(undefined))).toBe(
      undefined,
    );
  });

  test("a value that is not a canonical digest is not shown", () => {
    // The value comes back through a file. It is a digest the CLI derived, but
    // only a canonical one is put in front of the operator as a fingerprint to
    // compare.
    const configPath = composedConfigFile(ADOPTED_FINGERPRINT);
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace(ADOPTED_FINGERPRINT, "not-a-fingerprint"),
    );
    expect(recordedPartnerFingerprint(configPath)).toBe(undefined);
  });

  test("an unreadable or unparsable configuration yields none rather than throwing", () => {
    const dir = scratchDir("pin-unreadable");
    expect(recordedPartnerFingerprint(path.join(dir, "absent.yaml"))).toBe(
      undefined,
    );
    const broken = path.join(dir, JOB_FILE_NAMES.config);
    fs.writeFileSync(broken, "signing: [unclosed\n");
    expect(recordedPartnerFingerprint(broken)).toBe(undefined);
  });
});

describe("the notice states the pin without naming a file", () => {
  test("it gives the value, what the pin rests on, and what to do next", () => {
    const notice = partnerCertificatePinnedNotice(ADOPTED_FINGERPRINT);
    expect(notice).toContain(ADOPTED_FINGERPRINT);
    expect(notice).toMatch(/channel the invitation travelled/);
    expect(notice).toMatch(/psilink fingerprint/);
    // The console composes a fresh configuration per run, so an adopted pin is
    // lost unless the operator enters it -- unlike a command-line run, which
    // records it in the file it was passed.
    expect(notice).toMatch(/before the next exchange/);
  });

  test("a value it could not read back leaves the pin stated and the value out", () => {
    const notice = partnerCertificatePinnedNotice(undefined);
    expect(notice).toMatch(/pinned the signing certificate/);
    expect(notice).toMatch(/could not read the value back/);
  });
});

describe("the relayed notice carries no container path", () => {
  test("the CLI's wording is replaced by the console's, holding the pin", async () => {
    const dataRoot = scratchDir("pin-relay-root");
    const manager = new JobManager({
      dataRoot,
      binaryPath: STUB_CLI_PATH,
      jobRendezvousDir: scratchDir("pin-relay-rvz"),
      childEnv: {
        STUB_EXIT_CODE: "0",
        STUB_PARTNER_PIN: ADOPTED_FINGERPRINT,
        STUB_FD3_EVENTS: JSON.stringify([
          {
            v: 1,
            type: "warning",
            source: "partnerCertificatePinned",
            // The real sentence, which names the configuration file: what must
            // not reach the browser.
            message:
              "Pinned the partner's signing certificate on this first " +
              `contact: fingerprint ${ADOPTED_FINGERPRINT}, recorded as ` +
              "signing.partner_fingerprint in " +
              `${dataRoot}/jobs/some-id/psilink.yaml.`,
          },
          { v: 1, type: "result", resultWritten: true },
        ]),
      },
    });
    managers.push(manager);
    const id = await manager.createJob(
      validIntent({
        linkageTerms: { ...validLinkageTerms(), identity: "Agency A" },
        signing: { mode: "certificate" },
      }),
    );
    const record = manager.getJob(id)!;
    const deadline = Date.now() + 5000;
    while (!record.terminalEmitted) {
      if (Date.now() > deadline)
        throw new Error("timed out waiting for terminal");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const warnings = record.events
      .map((entry) => entry.event)
      .filter((event) => event.type === "warning");
    expect(warnings).toHaveLength(1);
    const notice = warnings[0];
    // The source is relayed unchanged, so a supervisor still switches on it.
    expect(notice.source).toBe("partnerCertificatePinned");
    expect(notice.message).toContain(ADOPTED_FINGERPRINT);
    expect(notice.message).not.toContain(dataRoot);
    expect(notice.message).not.toContain("psilink.yaml");
    expect(notice.message).toBe(
      partnerCertificatePinnedNotice(ADOPTED_FINGERPRINT),
    );
  });
});
