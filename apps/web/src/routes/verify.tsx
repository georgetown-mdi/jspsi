import { createFileRoute } from "@tanstack/react-router";

import { VerifyReceiptBench } from "@bench/VerifyReceiptBench";

export const Route = createFileRoute("/verify")({
  // Verification runs entirely client-side (Web Crypto, local file reads), so
  // the page is a client component; nothing here needs or wants a server render.
  ssr: false,
  component: VerifyReceiptBench,
});
