import { describe, expect, test } from "vitest";

import {
  JobApiRequestError,
  createFetchJobApiClient,
  fetchSftpConnection,
  fetchSlotOccupancy,
} from "@psi/serverJobExchangeDriver";
import {
  MAX_JOB_HANDOFF_RESPONSE_BYTES,
  MAX_JOB_LISTING_RESPONSE_BYTES,
  MAX_JOB_STATUS_RESPONSE_BYTES,
  MAX_SFTP_CONNECTION_RESPONSE_BYTES,
} from "@psi/jobApiBody";
import {
  fetchJobInputProfile,
  fetchJobInputs,
  fetchJobRendezvous,
  postJobInputCoverage,
} from "@psi/workInputClient";
import {
  fetchSecretsEntries,
  probeSftpHostKey,
  putSftpConnection,
} from "@psi/sftpAuthoringClient";
import { fetchJobExchangeRecordOffer } from "@psi/jobExchangeRecord";
import { fetchJobLogState } from "@psi/jobDiagnosticLog";
import { fetchJobReceiptOffer } from "@psi/jobReceipt";
import { fetchRecurringHandoff } from "@psi/recurringHandoff";
import { resolveSigningFingerprint } from "@psi/signingIdentityClient";

// Every job-API client reads the console's answer under a byte cap. Each case
// below hands the client a body that is VALID JSON and valid for that client's
// own shape check, and only too large: the old Response.json() read every one of
// them and returned the success value, so each of these assertions fails on that
// form and passes only because the read is bounded.
//
// A client's refusal state is its own existing malformed-body state, so nothing
// here is a new failure path -- only a new way to reach one.

/** A JSON body whose encoded length exceeds `cap`, carrying `fields` intact so
 * the client's shape check would accept it if it ever reached one. */
function overCapBody(cap: number, fields: Record<string, unknown>): string {
  const withoutPad = JSON.stringify({ ...fields, pad: "" });
  return JSON.stringify({
    ...fields,
    pad: "a".repeat(cap + 1 - withoutPad.length),
  });
}

/** A 200 carrying `body`, streamed so no Content-Length shortcut is available. */
function jsonResponse(body: string, status = 200): Response {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch stub answering every request with `body` at `status`. */
function answering(body: string, status = 200): typeof fetch {
  return () => Promise.resolve(jsonResponse(body, status));
}

/** A fetch stub answering with raw bytes, for a body no string can express. */
function answeringBytes(bytes: Uint8Array): typeof fetch {
  return () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return Promise.resolve(new Response(stream));
  };
}

/** Every field the status-capped clients below read, in one body: each of them
 * accepts it on its own success path, so only the cap turns it away. */
const OVER_STATUS_CAP = overCapBody(MAX_JOB_STATUS_RESPONSE_BYTES, {
  id: "8c9f2a52-0b1f-4a3d-9c7e-1f2a3b4c5d6e",
  status: "succeeded",
  occupied: true,
  configured: true,
  locator: "sftp://console.example/drop",
  recordAvailable: true,
  recordCreatedAt: "2026-09-04T10:00:00.000Z",
  recordOutcome: "completed",
  receiptAvailable: true,
  logAvailable: true,
});

