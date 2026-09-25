import { getRequestURL, getRequestWebStream } from "h3";

import type { H3Event } from "h3";

/**
 * Give the web `Request` the app's handlers receive an abort signal that fires
 * when the client goes away before the response has finished. The built server
 * converts each request with h3's `toWebRequest`, which sets no signal, so
 * without this `request.signal` never fires there: a closed console tab keeps
 * its job event-stream subscription and keepalive timer until the job ends, and
 * an abandoned coverage request keeps reading the input file to its end.
 *
 * Builds the `Request` exactly as `toWebRequest` does, plus the signal, and
 * leaves an event that already has one (an in-process `localFetch`) alone.
 * Registered as the server's `request` hook, which runs before any handler.
 */
export function attachRequestAbortSignal(event: H3Event): void {
  if (event.web?.request !== undefined) return;
  const controller = new AbortController();
  const response = event.node.res;
  response.once("close", () => {
    if (!response.writableFinished) controller.abort();
  });
  const url = getRequestURL(event);
  event.web = {
    url,
    request: new Request(url, {
      duplex: "half",
      method: event.method,
      headers: event.headers,
      body: getRequestWebStream(event),
      signal: controller.signal,
    } as RequestInit),
  };
}
