import { createFileRoute } from "@tanstack/react-router";

import { ExchangeUnderConstruction } from "@bench/placeholders";

export const Route = createFileRoute("/bench/exchange")({
  component: ExchangeUnderConstruction,
});
