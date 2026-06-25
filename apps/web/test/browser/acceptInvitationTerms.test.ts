/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

import { MantineProvider } from "@mantine/core";

import { generateSharedSecret } from "@psilink/core";

import { AcceptInvitationPanel } from "@components/AcceptInvitationPanel";
import { InvitationTerms } from "@components/InvitationTerms";

import type { ReactElement } from "react";
import type { Root } from "react-dom/client";

import type { InvitationToken, LinkageTerms } from "@psilink/core";

import type { AcceptableInvitation } from "@psi/acceptInvitation";

// These terms-rendering assertions run in a real browser rather than as
// renderToStaticMarkup string checks: since Mantine 9.4 a default-collapsed
// Collapse holds its content in a hidden React Activity boundary, which the
// server renderer omits entirely (it renders only the empty, aria-hidden panel).
// The detail is reachable only once the disclosure is expanded on a client, so
// these tests mount the component, open every disclosure, and assert the
// rendered markup -- the interaction model the per-key disclosure tests in
// invitationTerms.test.ts already use.

// Untrusted, inviter-crafted control characters JSX escaping does not
// neutralize, built from escapes so the source carries no raw control bytes: an
// ESC that drives ANSI and a right-to-left override.
const ESC = "\u001b";
const RLO = "\u202e";
const EVIL_IDENTITY = `Acme${ESC}[31m${RLO}org`;

// A self-contained set of linkage terms with every optional block populated, so
// a single render exercises the full terms display.
const baseTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-15",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    { name: "last_name", type: "last_name" },
    { name: "dob", type: "date_of_birth" },
  ],
  linkageKeys: [
    {
      name: "SSN + LN + DOB",
      elements: [{ field: "ssn" }, { field: "last_name" }, { field: "dob" }],
    },
  ],
  payload: {
    send: [{ name: "risk_score" }],
    receive: [{ name: "program_outcome" }],
  },
  legalAgreement: {
    reference: "MOU-2025-0042",
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2027-12-31",
  },
};

