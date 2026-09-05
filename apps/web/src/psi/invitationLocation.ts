import type { InvitationLocation } from "@psi/invitation";

/**
 * This page's location, in the shape {@link generateInvitation} takes. It reads
 * `window`, so it must be called from the client and throws when `window` is
 * absent rather than return a server-side value. The inviter console's create and
 * save-exchange-file paths both use it so they build the locator identically.
 */
export function invitationLocation(): InvitationLocation {
  if (typeof window === "undefined")
    throw new Error("invitationLocation must be called in the browser");
  return {
    origin: window.location.origin,
    hostname: window.location.hostname,
    port: window.location.port,
  };
}
