import { createFileRoute } from "@tanstack/react-router";

import { AdvancedInvite } from "@components/AdvancedInvite";

export const Route = createFileRoute("/advanced")({
  // The editor reads the inviter's file and (on a warm hand-off) a File handle
  // that exists only in the browser, and it mints a secret-bearing invitation, so
  // it must run client-side only -- like the accept route.
  ssr: false,
  component: AdvancedInvite,
  // The widest named width: the editor lays out an edit rail beside a live preview
  // of the (dense) linkage terms, so it wants the same room the accept consent
  // screen takes. The shell sizes its chrome and this route's content to it.
  staticData: { contentWidth: "xxl" },
});