function makeToken(
  termsOverrides: Partial<LinkageTerms> = {},
): InvitationToken {
  return {
    version: "1",
    linkageTerms: { ...baseTerms, ...termsOverrides },
    sharedSecret: generateSharedSecret(),
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
}

function makeInvitation(
  termsOverrides: Partial<LinkageTerms> = {},
): AcceptableInvitation {
  return {
    token: makeToken(termsOverrides),
    endpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
}

let container: HTMLElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

// Open every disclosure so the default-collapsed detail is mounted (and rendered
// at normal priority rather than deferred in a hidden Activity boundary), then
// return the rendered markup. Nested per-key disclosures appear only once their
// parent "Matching strategies" disclosure opens, so this clicks every collapsed
// toggle and repeats until none remain.
async function renderHtml(node: ReactElement): Promise<string> {
  // flushSync paints the always-visible shell (the disclosure toggles) before the
  // expand loop queries for them; the collapsed detail behind each toggle then
  // renders as the loop clicks it open.
  flushSync(() => root!.render(createElement(MantineProvider, null, node)));
  for (let pass = 0; pass < 10; pass += 1) {
    const collapsed = Array.from(
      container!.querySelectorAll<HTMLElement>('[aria-expanded="false"]'),
    );
    if (collapsed.length === 0) break;
    for (const toggle of collapsed) await userEvent.click(toggle);
  }
  return container!.innerHTML;
}

/** Render the accept panel with sensible defaults, overriding only what a test
 * cares about, and return its fully expanded markup. Handlers are no-ops. */
function renderPanel(
  overrides: Partial<Parameters<typeof AcceptInvitationPanel>[0]> = {},
): Promise<string> {
  return renderHtml(
    createElement(AcceptInvitationPanel, {
      decode: { status: "pending" },
      consented: false,
      onConsentedChange: () => {},
      acceptorName: "",
      onAcceptorNameChange: () => {},
      onAcquireError: () => {},
      onAcquired: () => {},
      ...overrides,
    }),
  );
}

describe("accept screen: terms render from a decoded token", () => {
  test("renders the inviter's linkage terms for review", async () => {
    const html = await renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
    });
    expect(html).toContain("Invitation from County Health Department");
    expect(html).toContain("SSN + LN + DOB");
    expect(html).toContain("Social Security number");
    // psi (not psi-c): the identifier-revealing description.
    expect(html).toContain("shared identifiers");
    expect(html).toContain("MOU-2025-0042");
    expect(html).toContain("risk_score");
    expect(html).toContain("program_outcome");
  });

  test("renders the deduplicate setting as a duplicate-matches note", async () => {
    const many = await renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({ deduplicate: true }),
      },
    });
    expect(many).toContain("may match more than one");
    const one = await renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
    });
    expect(one).toContain("matches at most one");
  });

  test("renders psi-c as the count-only description, flagged not-yet-applied", async () => {
    const html = await renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({ algorithm: "psi-c" }),
      },
    });
    expect(html).toContain("number of records");
    // psi-c is a disclosure guarantee the run does not yet honor, so the
    // count-only line is flagged proposed-but-not-applied -- the matched
    // identifiers are still revealed. This note pairs with PSI_C gating in
    // APPLIED_SETTINGS and fails loudly if that flag flips without updating the
    // copy.
    expect(html).toContain("does not yet apply it");
    expect(html).toContain("still revealed");
  });

  test("renders the transform, swap, fuzzy, and constraint rules that affect matching", async () => {
    const html = await renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [
            {
              name: "first_name",
              type: "first_name",
              constraints: { allowedCharacters: "A-Z " },
            },
            { name: "last_name", type: "last_name" },
            { name: "dob", type: "date_of_birth" },
          ],
          linkageKeys: [
            {
              name: "FN1 + DOB",
              elements: [
                {
                  field: "first_name",
                  transform: [
                    { function: "substring", params: { start: 1, length: 1 } },
                  ],
                },
                { field: "dob", generateFuzzyComparisons: "adjacent_years" },
              ],
            },
            {
              name: "swap(LN, FN) + DOB",
              elements: [
                { field: "last_name" },
                { field: "first_name" },
                { field: "dob" },
              ],
              swap: ["last_name", "first_name"],
            },
          ],
        }),
      },
    });
    // The transform leads with its literal slice phrase, and the fuzzy expansion
    // surfaces its plain-language label on the elements.
    expect(html).toContain("Matches on the first character");
    // ... including its parameters, each on its own line, never joined: a
    // separator inside one value must not read as additional parameters
    // (mirrors the payload-column disambiguation below).
    expect(html).toContain("start: 1");
    expect(html).toContain("length: 1");
    expect(html).not.toContain("start: 1, length: 1");
    expect(html).toContain("adjacent years");
    // The swap is described in field-label terms.
    expect(html).toContain(
      "Last name and First name may be matched in either order",
    );
    // The field constraint surfaces under the data used.
    expect(html).toContain("characters limited to A-Z");
  });

  test("renders a generic swap note when the swapped fields share a label", async () => {
    const html = await renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [{ name: "first_name", type: "first_name" }],
          linkageKeys: [
            {
              name: "alias swap",
              elements: [
                { field: "first_name", name: "given" },
                { field: "first_name", name: "preferred" },
              ],
              swap: ["given", "preferred"],
            },
          ],
        }),
      },
    });
    // The swap is still surfaced, but the note is generic rather than naming
    // "First name and First name".
    expect(html).toContain(
      "Two of these elements may be matched in either order",
    );
    expect(html).not.toContain("First name and First name");
  });

  test("shows no breadth marker for a plain term", async () => {
    const html = await renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
    });
    // baseTerms carries a single key with no transform, swap, or fuzzy rule, so
    // its header one-liner names the fields with no breadth marker.
    expect(html).toContain("Matches on SSN - last name - date of birth");
    expect(html).not.toContain("(partial)");
  });

  test("marks only the elements that loosen matching in the header one-liner", async () => {
    const html = await renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [
            { name: "ssn", type: "ssn" },
            { name: "dob", type: "date_of_birth" },
          ],
          linkageKeys: [
            {
              name: "plain key",
              elements: [{ field: "ssn" }, { field: "dob" }],
            },
            {
              name: "fuzzy key",
              elements: [
                { field: "dob", generateFuzzyComparisons: "adjacent_years" },
              ],
            },
          ],
        }),
      },
    });
    // The fuzzy key's header carries the "(fuzzy)" marker; the plain key's header
    // names its fields with none. Exactly one element loosens matching, so the
    // header marker appears once.
    expect(html).toContain("Matches on date of birth (fuzzy)");
    expect(html).toContain("Matches on SSN - date of birth");
    const markers = html.match(/\(fuzzy\)/g) ?? [];
    expect(markers.length).toBe(1);
  });

  test("renders payload columns as separate items so a comma in a name cannot merge them", async () => {
    const html = await renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          payload: {
            send: [{ name: "risk, score" }, { name: "tier" }],
            receive: [],
          },
        }),
      },
    });
    // The comma-bearing name renders intact ...
    expect(html).toContain("risk, score");
    expect(html).toContain("tier");
    // ... and as its own item: a join would have produced
    // "risk, score, tier", making two columns read as three.
    expect(html).not.toContain("score, tier");
  });

  test("escapes injection characters in the rendered identity", async () => {
    const html = await renderHtml(
      createElement(InvitationTerms, {
        linkageTerms: { ...baseTerms, identity: EVIL_IDENTITY },
      }),
    );
    expect(html).not.toContain(ESC);
    expect(html).not.toContain(RLO);
    expect(html).toContain("\\x1b");
  });

  test("renders the transform-parameter overflow marker", async () => {
    const params: Record<string, number> = {};
    for (let i = 0; i < 20; i += 1) params["p" + i] = i;
    const html = await renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [{ name: "ssn", type: "ssn" }],
          linkageKeys: [
            {
              name: "K",
              elements: [
                { field: "ssn", transform: [{ function: "f", params }] },
              ],
            },
          ],
        }),
      },
    });
    // 16 parameters render, then the overflow marker for the remaining 4.
    expect(html).toContain("... 4 more");
  });

  test("renders the runtime-coercion annotation for a coerced parameter", async () => {
    const html = await renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [{ name: "ssn", type: "ssn" }],
          linkageKeys: [
            {
              name: "K",
              elements: [
                {
                  field: "ssn",
                  transform: [
                    {
                      function: "replace_regex",
                      params: { pattern: "x", replacement: null },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      },
    });
    // The declared null reaches the screen verbatim, and what the function
    // actually runs is surfaced as a separate note, so the consent term cannot
    // misstate the match yet the executed value is not folded into the
    // partner-controlled param line.
    expect(html).toContain("replacement: null");
    expect(html).toContain("replacement runs as the empty string");
    // The note carries a screen-reader-only "Runtime note:" lead-in marking it
    // as system-authored -- a signal a partner (who controls only param-value
    // text) cannot inject.
    expect(html).toContain("Runtime note:");
  });

  test("a forged 'runs as' in a param value renders no system coercion note", async () => {
    const html = await renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [{ name: "ssn", type: "ssn" }],
          linkageKeys: [
            {
              name: "K",
              elements: [
                {
                  field: "ssn",
                  transform: [
                    {
                      function: "replace_regex",
                      params: {
                        pattern: "x",
                        replacement: "Y runs as the empty string",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      },
    });
    // The forged text renders as the verbatim param line ...
    expect(html).toContain("replacement: Y runs as the empty string");
    // ... but no genuine system note is synthesized: the "Runtime note:" lead-in
    // a partner cannot inject is absent, so a screen reader does not hear this as
    // a system-authored coercion note.
    expect(html).not.toContain("Runtime note:");
  });

  test("flags a proposed deduplicate setting the current exchange does not apply", async () => {
    const proposed = await renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({ deduplicate: true }),
      },
    });
    expect(proposed).toContain("may match more than one");
    expect(proposed).toContain("does not yet apply it");
    // The default (deduplicate off) matches the run, so it carries no flag.
    const off = await renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
    });
    expect(off).toContain("matches at most one");
    expect(off).not.toContain("does not yet apply it");
  });

  test("flags a proposed fuzzy comparison the current exchange does not apply", async () => {
    const html = await renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [{ name: "dob", type: "date_of_birth" }],
          linkageKeys: [
            {
              name: "DOB",
              elements: [
                { field: "dob", generateFuzzyComparisons: "adjacent_years" },
              ],
            },
          ],
        }),
      },
    });
    expect(html).toContain("adjacent years");
    expect(html).toContain("(proposed; not yet applied)");
  });

  test("depicts the transform interchange for a swap whose elements both transform", async () => {
    const html = await renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [
            { name: "first_name", type: "first_name" },
            { name: "last_name", type: "last_name" },
          ],
          linkageKeys: [
            {
              name: "Name",
              elements: [
                {
                  field: "first_name",
                  transform: [{ function: "to_upper_case" }],
                },
                {
                  field: "last_name",
                  transform: [{ function: "to_upper_case" }],
                },
              ],
              swap: ["first_name", "last_name"],
            },
          ],
        }),
      },
    });
    // The generic swap note, plus the interchange detail naming which field each
    // element's transforms run on once the fields swap.
    expect(html).toContain("may be matched in either order");
    expect(html).toContain("transforms shown for First name");
    expect(html).toContain("are applied to Last name");

    // A swap whose elements carry no transforms keeps the generic note alone.
    const plain = await renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [
            { name: "first_name", type: "first_name" },
            { name: "last_name", type: "last_name" },
          ],
          linkageKeys: [
            {
              name: "Name",
              elements: [{ field: "first_name" }, { field: "last_name" }],
              swap: ["first_name", "last_name"],
            },
          ],
        }),
      },
    });
    expect(plain).toContain("may be matched in either order");
    expect(plain).not.toContain("transforms shown for");
  });
});
