import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { decodeInvitation } from "@psilink/core";

import { acquireManagedInput } from "@psi/managed/managedInputHandle";
import { generateInvitation } from "@psi/invitation";
import { loadCSVFileOffMainThread } from "@psi/workers/csvParseController";
import { profileJobInput } from "@jobs/workInputs";

/**
 * Every web intake seat reads its CSV through core's parse boundary, which
 * removes the nine bidi control characters from each column name and reports the
 * positions it changed. This drives one case per seat -- the browser file entry
 * the inviter and acceptor share, the invitation mint's own re-parse, the
 * console's server-side profile behind the direct-exchange and picker seats, and
 * the managed run's input acquire -- so a seat that grows a parse of its own
 * fails here rather than putting a reordering name into the terms.
 *
 * Written as escapes, never as raw bytes, so the source of a test about
 * invisible characters is itself readable.
 */
const RLO = "\u202e";
const PDI = "\u2069";
const LRI = "\u2066";

/** The residual shape measured at the display sinks: an unmatched PDI closes the
 * isolate the sink wrapped the name in, leaving the override that follows it
 * running over the copy after the name. Removing both is what closes it at the
 * sinks no check drives. */
const RESIDUAL_NAME = `pre${PDI}mid${RLO}evil`;

/** A header the default terms can link on, holding the residual name plus two
 * ordinary non-ASCII names, which must pass through whole. */
const HEADER = `ssn,first_name,last_name,dob,${RESIDUAL_NAME},prénom,姓名 🎉`;
const SANITIZED = [
  "ssn",
  "first_name",
  "last_name",
  "dob",
  "premidevil",
  "prénom",
  "姓名 🎉",
];

const CSV = `${HEADER}\n123456789,Ada,Lovelace,1990-01-02,x,Ada,Lovelace\n`;

/** A fresh readable of `content`; each parse consumes its input once. */
function csvStream(content: string = CSV): Readable {
  return Readable.from(content);
}

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the browser file entry the inviter and acceptor seats share", () => {
  test("hands the seat stripped names and the positions to report", async () => {
    const result = await loadCSVFileOffMainThread(csvStream());
    expect(result.meta.fields).toEqual(SANITIZED);
    expect(result.meta.bidiStrippedColumns).toEqual([5]);
  });

  test("keys the rows by the stripped name, so no column's values are lost", async () => {
    const result = await loadCSVFileOffMainThread(csvStream());
    expect(result.data).toEqual([
      {
        ssn: "123456789",
        first_name: "Ada",
        last_name: "Lovelace",
        dob: "1990-01-02",
        premidevil: "x",
        prénom: "Ada",
        "姓名 🎉": "Lovelace",
      },
    ]);
  });

  test("leaves an ordinary non-ASCII header untouched and reports nothing", async () => {
    const result = await loadCSVFileOffMainThread(
      csvStream("ssn,prénom,姓名,имя 🎉\n1,Ada,愛,Ада\n"),
    );
    expect(result.meta.fields).toEqual(["ssn", "prénom", "姓名", "имя 🎉"]);
    expect(result.meta.bidiStrippedColumns).toEqual([]);
  });
});

describe("the invitation mint's own re-parse", () => {
  test("mints terms and a payload the partner reads under the stripped name", async () => {
    const { encoded, columns, rawRows } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location: new URL("https://example.org/invite"),
    });
    expect(columns).toEqual(SANITIZED);
    expect(rawRows[0]).toHaveProperty("premidevil");

    // Both parties describe the column the same way: what the partner receives is
    // the name this seat matched on.
    const token = await decodeInvitation(encoded);
    const names = JSON.stringify(token.linkageTerms);
    expect(names).not.toContain(RLO);
    expect(names).not.toContain(PDI);
    expect(names).not.toContain(LRI);
  });
});

describe("the console's profile behind the direct-exchange and picker seats", () => {
  test("reports the stripped names and the positions over the wire", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bidi-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "input.csv"), CSV, "utf8");

    const profile = await profileJobInput(dir, "input.csv");
    expect(profile.columns).toEqual(SANITIZED);
    expect(profile.bidiStrippedColumns).toEqual([5]);
    // The per-column samples are keyed by the same stripped name the seat marks.
    expect(profile.columnSamples.map((entry) => entry.column)).toEqual(
      SANITIZED,
    );
  });
});

describe("the managed run's input acquire", () => {
  test("reads the stripped names the standing terms were authored on", async () => {
    // The `file` source is the re-selection path (a browser without the File
    // System Access API). A readable stands in for the platform File here, which
    // core parses identically; the handle path's real read is driven in
    // test/browser/managedInputHandle.test.ts.
    const acquired = await acquireManagedInput({
      kind: "file",
      file: csvStream() as unknown as File,
    });
    expect(acquired.columns).toEqual(SANITIZED);
    expect(acquired.rows[0]).toHaveProperty("premidevil");
  });
});
