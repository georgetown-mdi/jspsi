import { createFileRoute } from "@tanstack/react-router";

import { InviterBench } from "@bench/InviterBench";

export const Route = createFileRoute("/bench/exchange")({
  component: InviterBench,
});
