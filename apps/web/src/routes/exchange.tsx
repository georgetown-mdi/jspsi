import { createFileRoute } from "@tanstack/react-router";

import { InviterBench } from "@bench/InviterBench";

export const Route = createFileRoute("/exchange")({
  component: InviterBench,
});
