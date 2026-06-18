import WebSocket from "ws";

// A cold dial of the PeerJS signaling WebSocket: it connects the upgrade
// directly, exactly as the real client does (which uses an explicit, pre-derived
// id and so never makes the GET /api/peerjs/id that would lazily load the route
// module). A WebSocket upgrade does NOT run that route handler, so this probe
// never warms the server -- it only observes whether signaling was already warmed
// at startup. That is what lets it stand in for the masked-by-an-HTTP-warm gap:
// the server must warm signaling itself (the dev-server-snagger in vite.config,
// or the nitro entry's localFetch in production) for this to ever answer OPEN.

// Process-wide so every attempt registers under a distinct broker id: a retry
// that lands before the server has reaped a prior probe's socket would otherwise
// be rejected ID_TAKEN rather than OPEN.
let probeSeq = 0;

/** One cold dial. Resolves true if the server answers with the PeerJS OPEN frame
 * (the upgrade was handled and the peer registered), false on close/error or if
 * `perAttemptMs` elapses with no answer (an unhandled upgrade stalls rather than
 * refusing). Terminates the socket without removing listeners, so a late `error`
 * from tearing down a still-connecting probe is swallowed by the settled-guarded
 * handler rather than left unhandled. */
function coldSignalingAttempt(
  port: number,
  perAttemptMs: number,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const id = `signaling-probe-${(probeSeq += 1)}`;
    const url =
      `ws://127.0.0.1:${port}/api/peerjs` +
      `?key=peerjs&id=${id}&token=tok&version=1.5.5`;
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        // already gone
      }
      resolvePromise(ok);
    };
    const timer = setTimeout(() => finish(false), perAttemptMs);
    ws.on("message", (data: WebSocket.RawData) => {
      // Resolve only on the OPEN frame; ignore any other frame rather than
      // treating the first message as the verdict (close/timeout cover the
      // negative cases). Parse the type instead of substring-matching, so JSON
      // formatting changes cannot silently make this a permanent false negative.
      let type: unknown;
      try {
        type = (JSON.parse(data.toString()) as { type?: unknown }).type;
      } catch {
        return;
      }
      if (type === "OPEN") finish(true);
    });
    ws.on("close", () => finish(false));
    ws.on("error", () => finish(false));
  });
}

/** Poll {@link coldSignalingAttempt} until signaling answers OPEN or `deadlineMs`
 * elapses; returns whether it opened. Used by the production signaling smoke test
 * to assert the built server warms signaling at startup. */
export async function waitForColdSignaling(
  port: number,
  options: { deadlineMs: number; perAttemptMs?: number },
): Promise<boolean> {
  const perAttemptMs = options.perAttemptMs ?? 2_500;
  const deadline = Date.now() + options.deadlineMs;
  for (;;) {
    if (await coldSignalingAttempt(port, perAttemptMs)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}
