import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/saved/")({
  // The saved-exchange list is the home route now; /saved redirects there so a
  // bookmark or an in-app link to the old path still lands on the list. Client-only
  // to keep the redirect uniform with the /saved/$id run leaf and to carry any hash.
  ssr: false,
  beforeLoad: () => {
    throw redirect({ to: "/", hash: true, replace: true });
  },
});
