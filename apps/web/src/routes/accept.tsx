import { createFileRoute } from "@tanstack/react-router";

import { AcceptInvitation } from "@components/AcceptInvitation";

export const Route = createFileRoute("/accept")({
  // The encoded token rides in the URL fragment, which never reaches the server,
  // so decoding and rendering must happen client-side only.
  ssr: false,
  component: AcceptInvitation,
  // The widest named width: the linkage terms are the densest content in the app
  // -- nested keys, elements, transforms, and parameters -- so they need more
  // room than the home page, not less, to stay legible. The shell sizes this
  // route's content to this one width (the route owns no Container of its own).
  staticData: { contentWidth: "xxl" },
});
