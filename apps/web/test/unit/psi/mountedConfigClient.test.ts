import { describe, expect, test } from "vitest";

import { getDefaultLinkageTerms } from "@psilink/core";

import { fetchMountedConfiguration } from "@psi/jobClient/mountedConfigClient";

// The browser's read of the mounted configuration. It fails toward
// `unavailable`: a body this cannot narrow reaches the load control as a read
// that did not answer, never as a document with fields missing, since a
// half-read answer would pre-fill an authoring step with a setting nobody chose.

const DOCUMENT = {
  channel: "sftp",
  server: { host: "sftp.partner.example" },
  linkageTerms: getDefaultLinkageTerms("County Health"),
};

function answering(
  status: number,
  body: unknown,
): { fetchImpl: typeof fetch; urls: Array<string> } {
  const urls: Array<string> = [];
  const fetchImpl = ((url: string) => {
    urls.push(url);
    return Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe("a definitive answer", () => {
  test("a mount holding no configuration reads as absent", async () => {
    const { fetchImpl, urls } = answering(200, {
      configured: true,
      present: false,
      carriedThrough: [],
      warnings: [],
    });
    expect(await fetchMountedConfiguration(fetchImpl)).toEqual({
      kind: "absent",
    });
    expect(urls).toEqual(["/api/jobs/config"]);
  });

  test("a present configuration reads as opened, with both lists", async () => {
    const { fetchImpl } = answering(200, {
      configured: true,
      present: true,
      document: DOCUMENT,
      carriedThrough: ["signing.receipt_output"],
      warnings: ["connection.server.password"],
    });
    const answer = await fetchMountedConfiguration(fetchImpl);
    expect(answer.kind).toBe("opened");
    if (answer.kind !== "opened") throw new Error("expected an opened answer");
    expect(answer.document.channel).toBe("sftp");
    expect(answer.carriedThrough).toEqual(["signing.receipt_output"]);
    expect(answer.warnings).toEqual(["connection.server.password"]);
  });

  test("a refusal keeps the console's own text", async () => {
    const error = "This configuration runs over webrtc.";
    const { fetchImpl } = answering(400, { error });
    expect(await fetchMountedConfiguration(fetchImpl)).toEqual({
      kind: "refused",
      error,
    });
  });

  test("a refusal with no readable body still stops the load", async () => {
    const { fetchImpl } = answering(400, undefined);
    const answer = await fetchMountedConfiguration(fetchImpl);
    expect(answer.kind).toBe("refused");
    if (answer.kind !== "refused") throw new Error("expected a refusal");
    expect(answer.error).toMatch(/could not be opened/);
  });
});

describe("an answer this cannot read", () => {
  test.each([
    ["a non-2xx that is not a refusal", 500, { present: true }],
    ["no present field", 200, { configured: true }],
    ["present with no document", 200, { present: true, carriedThrough: [] }],
    [
      "a document on a channel the console does not conduct",
      200,
      {
        present: true,
        document: { ...DOCUMENT, channel: "webrtc" },
        carriedThrough: [],
        warnings: [],
      },
    ],
    [
      "a document with no linkage terms",
      200,
      {
        present: true,
        document: { channel: "sftp" },
        carriedThrough: [],
        warnings: [],
      },
    ],
    [
      "a held list holding something that is not a name",
      200,
      {
        present: true,
        document: DOCUMENT,
        carriedThrough: [{ field: "signing.receipt_output" }],
        warnings: [],
      },
    ],
    [
      "a warning list that is not a list",
      200,
      {
        present: true,
        document: DOCUMENT,
        carriedThrough: [],
        warnings: "connection.server.password",
      },
    ],
  ])("%s reads as unavailable", async (_name, status, body) => {
    const { fetchImpl } = answering(status, body);
    expect(await fetchMountedConfiguration(fetchImpl)).toEqual({
      kind: "unavailable",
    });
  });

  test("a read that threw reads as unavailable", async () => {
    const fetchImpl = (() =>
      Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await fetchMountedConfiguration(fetchImpl)).toEqual({
      kind: "unavailable",
    });
  });
});
