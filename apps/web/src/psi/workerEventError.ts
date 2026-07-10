/** Turn a worker `onerror` / `onmessageerror` event into an Error. The event is a
 * browser ErrorEvent whose `message` names the fault; fall back to `fallbackMessage`
 * when it carries none. */
export function errorFromWorkerEvent(
  event: unknown,
  fallbackMessage: string,
): Error {
  const message =
    typeof event === "object" &&
    event !== null &&
    typeof (event as { message?: unknown }).message === "string"
      ? (event as { message: string }).message
      : fallbackMessage;
  return new Error(message);
}
