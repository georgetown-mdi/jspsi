import { createFileRoute } from "@tanstack/react-router";

import { AcceptUnderConstruction } from "@bench/placeholders";

export const Route = createFileRoute("/bench/accept")({
  component: AcceptUnderConstruction,
});
