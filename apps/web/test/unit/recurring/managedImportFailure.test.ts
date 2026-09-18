import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  MANAGED_EXCHANGE_PREVIOUS_ARTIFACT_VERSION,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  OUTDATED_IMPORT_REASON,
  UNREADABLE_IMPORT_REASON,
  UNRECOGNIZED_IMPORT_REASON,
  importFailureReason,
} from "@recurring/managedImportFailure";
import {
  encodeManagedExchangeArtifact,
  importManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";

import type { WebRTCExchangeLocator } from "@psilink/core";

// What the import affordance says about a file it will not take. The copy is
// driven from real rejections rather than a hand-made error, so a route that
// stops being a schema failure fails this test rather than quietly showing the
// operator the wrong remedy.

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

/** A valid artifact as the loose document a newer build's extra markers are
 * added to. */
function artifactDocument(): Record<string, unknown> {
  const record = buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
  });
  return encodeManagedExchangeArtifact(record) as unknown as Record<
    string,
    unknown
  >;
}

function serialize(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** The reason the affordance shows for bytes the import refuses. */
function reasonForImporting(source: string): string {
  try {
    importManagedExchangeArtifact(source);
  } catch (error) {
    return importFailureReason(error);
  }
  throw new Error("the import was expected to refuse these bytes");
}

describe("a backup file the artifact schema rejects", () => {
  test("names a newer version as a cause, with both ways past it", () => {
    const document = artifactDocument();
    document.local = {
      ...(document.local as Record<string, unknown>),
      heldSigningIdentity: true,
    };

    const reason = reasonForImporting(serialize(document));

    expect(reason).toBe(UNRECOGNIZED_IMPORT_REASON);
    expect(reason).toBe(
      "This app does not recognize what the backup file holds. It may have " +
        "been exported by a newer version of this app than this page is " +
        "running: reload this page to use the current version, or export the " +
        "backup again from the device that wrote this file. Otherwise check " +
        "that you chose the backup file you exported and that it was not " +
        "modified.",
    );
  });

  test("says the same for an artifact version this build does not know", () => {
    const document = artifactDocument();
    document.artifactVersion = "psilink-managed-exchange-artifact/v2";

    expect(reasonForImporting(serialize(document))).toBe(
      UNRECOGNIZED_IMPORT_REASON,
    );
  });

  test("says the same for an embedded document this build does not know", () => {
    const document = artifactDocument();
    document.exchangeDocument = `${document.exchangeDocument as string}later_agreed_option: true\n`;

    expect(reasonForImporting(serialize(document))).toBe(
      UNRECOGNIZED_IMPORT_REASON,
    );
  });
});

describe("a backup file from the previous artifact format", () => {
  test("says the file is older, and gives an older file's way on", () => {
    // Every backup taken before the response existed holds this tag. Told the
    // newer-build story, the operator would reload a page that is already current
    // and re-export from a device that cannot write this format any more.
    const document = artifactDocument();
    document.artifactVersion = MANAGED_EXCHANGE_PREVIOUS_ARTIFACT_VERSION;

    const reason = reasonForImporting(serialize(document));

    expect(reason).toBe(OUTDATED_IMPORT_REASON);
    expect(reason).toBe(
      "This backup was written by an earlier version of this app and cannot " +
        "be restored. Set up a new exchange with your partner instead. Delete " +
        "the old exchange if this browser still holds it.",
    );
    expect(reason).not.toContain("newer version");
    expect(reason).not.toContain("reload");
  });
});

describe("a backup file that does not parse", () => {
  test("is the file's own problem, and says nothing about a version", () => {
    const reason = reasonForImporting("not a backup file at all");

    expect(reason).toBe(UNREADABLE_IMPORT_REASON);
    expect(reason).not.toContain("version");
  });

  test("an embedded document that is not YAML falls the same way", () => {
    const document = artifactDocument();
    document.exchangeDocument = "connection: [\n";

    expect(reasonForImporting(serialize(document))).toBe(
      UNREADABLE_IMPORT_REASON,
    );
  });
});

describe("a failure that is not the file's", () => {
  test("keeps the operator on the file rather than blaming a version", () => {
    expect(importFailureReason(new Error("the store would not open"))).toBe(
      UNREADABLE_IMPORT_REASON,
    );
  });
});

/** The serialized artifact the export actually writes still imports, so the
 * rejections above are the fixtures' doing and not the fixture builder's. */
describe("the artifact this build writes", () => {
  test("imports without reaching a refusal at all", () => {
    expect(() =>
      importManagedExchangeArtifact(
        serializeManagedExchangeArtifact(
          artifactDocument() as unknown as Parameters<
            typeof serializeManagedExchangeArtifact
          >[0],
        ),
      ),
    ).not.toThrow();
  });
});
