import { createFileRoute } from "@tanstack/react-router";

import { HomePage } from "@components/HomePage";

export const Route = createFileRoute("/")({
  component: HomePage,
  // Wide: the home page lays out two panels side by side and shows the long
  // invitation code/link, so it wants more room than a single-column reading
  // width. The shell sizes the content column to match.
  staticData: { contentWidth: "xl" },
});
