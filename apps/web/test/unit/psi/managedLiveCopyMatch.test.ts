import { describe, expect, test } from "vitest";

import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  findRecordsByTermsAndSide,
  sameAgreedTermsAndSide,
} from "@psi/managed/managedLiveCopyMatch";

import type { LinkageTerms } from "@alcove/core";
import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

// The terms-and-side rule on its own: which stored record an import is named
// against when no secret matches. The store's use of it, against real
// IndexedDB, is the browser suite's.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

function record(
  overrides: { side?: "inviter" | "acceptor"; terms?: LinkageTerms } = {},
): ManagedExchangeRecord {
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: overrides.terms ?? linkageTerms,
    }),
    side: overrides.side ?? "inviter",
    sharedSecret: generateSharedSecret(),
  });
}

describe("sameAgreedTermsAndSide", () => {
  test("two records on the same terms and side match, whatever their secrets", () => {
    expect(sameAgreedTermsAndSide(record(), record())).toBe(true);
  });

  test("the other side of the same terms does not match", () => {
    expect(sameAgreedTermsAndSide(record(), record({ side: "acceptor" }))).toBe(
      false,
    );
  });

  test("a change to a term the partner checks does not match", () => {
    const changed: LinkageTerms = {
      ...linkageTerms,
      linkageFields: linkageTerms.linkageFields.slice(1),
    };
    const stored = record();
    const imported: ManagedExchangeRecord = {
      ...stored,
      exchangeFile: { ...stored.exchangeFile, linkageTerms: changed },
    };

    expect(sameAgreedTermsAndSide(stored, imported)).toBe(false);
  });

  test("this party's own name and the terms' date are not agreed terms", () => {
    const stored = record();
    const imported: ManagedExchangeRecord = {
      ...stored,
      exchangeFile: {
        ...stored.exchangeFile,
        linkageTerms: {
          ...linkageTerms,
          identity: "Renamed Dept",
          date: "2020-01-01",
        },
      },
    };

    expect(sameAgreedTermsAndSide(stored, imported)).toBe(true);
  });

  test("a stored record with no side matches nothing", () => {
    const stored = record();
    const { side: _side, ...sideless } = stored;

    expect(sameAgreedTermsAndSide(sideless, record())).toBe(false);
  });
});

describe("findRecordsByTermsAndSide", () => {
  test("names every live record the rule matches, in store order", () => {
    const first = record();
    const other = record({ side: "acceptor" });
    const second = record();

    expect(findRecordsByTermsAndSide([first, other, second], record())).toEqual(
      [first, second],
    );
  });

  test("names nothing where the rule matches nothing", () => {
    expect(
      findRecordsByTermsAndSide([record({ side: "acceptor" })], record()),
    ).toEqual([]);
  });

  test("passes over every record the operator confirmed going beside", () => {
    const first = record();
    const second = record();

    expect(
      findRecordsByTermsAndSide([first, second], record(), [
        first.id,
        second.id,
      ]),
    ).toEqual([]);
  });

  test("names a match the confirm did not acknowledge", () => {
    const confirmed = record();
    const second = record();

    expect(
      findRecordsByTermsAndSide([confirmed, second], record(), [confirmed.id]),
    ).toEqual([second]);
  });
});
