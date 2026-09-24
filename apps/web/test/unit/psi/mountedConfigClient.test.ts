import { describe, expect, test } from "vitest";

import { getDefaultLinkageTerms } from "@psilink/core";

import {
  fetchMountedConfiguration,
  saveOpenedConfiguration,
} from "@psi/jobClient/mountedConfigClient";

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

  test("a present configuration reads as opened, with every list", async () => {
    const { fetchImpl } = answering(200, {
      configured: true,
      present: true,
      document: DOCUMENT,
      carriedThrough: ["authentication.token_max_age_days"],
      warnings: ["connection.server.password"],
      signingPathSettings: ["signing.identity_file"],
      folderPathSettings: [],
    });
    const answer = await fetchMountedConfiguration(fetchImpl);
    expect(answer.kind).toBe("opened");
    if (answer.kind !== "opened") throw new Error("expected an opened answer");
    expect(answer.document.channel).toBe("sftp");
    expect(answer.carriedThrough).toEqual([
      "authentication.token_max_age_days",
    ]);
    expect(answer.warnings).toEqual(["connection.server.password"]);
    expect(answer.signingPathSettings).toEqual(["signing.identity_file"]);
    expect(answer.folderPathSettings).toEqual([]);
  });

  test("a webrtc configuration reads as opened, for review", async () => {
    const { fetchImpl } = answering(200, {
      configured: true,
      present: true,
      document: {
        channel: "webrtc",
        linkageTerms: getDefaultLinkageTerms("County Health"),
      },
      carriedThrough: [],
      warnings: [],
      signingPathSettings: [],
      folderPathSettings: [],
    });
    const answer = await fetchMountedConfiguration(fetchImpl);
    if (answer.kind !== "opened") throw new Error("expected an opened answer");
    expect(answer.document.channel).toBe("webrtc");
  });

  test("a refusal keeps the console's own text", async () => {
    const error = "This configuration runs over ftp.";
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
      "a document on a channel the console does not open",
      200,
      {
        present: true,
        document: { ...DOCUMENT, channel: "ftp" },
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
        carriedThrough: [{ field: "authentication.token_max_age_days" }],
        warnings: [],
      },
    ],
    [
      "no signing path list",
      200,
      {
        present: true,
        document: DOCUMENT,
        carriedThrough: [],
        warnings: [],
        folderPathSettings: [],
      },
    ],
    [
      "a folder path list holding something that is not a name",
      200,
      {
        present: true,
        document: DOCUMENT,
        carriedThrough: [],
        warnings: [],
        signingPathSettings: [],
        folderPathSettings: [{ field: "connection.path" }],
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

describe("saving the opened configuration back", () => {
  const HAND_BACK = {
    linkageTerms: getDefaultLinkageTerms("County Health"),
    signing: { mode: "none" as const },
  };

  test("a written answer reads as written, over PUT to the load's route", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = ((url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ written: true }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    expect(await saveOpenedConfiguration(HAND_BACK, fetchImpl)).toEqual({
      kind: "written",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/api/jobs/config");
    expect(requests[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(requests[0].init?.body))).toEqual(HAND_BACK);
  });

  test("a refusal reads in the console's own words", async () => {
    const { fetchImpl } = answering(400, { error: "Change them." });
    expect(await saveOpenedConfiguration(HAND_BACK, fetchImpl)).toEqual({
      kind: "refused",
      error: "Change them.",
    });
  });

  test("a refusal with no text still says the save stopped", async () => {
    const { fetchImpl } = answering(400, undefined);
    const answer = await saveOpenedConfiguration(HAND_BACK, fetchImpl);
    expect(answer.kind).toBe("refused");
    if (answer.kind !== "refused") throw new Error("expected a refusal");
    expect(answer.error).toContain("did not save");
  });

  test("anything else reads as unavailable", async () => {
    for (const { status, body } of [
      { status: 200, body: { written: "yes" } },
      { status: 200, body: undefined },
      { status: 500, body: { error: "no" } },
    ]) {
      const { fetchImpl } = answering(status, body);
      expect(await saveOpenedConfiguration(HAND_BACK, fetchImpl)).toEqual({
        kind: "unavailable",
      });
    }
    const failing = (() =>
      Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await saveOpenedConfiguration(HAND_BACK, failing)).toEqual({
      kind: "unavailable",
    });
  });
});
