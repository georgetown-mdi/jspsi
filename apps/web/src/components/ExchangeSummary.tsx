import { Paper } from "@mantine/core";

import { InvitationTerms } from "@components/InvitationTerms";

import type { Ref } from "react";

import type { LinkageTerms } from "@psilink/core";

/**
 * The standardized "exchange proposal" panel: the agreed linkage terms
 * ({@link InvitationTerms}) in a bordered card. One component for every place the
 * agreed terms sit beside an editor or a run -- the inviter's Advanced-options
 * preview, the acceptor's review and "Prepare your data" screens, and both roles'
 * exchange-executing screen -- so the wrapper and heading nesting are identical
 * everywhere; only the per-viewer copy differs, owned by `perspective` inside
 * {@link InvitationTerms}.
 *
 * {@link sendColumns} is THIS party's own outbound disclosure -- what leaves this
 * machine for matched rows. It is forwarded to {@link InvitationTerms} as
 * `outboundColumns`, which renders it as chips in the always-visible core just
 * above "Other details", so the disclosure sits with the agreed terms rather than
 * after the panel. The acceptor supplies it from its live metadata once a file is
 * chosen; it is omitted on the review screen (no file yet) and on the inviter,
 * whose declared send already renders under the "proposing" perspective. An empty
 * array renders the explicit "no columns are sent" confirmation.
 */
export function ExchangeSummary({
  linkageTerms,
  perspective,
  headingOrder,
  expires,
  disclosedPayloadColumns,
  headingRef,
  sendColumns,
}: {
  linkageTerms: LinkageTerms;
  /** Which viewer this renders for; drives the heading and per-party copy (see
   * {@link InvitationTerms}). */
  perspective: "review" | "accepted" | "proposing";
  /** Semantic heading level for the terms heading (see {@link InvitationTerms}). */
  headingOrder?: 2 | 3;
  /** The invitation's expiry instant (ISO 8601), if it carries one. */
  expires?: string;
  /** The columns the invitation declared the inviter will send, passed through
   * to {@link InvitationTerms}. */
  disclosedPayloadColumns?: Array<string>;
  headingRef?: Ref<HTMLHeadingElement>;
  /** This party's own disclosed columns ("Columns you will send to your
   * partner"), forwarded to {@link InvitationTerms} as `outboundColumns` and
   * rendered as chips just above "Other details". Omit where the set is not yet
   * known (the acceptor review screen) or already shown inside the terms (the
   * inviter's "proposing" preview). An empty array renders the explicit
   * "no columns are sent" confirmation. */
  sendColumns?: Array<string>;
}) {
  return (
    <Paper withBorder p="md">
      <InvitationTerms
        linkageTerms={linkageTerms}
        perspective={perspective}
        headingOrder={headingOrder}
        expires={expires}
        disclosedPayloadColumns={disclosedPayloadColumns}
        headingRef={headingRef}
        outboundColumns={sendColumns}
      />
    </Paper>
  );
}
