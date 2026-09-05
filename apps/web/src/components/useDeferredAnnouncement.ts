import { useEffect, useState } from "react";

/**
 * Defer a polite live-region message by one commit so a value already present on
 * MOUNT is still announced. A live region populated on its first render is
 * treated by assistive tech as initial page content and is NOT voiced; returning
 * "" first and the real `message` after the mount commit makes it the empty ->
 * non-empty transition screen readers do announce.
 *
 * The caller renders the returned string in a visually-hidden POLITE region; the
 * VISIBLE UI for the same condition is rendered separately and immediately.
 * Polite, never assertive, so the announcement queues behind the host editor's
 * initial heading focus. An empty message clears the region silently.
 */
export function useDeferredAnnouncement(message: string): string {
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    setAnnounced(message);
  }, [message]);
  return announced;
}