describe("a status body over its cap fails the reader safely", () => {
  test("the record offer is unanswered, not the available record the body asserts", async () => {
    await expect(
      fetchJobExchangeRecordOffer("job-1", answering(OVER_STATUS_CAP)),
    ).resolves.toEqual({ kind: "unanswered" });
  });

  test("the receipt offer is unanswered", async () => {
    await expect(
      fetchJobReceiptOffer("job-1", answering(OVER_STATUS_CAP)),
    ).resolves.toEqual({ kind: "unanswered" });
  });

  test("the diagnostic-log state is unanswered", async () => {
    await expect(
      fetchJobLogState("job-1", answering(OVER_STATUS_CAP)),
    ).resolves.toBe("unanswered");
  });

  test("a create raises rather than adopting the job id the body carries", async () => {
    const client = createFetchJobApiClient(answering(OVER_STATUS_CAP, 201));
    await expect(
      client.createJob(
        { mode: "zeroSetup" } as unknown as Parameters<
          typeof client.createJob
        >[0],
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });

  test("a busy create carries no re-attach id off an over-cap 409 body", async () => {
    const client = createFetchJobApiClient(answering(OVER_STATUS_CAP, 409));
    const error = await client
      .createJob(
        { mode: "zeroSetup" } as unknown as Parameters<
          typeof client.createJob
        >[0],
        new AbortController().signal,
      )
      .catch((raised: unknown) => raised);
    expect(error).toBeInstanceOf(JobApiRequestError);
    expect((error as JobApiRequestError).activeJobId).toBeUndefined();
  });

  test("a status query stays live-and-running rather than reading the terminal status", async () => {
    const client = createFetchJobApiClient(answering(OVER_STATUS_CAP));
    await expect(
      client.fetchJobStatus("job-1", new AbortController().signal),
    ).resolves.toEqual({ kind: "live", status: "running" });
  });

  test("a record-availability query raises rather than reporting the record available", async () => {
    const client = createFetchJobApiClient(answering(OVER_STATUS_CAP));
    await expect(
      client.fetchRecordAvailability("job-1", new AbortController().signal),
    ).rejects.toThrow();
  });

  test("the slot reads unoccupied rather than adopting the occupying id", async () => {
    await expect(
      fetchSlotOccupancy(
        new AbortController().signal,
        answering(OVER_STATUS_CAP),
      ),
    ).resolves.toEqual({ occupied: false });
  });

  test("the rendezvous probe spends its attempts and fails safe to unconfigured", async () => {
    await expect(
      fetchJobRendezvous(answering(OVER_STATUS_CAP), 2, () =>
        Promise.resolve(),
      ),
    ).resolves.toEqual({ configured: false });
  });

  test("a host-key probe is an error rather than the fingerprint the body carries", async () => {
    const body = overCapBody(MAX_JOB_STATUS_RESPONSE_BYTES, {
      status: "ok",
      fingerprint: `SHA256:${"B".repeat(42)}A`,
      keyType: "ssh-ed25519",
    });
    await expect(
      probeSftpHostKey("host.example", undefined, answering(body)),
    ).resolves.toEqual({ kind: "error" });
  });

  test("a body holding an invalid UTF-8 byte is unanswered, not decoded with U+FFFD substituted", async () => {
    // The old form decoded leniently and parsed this body into an available
    // record; the bounded read decodes UTF-8-fatal and refuses it.
    const encoder = new TextEncoder();
    const bytes = Uint8Array.from([
      ...encoder.encode(
        '{"recordAvailable":true,"recordOutcome":"completed","recordCreatedAt":"2026-09-04T10:00:00.000',
      ),
      0xff,
      ...encoder.encode('"}'),
    ]);
    await expect(
      fetchJobExchangeRecordOffer("job-1", answeringBytes(bytes)),
    ).resolves.toEqual({ kind: "unanswered" });
  });

  test("a body under the byte cap but past the structural bound is unanswered", async () => {
    // Nesting no console answer holds, inside the byte cap: the old form parsed
    // it and read the record off the fields beside it.
    const depth = 5_000;
    const body =
      '{"recordAvailable":true,"recordOutcome":"completed",' +
      '"recordCreatedAt":"2026-09-04T10:00:00.000Z","deep":' +
      "[".repeat(depth) +
      "]".repeat(depth) +
      "}";
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(
      MAX_JOB_STATUS_RESPONSE_BYTES,
    );
    await expect(
      fetchJobExchangeRecordOffer("job-1", answering(body)),
    ).resolves.toEqual({ kind: "unanswered" });
  });

  test("a signing-fingerprint request is an error rather than the fingerprint the body carries", async () => {
    const body = overCapBody(MAX_JOB_STATUS_RESPONSE_BYTES, {
      status: "ok",
      fingerprint: `${"B".repeat(42)}A`,
      created: true,
      identityFileName: ".psilink-signing-identity.json",
    });
    await expect(
      resolveSigningFingerprint("me", false, answering(body)),
    ).resolves.toEqual({ kind: "error" });
  });
});

const OVER_SFTP_CAP = overCapBody(MAX_SFTP_CONNECTION_RESPONSE_BYTES, {
  configured: true,
  host: "sftp.example",
  port: 22,
  path: "/drop",
  credentialWarnings: [],
});

describe("an SFTP connection body over its cap fails the reader safely", () => {
  test("the effective connection reads as none configured", async () => {
    await expect(
      fetchSftpConnection(answering(OVER_SFTP_CAP)),
    ).resolves.toEqual({ connection: null });
  });

  test("authoring reports an error rather than the projection the body carries", async () => {
    await expect(
      putSftpConnection(
        {} as unknown as Parameters<typeof putSftpConnection>[0],
        answering(OVER_SFTP_CAP),
      ),
    ).resolves.toEqual({ kind: "error" });
  });
});

describe("a hand-off body over its cap fails the reader safely", () => {
  test("the recurring hand-off is null rather than the template the body carries", async () => {
    const body = overCapBody(MAX_JOB_HANDOFF_RESPONSE_BYTES, {
      mode: "exchange",
      channel: "sftp",
      usedKeyFile: true,
      credentialPasted: false,
      usedSigningIdentity: false,
      template: { kind: "config", yaml: "version: 1\n" },
    });
    await expect(
      fetchRecurringHandoff("job-1", answering(body)),
    ).resolves.toBeNull();
  });
});

describe("a listing body over its cap fails the reader safely", () => {
  test("the mounted-input listing is the transient error state", async () => {
    const body = overCapBody(MAX_JOB_LISTING_RESPONSE_BYTES, {
      configured: true,
      readable: true,
      files: [],
    });
    await expect(fetchJobInputs(answering(body))).resolves.toEqual({
      kind: "error",
    });
  });

  test("a file profile is unavailable for an unknown reason", async () => {
    const body = overCapBody(MAX_JOB_LISTING_RESPONSE_BYTES, {
      name: "people.csv",
      sizeBytes: 10,
      modifiedAt: 0,
      rowCount: 1,
      columns: ["a"],
      columnSamples: [{ column: "a", values: ["x"] }],
    });
    await expect(
      fetchJobInputProfile("people.csv", answering(body)),
    ).resolves.toEqual({ kind: "unavailable", reason: "unknown" });
  });

  test("a coverage sweep is unavailable rather than the rates the body carries", async () => {
    const body = overCapBody(MAX_JOB_LISTING_RESPONSE_BYTES, {
      rates: [
        {
          output: "given_name",
          input: "given_name",
          total: 1,
          produced: 1,
          rate: 1,
        },
      ],
    });
    await expect(
      postJobInputCoverage(
        { name: "people.csv" },
        { transformations: [] } as unknown as Parameters<
          typeof postJobInputCoverage
        >[1],
        new AbortController().signal,
        answering(body),
      ),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  test("the secrets-mount listing is the transient error state", async () => {
    const body = overCapBody(MAX_JOB_LISTING_RESPONSE_BYTES, {
      configured: true,
      readable: true,
      entries: [],
    });
    await expect(fetchSecretsEntries([], answering(body))).resolves.toEqual({
      kind: "error",
    });
  });
});
