import { describe, expect, test } from "vitest";
import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  snakeizeKeys,
} from "@alcove/core";

import { stringify as stringifyYaml } from "yaml";

import { readManagedCommandLineConfiguration } from "@psi/managed/managedCommandLineImport";

import {
  MANAGED_EXCHANGE_PREVIOUS_ARTIFACT_VERSION,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  OUTDATED_IMPORT_REASON,
  UNREADABLE_IMPORT_REASON,
  UNRECOGNIZED_IMPORT_REASON,
  alreadyHeldBackupImportReason,
  chosenCopyImportReason,
  importFailureReason,
  liveCopyImportReason,
  liveCopyOpenLabel,
  otherExchangeRestoreReason,
  sideMismatchImportReason,
  storedCopyImportReason,
  storedCopyTakeLabel,
} from "@recurring/managedImportFailure";
import {
  encodeManagedExchangeArtifact,
  importManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";
import { ManagedImportChosenCopyError } from "@psi/managed/managedExchangeImport";

import type {
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type {
  WebRTCConnectionConfig,
  WebRTCExchangeLocator,
} from "@alcove/core";

/** A record built from `fields` and narrowed to the runnable shape: every fixture
 * here is built with a shared secret, and the export paths take the record type
 * that holds one. */
function runnableRecord(
  fields: NewManagedExchange,
): RunnableManagedExchangeRecord {
  return runnableManagedExchangeOrRefuse(buildManagedExchangeRecord(fields));
}

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
  const record = runnableRecord({
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

/** A hand-written command-line configuration, as the file on disk holds it: the
 * document this app composes plus the `role` the CLI reads. Loosely typed, since
 * what it is here for is being edited off the schema. */
function configurationDocument(): Record<string, unknown> & {
  connection: WebRTCConnectionConfig;
} {
  const composed = composeManagedExchangeFile({
    connection: webrtcLocator,
    linkageTerms: getDefaultLinkageTerms("County Health Dept"),
  });
  const connection = composed.connection as WebRTCConnectionConfig;
  return { ...composed, connection: { ...connection, role: "acceptor" } };
}

/** The reason the affordance shows for a command-line configuration it refuses. */
function reasonForImportingConfiguration(
  document: Record<string, unknown>,
): string {
  try {
    readManagedCommandLineConfiguration(stringifyYaml(snakeizeKeys(document)));
  } catch (error) {
    return importFailureReason(error);
  }
  throw new Error("the import was expected to refuse this configuration");
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
    document.artifactVersion = "alcove-managed-exchange-artifact/v3";

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

describe("a command-line configuration off the exchange-file schema", () => {
  test("names the fields to fix, in the spelling the file writes them", () => {
    const document = configurationDocument();

    const reason = reasonForImportingConfiguration({
      ...document,
      csvDelimiter: ";;",
      connection: {
        ...document.connection,
        server: { ...document.connection.server, port: 70_000 },
      },
    });

    expect(reason).toContain("csv_delimiter");
    expect(reason).toContain("connection.server.port");
    expect(reason).toContain("import it again");
    expect(reason).not.toBe(UNRECOGNIZED_IMPORT_REASON);
    expect(reason).not.toContain("newer version");
  });

  test("a backup envelope missing a field keeps the version wording", () => {
    // The two schema failures part here: the operator wrote the configuration
    // above by hand and can fix the line it names, while a backup file this app
    // wrote is only explained by the build that wrote it.
    const document = artifactDocument();
    delete document.local;

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
        "be restored. Check that you chose the backup file you exported and " +
        "that it was not modified. Set up a new exchange with your partner " +
        "instead. Delete the old exchange if this browser still holds it.",
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

/** Every reason a backup import can be refused or stopped with, where a
 * listed exchange is involved. */
const LISTED_EXCHANGE_REASONS: Array<[string, string]> = [
  ["already held", alreadyHeldBackupImportReason("Riverbend quarterly")],
  ["a possible live copy", liveCopyImportReason(["Riverbend quarterly"])],
  ["a scoped restore", otherExchangeRestoreReason("Riverbend quarterly")],
];

describe("what a backup import says about an exchange already listed", () => {
  test("each names the listed exchange, and an unnamed one neutrally", () => {
    for (const [, reason] of LISTED_EXCHANGE_REASONS)
      expect(reason).toContain('"Riverbend quarterly"');
    expect(alreadyHeldBackupImportReason("")).toMatch(/^That exchange /);
    expect(liveCopyImportReason([""])).toMatch(/^An exchange in the list /);
    expect(otherExchangeRestoreReason("")).toContain("this exchange");
  });

  test("the possible live copy states nothing was imported and both ways on", () => {
    const reason = liveCopyImportReason(["Riverbend quarterly"]);
    expect(reason).toContain("Nothing was imported.");
    expect(reason).toContain("open it from the list");
    expect(reason).toContain("add this backup beside it");
  });

  test("several possible live copies are named in one reason", () => {
    const reason = liveCopyImportReason(["Riverbend quarterly", "", "Weekly"]);
    expect(reason).toMatch(/^3 exchanges in the list /);
    expect(reason).toContain(
      '"Riverbend quarterly", "Weekly", and 1 with no name',
    );
    expect(reason).toContain("Nothing was imported.");
    expect(reason).toContain("add this backup beside them");
    expect(liveCopyImportReason(["", ""])).toMatch(
      /^2 exchanges in the list have /,
    );
  });

  test("one open button for one copy, one per copy for several", () => {
    expect(liveCopyOpenLabel(["Riverbend quarterly"], 0)).toBe(
      "Open the listed exchange",
    );
    expect(liveCopyOpenLabel(["Riverbend quarterly", ""], 0)).toBe(
      'Open "Riverbend quarterly"',
    );
    expect(liveCopyOpenLabel(["Riverbend quarterly", ""], 1)).toBe(
      "Open listed exchange 2",
    );
  });

  test("no reason advises clearing the list to import", () => {
    for (const [name, reason] of [
      ...LISTED_EXCHANGE_REASONS,
      ["unreadable", UNREADABLE_IMPORT_REASON],
      ["unrecognized", UNRECOGNIZED_IMPORT_REASON],
      ["outdated", OUTDATED_IMPORT_REASON],
    ]) {
      expect(reason, name).not.toMatch(/\bevery\b|\ball\b/i);
      expect(reason, name).not.toMatch(/no recurring exchanges/i);
    }
  });
});

describe("what a pair import says about a stored exchange it may belong to", () => {
  test("names the one exchange, what it is, and each way on", () => {
    const reason = storedCopyImportReason([
      { id: "a", label: "Riverbend", state: "configuration-only" },
    ]);
    expect(reason).toContain('"Riverbend"');
    expect(reason).toMatch(/configuration without its key file/);
    expect(reason).toMatch(/Nothing was imported/);
    expect(reason).toMatch(/complete it with these files/);
    expect(reason).toMatch(/add these files as a new one/);
    expect(reason).not.toMatch(/stop its scheduled run/);
  });

  test("offering a hand-off back says to stop the command line first", () => {
    const reason = storedCopyImportReason([
      { id: "a", label: "", state: "handed-off" },
    ]);
    expect(reason).toMatch(/handed off to the command line/);
    expect(reason).toMatch(/take it back with these files/);
    expect(reason).toMatch(/stop its scheduled run/);
  });

  test("names several exchanges together", () => {
    const copies = [
      { id: "a", label: "Riverbend", state: "migration-spent" },
      { id: "b", label: "", state: "handed-off" },
    ] as const;
    expect(storedCopyImportReason(copies)).toMatch(
      /2 exchanges in the list \("Riverbend", and 1 with no name\)/,
    );
    expect(storedCopyTakeLabel(copies, 0)).toBe('Restore "Riverbend"');
    expect(storedCopyTakeLabel(copies, 1)).toBe("Take listed exchange 2 back");
  });

  test("each button says what it does to the exchange", () => {
    expect(
      storedCopyTakeLabel([{ id: "a", label: "", state: "handed-off" }], 0),
    ).toBe("Take it back");
    expect(
      storedCopyTakeLabel(
        [{ id: "a", label: "Riverbend", state: "configuration-only" }],
        0,
      ),
    ).toBe('Complete "Riverbend"');
  });

  test("a pair for the other side names the exchange and the partner's files", () => {
    const reason = sideMismatchImportReason("Riverbend");
    expect(reason).toContain('"Riverbend"');
    expect(reason).toMatch(/other side/);
    expect(reason).toMatch(/partner's files/);
    expect(reason).toMatch(/nothing was imported/);
  });

  test("a chosen exchange that could not take the files says what to do", () => {
    expect(
      chosenCopyImportReason(new ManagedImportChosenCopyError("run-in-flight")),
    ).toMatch(/When it finishes, import the files again/);
    expect(
      chosenCopyImportReason(new ManagedImportChosenCopyError("changed")),
    ).toMatch(/changed since you chose it.*Import the files again/);
  });
});
