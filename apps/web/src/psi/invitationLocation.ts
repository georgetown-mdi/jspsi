import type { InvitationLocation } from "@psi/invitation";

/**
 * This page's location, in the shape {@link generateInvitation} consumes. It
 * reads `window`, so it must be called from a client-side path; it throws rather
 * than return a wrong value if ever reached during SSR, since there is no sensible
 * server-side location. Callers invoke it from a submit/generate handler, an event
 * that cannot fire during render. Shared by the quick compose screen (InvitePanel)
 * and the Advanced editor (AdvancedInvite) so both build the locator identically.
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
