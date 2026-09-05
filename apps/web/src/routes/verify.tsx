import { createFileRoute } from "@tanstack/react-router";

import { VerifyReceiptBench } from "@bench/VerifyReceiptBench";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/verify")({
  // Verification runs entirely client-side (Web Crypto, local file reads), so
  // this page never server-renders.
  ssr: false,
  component: VerifyReceiptBench,
  head: () => ({
    meta: seo({
      title: "Verify a receipt - psilink",
      description: "Check a signed receipt against the exchange it records.",
    }),
  }),
});
