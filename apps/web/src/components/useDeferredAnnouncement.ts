import { useEffect, useState } from "react";

/**
 * Defer a polite live-region message by one commit so a value already present on
 * MOUNT is still announced. A live region populated on its very first render is
 * treated by assistive tech as initial page content and is NOT voiced; returning
 * "" on the first render and the real `message` only after the mount commit turns
 * a present-on-mount value into the empty -> non-empty transition screen readers
 * do announce (and a later change announces the same way).
 *
 * The caller renders the returned string in a visually-hidden POLITE region; the
 * VISIBLE UI for the same condition is rendered separately and immediately, so it
 * neither flashes nor shifts layout. Polite (never assertive) so the announcement
 * queues behind the host editor's initial heading focus rather than interrupting
 * it -- the announcement reaches assistive tech without fighting focus on mount.
 *
 * Empty messages clear the region silently (the standard pattern for an advisory),
 * so a resolved condition does not announce a disappearance.
 */
export function useDeferredAnnouncement(message: string): string {
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    setAnnounced(message);
  }, [message]);
  return announced;
}
