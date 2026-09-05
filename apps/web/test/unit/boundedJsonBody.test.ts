import { describe, expect, test } from "vitest";

import {
  JobApiBodyError,
  MAX_JOB_STATUS_RESPONSE_BYTES,
  readBoundedJson,
} from "@psi/jobApiBody";
import { readBoundedJsonBody } from "@utils/boundedJsonBody";

// The web app's one byte-capped JSON body read, in both directions: the request
// side the job routes take (readJobRequestBody delegates here, and its own
// route-level cases live in jobRoutes.unit.test.ts) and the response side every
// job-API client takes. What is pinned here is the read itself -- that the cap
// is enforced on the running byte total rather than on a header, that an
// unreadable body never reaches a caller as a value, and that the throwing
// response-side form raises JobApiBodyError rather than the SyntaxError a
// platform `json()` raises.

const encoder = new TextEncoder();

/** A Response whose body is a stream of `chunks` bytes each, `count` of them, so
 * the cap is decided by the running total with no Content-Length to consult. */
function streamedResponse(
  chunkBytes: number,
  count: number,
  headers?: Record<string, string>,
): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === count) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
  });
  return new Response(stream, { headers });
}

/** A Response carrying exactly `bytes`, with no Content-Length claim of its own. */
function byteResponse(bytes: Uint8Array): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream);
}

describe("readBoundedJsonBody caps the read, not Content-Length", () => {
  test("a body exceeding the cap is too-large, without a Content-Length header", async () => {
    const result = await readBoundedJsonBody(streamedResponse(16, 4), 32);
    expect(result.kind).toBe("too-large");
  });

  test("a body exceeding the cap is too-large even when Content-Length understates it", async () => {
    const response = streamedResponse(16, 8, { "content-length": "1" });
    expect(await readBoundedJsonBody(response, 32)).toEqual({
      kind: "too-large",
    });
  });

  test("the read stops at the cap rather than draining the body first", async () => {
    // An endless body: only a read that stops the moment the running total
    // crosses the cap returns at all, so this case would hang on a form that
    // buffered the body before measuring it.
    let enqueued = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        enqueued += 1;
        controller.enqueue(new Uint8Array(64).fill(0x20));
      },
    });
    const result = await readBoundedJsonBody(new Response(endless), 128);
    expect(result.kind).toBe("too-large");
    // Three 64-byte chunks is the first running total past a 128-byte cap.
    expect(enqueued).toBe(3);
  });

  test("a body at the cap is read and parsed", async () => {
    const bytes = encoder.encode(JSON.stringify({ ok: true }));
    const result = await readBoundedJsonBody(
      byteResponse(bytes),
      bytes.byteLength,
    );
    expect(result).toEqual({ kind: "parsed", value: { ok: true } });
  });

  test("an unparseable body is invalid", async () => {
    const result = await readBoundedJsonBody(
      byteResponse(encoder.encode("}{ not json")),
      1024,
    );
    expect(result.kind).toBe("invalid");
  });

  test("a body holding an invalid UTF-8 byte is invalid, never parsed with U+FFFD substituted", async () => {
    // The bytes reach the bounded parse undecoded, so its UTF-8-fatal decode
    // rejects the body rather than a lenient decode handing the caller a value
    // the console never sent.
    const bytes = Uint8Array.from([
      ...encoder.encode('{"id":"a'),
      0xff,
      ...encoder.encode('b"}'),
    ]);
    const result = await readBoundedJsonBody(byteResponse(bytes), 1024);
    expect(result.kind).toBe("invalid");
  });

  test("a body under the byte cap but past the structural bound is invalid", async () => {
    // Nesting far deeper than any console answer, well inside the byte cap: the
    // structural rejection reaches the caller as `invalid`, never as a thrown
    // error escaping the read.
    const depth = 100_000;
    const body = "[".repeat(depth) + "]".repeat(depth);
    const bytes = encoder.encode(body);
    const result = await readBoundedJsonBody(
      byteResponse(bytes),
      bytes.byteLength,
    );
    expect(result.kind).toBe("invalid");
  });

  test("a bodyless response is invalid", async () => {
    const result = await readBoundedJsonBody(
      new Response(null, { status: 204 }),
      1024,
    );
    expect(result.kind).toBe("invalid");
  });

  test("a Request body reads under the same cap as a Response body", async () => {
    const request = new Request("http://localhost/api/jobs", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });
    expect(await readBoundedJsonBody(request, 1024)).toEqual({
      kind: "parsed",
      value: { ok: true },
    });
  });
});

describe("readBoundedJson raises rather than returning a partial answer", () => {
  test("a body within the cap resolves to the parsed value", async () => {
    const response = byteResponse(encoder.encode('{"status":"succeeded"}'));
    await expect(
      readBoundedJson(response, MAX_JOB_STATUS_RESPONSE_BYTES),
    ).resolves.toEqual({ status: "succeeded" });
  });

  test("a body over the cap raises rather than resolving to its value", async () => {
    // Valid JSON, only too large, so the refusal is the cap and not the shape.
    const body = JSON.stringify({ pad: "a".repeat(64 * 1024) });
    await expect(
      readBoundedJson(
        byteResponse(encoder.encode(body)),
        MAX_JOB_STATUS_RESPONSE_BYTES,
      ),
    ).rejects.toBeInstanceOf(JobApiBodyError);
  });

  test("an unreadable body raises", async () => {
    for (const body of ["}{ not json", ""]) {
      await expect(
        readBoundedJson(byteResponse(encoder.encode(body)), 1024),
      ).rejects.toBeInstanceOf(JobApiBodyError);
    }
  });

  test("the raised message holds none of the body's bytes", async () => {
    const secret = "operator-secret-value";
    const error = await readBoundedJson(
      byteResponse(encoder.encode(`{"leak": "${secret}"`)),
      1024,
    ).catch((raised: unknown) => raised);
    expect(error).toBeInstanceOf(JobApiBodyError);
    expect((error as Error).message).not.toContain(secret);
  });
});
