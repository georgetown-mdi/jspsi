import { useId, useState } from "react";

import {
  Collapse,
  Group,
  List,
  Stack,
  Text,
  Title,
  UnstyledButton,
  VisuallyHidden,
} from "@mantine/core";

import { IconChevronRight } from "@tabler/icons-react";
import { useReducedMotion } from "@mantine/hooks";

import { sanitizeForDisplay } from "@psilink/core";

import { summarizeInvitation } from "@psi/invitationSummary";

import { ColumnChips } from "@components/ColumnChips";

import type { ReactNode, Ref } from "react";

import type { LinkageTerms } from "@psilink/core";

import type { InvitationKeySummary } from "@psi/invitationSummary";

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

/** Join phrases into an Oxford-comma English list ("a", "a and b", "a, b, and c"),
 * for the self-describing "Other details" summary. */
function joinList(items: Array<string>): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** A labelled block: a bold caption above its value(s). */
function Term({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap={2}>
      <Text size="sm" fw={600}>
        {label}
      </Text>
      {children}
    </Stack>
  );
}

/**
 * One linkage key as a collapsible disclosure: the always-visible header is the
 * key's name and a short derived one-liner of the fields it matches on (each with
 * a terse breadth marker when its element loosens matching), and the expanded body
 * is the per-element transform/swap/fuzzy detail ({@link MatchKeyDetails}). The
 * header is the honest, always-visible anchor -- the field one-liner is derived
 * from the schema-validated semantic types (see
 * {@link InvitationKeySummary.headerFields}), so a partner-controlled key name
 * cannot misrepresent what the key matches on.
 *
 * The disclosure mirrors the master-detail pattern below: aria-expanded +
 * aria-controls on the toggle, the id on the always-mounted wrapper (not the
 * Collapse panel) so it stays a stable target however Mantine mounts the panel,
 * and the panel
 * hidden from assistive tech + the tab order while closed. The toggle's accessible
 * name is the key name alone; the field one-liner is associated as its description
 * (aria-describedby) rather than folded into the name, so a screen reader hears
 * "<key name>, button, collapsed" and then the fields as the description.
 */
function MatchKeyDisclosure({ summary }: { summary: InvitationKeySummary }) {
  const [open, setOpen] = useState(false);
  // Stable ids across SSR/hydration; one component instance per key, so useId is
  // called once per widget (never inside a map).
  const panelId = useId();
  const sublineId = useId();
  const reduceMotion = useReducedMotion();
  return (
    <Stack gap={2} role="listitem">
      <UnstyledButton
        onClick={() => setOpen((isOpen) => !isOpen)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={sublineId}
      >
        <Group gap={4}>
          <IconChevronRight
            size={16}
            aria-hidden
            style={{
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              transition: reduceMotion ? undefined : "transform 150ms ease",
            }}
          />
          <Text size="sm" fw={500}>
            {summary.name}
          </Text>
        </Group>
      </UnstyledButton>
      {/* Always-visible, AT-associated breadth signal. The "Matches on " lead-in
          and the markers are fixed copy, and each field entry is a fixed compact
          label: the sanitized unknown-field fallback is unreachable for a decoded
          token (a dangling field reference is rejected at decode) and cosmetic-only
          if ever reached, so the joined line carries no unescaped partner text. */}
      <Text id={sublineId} size="xs" c="dimmed">
        Matches on {summary.headerFields.join(" - ")}
        {summary.hasSwap && " (matched in either order)"}
      </Text>
      <div id={panelId}>
        <Collapse expanded={open}>
          <MatchKeyDetails summary={summary} />
        </Collapse>
      </div>
    </Stack>
  );
}

/**
 * The per-element transform/swap detail for one linkage key, shown in the expanded
 * body of its {@link MatchKeyDisclosure}: each ordered element with the transform
 * or fuzzy comparison that alters its match, and a swap note. Each element's
 * transforms lead with their plain matching consequence (the literal slice phrase
 * or the glossary description), with the raw function name and parameters following
 * as technical detail rather than leading.
 */
function MatchKeyDetails({ summary }: { summary: InvitationKeySummary }) {
  // A block, not a <List.Item>: it carries flow content (a nested element list, a
  // swap note), which Mantine's List.Item would place inside an inline <span>,
  // producing invalid markup. The key name is not repeated here -- the disclosure
  // header carries it.
  return (
    <Stack gap={2}>
      {/* Elements (and their transforms/parameters) render as a Stack of
          blocks, not a Mantine List: a transform with parameters needs nested
          structure, which a List.Item -- whose children sit in an inline span
          -- cannot hold validly. Keyed by index: element order is fixed for a
          given key, and a field label is not unique across elements. */}
      <Stack gap={4}>
        {summary.elements.map((element, index) => (
          <Stack key={index} gap={2}>
            <Text size="sm">
              {element.fieldLabel}
              {element.fuzzyComparison !== undefined && (
                <Text span size="xs" c="dimmed">
                  {" "}
                  - also matches approximate variants ({element.fuzzyComparison}
                  )
                  {/* Fuzzy changes match breadth, not the disclosure guarantee, so
                      by the caveat-placement rule on {@link InvitationTerms} its
                      caveat stays here in the key's detail with the annotation it
                      qualifies -- flagging a proposed expansion the run does not yet
                      perform, so the acceptor is not told a looser match occurs when
                      it does not. Not-applied narrows the match (fewer candidates),
                      the safe disclosure direction, so it needs no core prominence. */}
                  {!element.fuzzyComparisonApplied &&
                    " (proposed; not yet applied)"}
                </Text>
              )}
            </Text>
            {/* Each transform, and each of its parameters, is its own block --
                never joined: a partner-controlled function name or parameter
                value may contain any separator, which joined text would render
                as spurious extra steps or parameters. */}
            {element.transforms.map((transform, ti) => (
              <Stack key={ti} gap={0} pl="md">
                {/* Lead with the plain matching consequence: the literal slice
                    phrase when faithful, else the glossary description, else --
                    for a function core does not recognize -- the bare sanitized
                    name. All are fixed/sanitized copy, not raw partner free text. */}
                <Text size="xs" c="dimmed">
                  {transform.effect !== undefined
                    ? `Matches on ${transform.effect}`
                    : transform.description !== undefined
                      ? transform.description
                      : `Applies ${transform.function}`}
                </Text>
                {/* The raw function name as secondary detail when a plainer lead
                    replaced it, so the technical identity stays available. */}
                {(transform.effect !== undefined ||
                  transform.description !== undefined) && (
                  <Text size="xs" c="dimmed" pl="md" fs="italic">
                    {transform.function}
                  </Text>
                )}
                {transform.params.map((param, pi) => (
                  <Text key={pi} size="xs" c="dimmed" pl="md">
                    {param}
                  </Text>
                ))}
                {/* Runtime-coercion notes for params the function overrides
                    (e.g. replacement: null runs as the empty string). Rendered
                    as their own element, with the fixed "runs as" copy as static
                    JSX text between two core-derived values -- never folded into
                    a partner-controlled param line -- so the note cannot be
                    impersonated by text placed inside a param value. The
                    italic styling marks it as a system note visually; the
                    VisuallyHidden lead-in carries that same provenance to a
                    screen reader (a partner controls only param-value text, so
                    it cannot inject this element), since italics are not
                    announced. */}
                {transform.coercions?.map((coercion, ci) => (
                  <Text key={ci} size="xs" c="dimmed" pl="md" fs="italic">
                    <VisuallyHidden>Runtime note: </VisuallyHidden>
                    {coercion.param} runs as {coercion.runsAs}
                  </Text>
                ))}
              </Stack>
            ))}
          </Stack>
        ))}
      </Stack>
      {summary.hasSwap && (
        <Text size="xs" c="dimmed">
          {summary.swap !== undefined
            ? `${summary.swap[0]} and ${summary.swap[1]} may be matched in either order`
            : "Two of these elements may be matched in either order"}
        </Text>
      )}
      {/* On the receiver each swapped element's transforms run against the OTHER
          element's field value (the field references swap, the transforms stay
          put), which the generic swap note above does not convey -- and which
          anchors the partner-attributed breadth marker the header shows. When both
          sides carry transforms it is a bidirectional interchange; when one does,
          a one-directional donor -> recipient note (swapTransformDonor names the
          transform-carrier first). Both flags imply swap is set and are mutually
          exclusive. */}
      {summary.swapTransformInterchange && summary.swap !== undefined && (
        <Text size="xs" c="dimmed">
          When matched in that order, the transforms shown for {summary.swap[0]}{" "}
          are applied to {summary.swap[1]}&rsquo;s value, and those for{" "}
          {summary.swap[1]} to {summary.swap[0]}&rsquo;s value.
        </Text>
      )}
      {summary.swapTransformDonor !== undefined && (
        <Text size="xs" c="dimmed">
          When matched in that order, the transforms shown for{" "}
          {summary.swapTransformDonor[0]} are applied to{" "}
          {summary.swapTransformDonor[1]}&rsquo;s value.
        </Text>
      )}
    </Stack>
  );
}

/**
 * Renders the inviter's linkage terms decoded from an invitation for review. The
 * always-visible core is organized by disclosure DIRECTION rather than as one flat
 * list, so a reader can tell what each fact is about: an attached legal agreement
 * leads as a cross-cutting governance frame, then three labelled direction tiers --
 * "What the exchange produces" (matching method, linkage strategy, the matching
 * keys, and result sharing), "What you disclose" (the viewer's outbound send and the
 * egress request for its data), and "What you receive" (the inbound partner data).
 * Each tier is a role="group" named by its caption, so assistive tech announces it
 * as one related set. The matching list itself sits behind a default-collapsed
 * "Matching strategies" disclosure inside the produce tier; inside it each linkage
 * key is its own further default-collapsed disclosure, whose header is the key name
 * and a short derived one-liner of the fields it matches on (each carrying a terse
 * breadth marker -- "(partial)", "(fuzzy)" -- when its element loosens matching),
 * and whose expanded body holds the per-element transform/swap/fuzzy detail. The
 * remaining dense detail (personal-data constraints, payload columns, and dedup
 * notes) sits behind a single default-collapsed "Other details" disclosure, whose
 * toggle is self-describing -- a one-line summary of its contents, associated as the
 * toggle's accessible description. The legal agreement is not among that detail -- it
 * is promoted whole into the always-visible core.
 *
 * Every "proposed but not yet applied" caveat (psi-c count-only, deduplicate, and
 * per-element fuzzy comparison) follows ONE placement rule, so the flagging is
 * uniform rather than decided per setting: a setting's caveat renders at the SAME
 * visibility level as the headline it contradicts, never one expand down, so a
 * reader can never see a headline setting as in force while its caveat is hidden.
 * Which level that is follows the setting's disclosure weight. psi-c states a
 * disclosure GUARANTEE -- only the match count is revealed, no identifiers -- so
 * its headline is always-visible in the core and its caveat sits with it there;
 * deduplicate and fuzzy change match multiplicity/breadth, not what is disclosed,
 * so their headlines sit in a disclosure rather than the core (deduplicate in
 * "Other details", fuzzy in each key's detail, itself behind the matching
 * disclosure) and their caveats sit with those headlines, co-hidden with them. The asymmetry is deliberate and safe in the disclosure direction: psi-c
 * not-applied makes the run disclose MORE than its count-only headline promises
 * (identifiers revealed) -- the disclosure-critical direction that demands core
 * prominence -- while deduplicate/fuzzy not-applied make the run match LESS than
 * proposed, disclosing no more than the acceptor consented to. All caveat copy is
 * fixed (gated on the schema enum and the APPLIED_SETTINGS flags), so no partner
 * text enters a caveat, and render tests pin each caveat at its headline's level
 * against the accessibility tree.
 *
 * Two payload facts whose detail lives in the "Other details" disclosure carry an
 * always-visible count in a direction tier, since each would otherwise be invisible
 * until the acceptor expands Details: the extra-payload-egress request (a count of
 * the columns the inviter requests FROM the acceptor) lands in "What you disclose",
 * and the inbound partner data the invitation will send (a count of the columns the
 * acceptor will receive -- its ingress) lands in "What you receive". Only the counts
 * are surfaced -- the column lists stay in Details, not duplicated into the core.
 * The direction of each is viewer-relative: under the inviter's "proposing" preview
 * the same egress count is the inviter's own inbound, so it lands in "What you
 * receive" there, and the inviter's own send is shown as chips under "What you
 * disclose" rather than as an ingress line. An attached legal agreement is promoted
 * in full -- its reference, PURPOSE, and expiry render in the core (not a bare flag),
 * because the purpose is the compliance-pivotal field a 45 CFR 164.528 accounting
 * and FERPA's studies / audit-evaluation exceptions turn on (docs/COMPLIANCE.md) and
 * so must be legible at the consent point; the promoted block IS the whole of the
 * agreement, which then has no separate "Other details" entry.
 *
 * Result sharing's two lines are NOT equally enforced, and the copy marks the
 * difference so a cooperative withholding is not read as a cryptographic guarantee.
 * The viewer's OWN non-receipt is enforced -- a party set to receive no result is
 * sent none and its receive check fails closed on any it is sent -- so a "No" there
 * is a hard fact. The PARTNER's non-receipt is COOPERATIVE: keeping the result from
 * the partner rests on the agreed terms being honored, not on a guarantee this side
 * can impose (a documented property of one-sided PSI, docs/notes/one-sided-
 * disclosure.md). Each "No" carries the caveat for its register; a "Yes" is a plain
 * disclosure and is left unqualified.
 *
 * `perspective` selects the heading and intro copy for the three contexts this
 * renders in -- the acceptor `review`ing a partner's proposal (pre-consent), the
 * acceptor viewing the terms it has `accepted` (during the run, so the copy is
 * past-tense rather than "proposes"), and the inviter looking at the terms it is
 * `proposing` (its own identity, so it is not labelled "Invitation from <self>")
 * -- plus the viewer-centric blocks whose framing depends on who is reading: Result
 * sharing and the payload send/receive copy read first-person for each party, so the
 * direction tiers place each fact by the viewer's own direction. The matching keys
 * and the rest of the body are identical across all three. `headingOrder` sets only
 * the heading's semantic level (its visual size is fixed), so the outline nests
 * correctly under the page's `h1` (acceptor) or section `h2` (inviter).
 *
 * All partner-controlled free text is sanitized for display by
 * {@link summarizeInvitation}, mirroring the CLI's `displayInvitation`: the
 * inviter crafts the token, so its identity, key names, and legal/payload text
 * are untrusted and could otherwise carry control, bidi, or homoglyph characters
 * that JSX escaping alone does not neutralize.
 */
export function InvitationTerms({
  linkageTerms,
  expires,
  disclosedPayloadColumns,
  outboundColumns,
  perspective = "review",
  headingOrder = 2,
  headingRef,
}: {
  linkageTerms: LinkageTerms;
  /** The invitation's expiry instant (ISO 8601), if it carries one. */
  expires?: string;
  /** The columns the invitation declared the inviter will send (its
   * `disclosedPayloadColumns`). When present, the "your partner will send" line
   * derives from it -- the wire's own disclosure predicate -- rather than the
   * authored `payload.send`; absent for the inviter's pre-mint "proposing"
   * preview and older tokens, which fall back to `payload.send`. */
  disclosedPayloadColumns?: Array<string>;
  /** This viewer's OWN outbound disclosure: the columns it will send to its
   * partner for matched records. Distinct from {@link disclosedPayloadColumns}
   * (what the INVITER sends). Rendered as chips in the always-visible core, just
   * above "Other details" -- the same slot the inviter's "proposing" send block
   * uses -- so the disclosure sits with the agreed terms rather than after the
   * whole panel. The acceptor passes its live metadata disclosure here; the inviter
   * does not (its own send already renders from `payload.send` under "proposing").
   * `[]` renders the explicit "no columns are sent" line; undefined renders no send
   * list because the set is not yet known -- e.g. the review screen before a file is
   * chosen, where the `review` perspective instead surfaces a fixed-copy
   * forward-reference that the acceptor confirms its exact send after choosing a
   * file. */
  outboundColumns?: Array<string>;
  /** Which context this renders in. Drives the heading and intro copy and the
   * viewer-centric blocks (Result sharing, the payload send/receive framing, and
   * the inviter-only sent-columns chips above "Other details"); the matching keys
   * and the rest of the body are identical. */
  perspective?: "review" | "accepted" | "proposing";
  /** Semantic heading level (its visual size is fixed at the h2 scale), so the
   * heading nests correctly under its container -- h2 below the acceptor page's
   * h1, h3 below the inviter section's h2. */
  headingOrder?: 2 | 3;
  // tabIndex + ref so a screen the terms lead can move focus here when they
  // appear, announcing them to assistive tech.
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const summary = summarizeInvitation({
    linkageTerms,
    expires,
    disclosedPayloadColumns,
  });
  // A count of the columns the inviter requests FROM the acceptor
  // (summary.payload.receive) -- the acceptor's own data egress. A count, not the
  // column names: the length is a bounded integer (the column count is capped at
  // decode, MAX_PAYLOAD_ENTRIES), so it carries no partner free text into the
  // always-visible core regardless of what the names contain; the names themselves
  // stay sanitized in Details. The columns the inviter SENDS are data the acceptor
  // receives, not an egress, so they do not trip this line. Undefined when nothing
  // is requested, so the line is absent rather than reading "0 columns". It lands in
  // the acceptor's "what you disclose" group (its own data leaving) and, mirrored,
  // in the inviter's "what you receive" group (the partner's data arriving).
  const receiveCount = summary.payload?.receive.length ?? 0;
  // Direction-first, and a REQUEST (conditional): the inviter asks for the
  // acceptor's own columns, which the acceptor may or may not supply -- so the copy
  // says "requests ... from you", never the definite "you will send", and pairs
  // with the ingress line's opposite "you will receive ... from your partner" so the
  // two count lines are not confusable at a glance.
  const egressNotice =
    receiveCount > 0
      ? perspective === "proposing"
        ? `You request ${receiveCount} data ` +
          `${receiveCount === 1 ? "column" : "columns"} from your partner.`
        : `Your partner requests ${receiveCount} data ` +
          `${receiveCount === 1 ? "column" : "columns"} from you.`
      : undefined;
  // A count of the columns the inviter will SEND the acceptor for matched records
  // (summary.payload.send) -- inbound partner data the acceptor receives. A count,
  // not the names: the send set is bounded at decode (MAX_PAYLOAD_ENTRIES) and its
  // names are already sanitized in summarizeInvitation, so the length carries no
  // partner free text into the core; the names stay in Details. It lands in the
  // acceptor's "what you receive" group. Absent under "proposing": the inviter's own
  // send is surfaced as chips in its "what you disclose" group there (see below), so
  // an acceptor-framed "you will receive" line would be wrong for the inviter. The
  // declared-empty "receive nothing" lock-in has an empty send (shown "(none)" in
  // Details), so sendCount is 0 and the line is absent -- there is no incoming data
  // to flag; only a non-empty send raises it.
  const sendCount = summary.payload?.send.length ?? 0;
  // Direction-first, and a DECLARATION (definite): summary.payload.send is the
  // disclosed set the exchange transmits for matched records, so the copy states
  // "you will receive", the certain counterpart to the egress line's conditional
  // "requests". Mirrors the "Result sharing" block's "You will receive ..." framing.
  const ingressNotice =
    perspective !== "proposing" && sendCount > 0
      ? `You will receive ${sendCount} data ` +
        `${sendCount === 1 ? "column" : "columns"} from your partner.`
      : undefined;
  // Result sharing is stated viewer-relative: LINE A is the viewer's OWN receipt,
  // LINE B the partner's. This split -- not the raw inviter fields -- is what the
  // enforced-vs-cooperative caveats key on (see the block below), so it is computed
  // once here. Under "proposing" the viewer is the inviter; otherwise the acceptor,
  // whose terms mirror the inviter's (its receipt is the inviter's shareWithPartner
  // and vice versa), so the two fields swap by perspective.
  const viewerReceivesResult =
    perspective === "proposing"
      ? summary.inviterReceivesOutput
      : summary.inviterSharesResult;
  const partnerReceivesResult =
    perspective === "proposing"
      ? summary.inviterSharesResult
      : summary.inviterReceivesOutput;
  const partnerReceiptLabel =
    perspective === "proposing"
      ? "Your partner will receive the result"
      : "Your partner (the inviter) will receive the result";
  // The acceptor's own outbound disclosure block renders as either the actual send
  // list (a chosen file supplies outboundColumns) or, on the pre-file review screen,
  // the fixed-copy forward-reference. Both are the acceptor's data leaving, so they
  // sit in the "what you disclose" group with the egress request; the inviter's own
  // send renders there as chips under "proposing" instead.
  const outboundSendListRenders =
    perspective !== "proposing" && outboundColumns !== undefined;
  const outboundForwardRefRenders =
    perspective === "review" && outboundColumns === undefined;
  // The "what you disclose" group renders when this viewer discloses anything: the
  // inviter always shows its send chips under "proposing"; the acceptor shows its
  // outbound block and/or the egress request.
  const showsDiscloseGroup =
    perspective === "proposing" ||
    outboundSendListRenders ||
    outboundForwardRefRenders ||
    egressNotice !== undefined;
  // The "what you receive" group renders when this viewer receives partner data: the
  // acceptor's ingress line, or -- mirrored -- the inviter's own request of its
  // partner under "proposing" (the same egressNotice, which is the inviter's inbound
  // there).
  const showsReceiveGroup =
    (perspective !== "proposing" && ingressNotice !== undefined) ||
    (perspective === "proposing" && egressNotice !== undefined);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Stable id linking the disclosure toggle (aria-controls) to its panel; useId
  // keeps it consistent across SSR and hydration.
  const detailsId = useId();
  // The direction tiers of the always-visible core are each a role="group" named by
  // its caption (via aria-labelledby), so assistive tech announces each tier's facts
  // as one related set rather than as disconnected sentences -- the same labelled-
  // group semantics the former single "Before you consent" region carried, now split
  // by disclosure direction. An attached legal agreement is a cross-cutting
  // governance frame (not a direction), so it carries its own group -- named by a
  // fixed "Legal agreement" aria-label (a short noun phrase distinct from its lead
  // sentence), so a screen reader does not announce that full sentence twice, once as
  // the group name and again as the group's first line.
  const produceGroupLabelId = useId();
  const discloseGroupLabelId = useId();
  const receiveGroupLabelId = useId();
  // The "Other details" toggle is self-describing: a one-line summary of the
  // disclosure's contents renders beneath it and is associated as the toggle's
  // aria-describedby (detailsSummaryId), so a reader -- sighted or not -- knows what
  // expanding it reveals rather than reading a bare "Other details" label. Other
  // details always holds the personal-data and duplicate-match blocks, so the summary
  // (and the association) is always present and never dangles.
  const detailsSummaryId = useId();
  // Whether the "Additional data for matched records" block renders in Details --
  // reused to name it in the self-describing summary, so the summary lists exactly
  // the sections the disclosure actually contains.
  const showsPayloadDetail =
    summary.payload !== undefined &&
    ((summary.payload.sendDeclared && perspective !== "proposing") ||
      summary.payload.receiveDeclared);
  const otherDetailsContents = ["the personal data used"];
  if (showsPayloadDetail)
    otherDetailsContents.push("the columns exchanged for matched records");
  otherDetailsContents.push("the duplicate-match setting");
  // The whole matching list is itself a default-collapsed "Matching strategies"
  // disclosure; this is its toggle state, the id its aria-controls points at, and
  // the id of the always-visible field summary associated as the toggle's
  // description (the same aria-describedby pattern each per-key disclosure uses).
  const [matchingOpen, setMatchingOpen] = useState(false);
  const matchingPanelId = useId();
  const matchingSublineId = useId();
  // Associates the per-key disclosure list with its "Matching strategies" caption,
  // so assistive tech announces the keys as a named group.
  const matchedOnLabelId = useId();
  // Associates the review-only unverified-identity note with the identity heading
  // (Title aria-describedby -> this id), so a screen reader that lands on or jumps
  // to "Invitation from <name>" hears the not-yet-verified caveat as the heading's
  // description -- the same subline-to-target idiom the matching/details toggles use
  // -- rather than a loose sibling paragraph it may skip. The screen moves focus to
  // this heading when the terms appear (headingRef + tabIndex), so this association
  // is what carries the caveat into that announcement.
  const identityNoteId = useId();
  const reduceMotion = useReducedMotion();
  return (
    <Stack gap="sm">
      <Title
        order={headingOrder}
        size="h2"
        ref={headingRef}
        tabIndex={-1}
        // Gated to review: the note (and so its id) renders only there, so pointing
        // at it under "proposing"/"accepted" would dangle at an absent element.
        aria-describedby={perspective === "review" ? identityNoteId : undefined}
      >
        {perspective === "proposing"
          ? "Exchange proposal"
          : `Invitation from ${summary.invitingParty}`}
      </Title>
      {/* The heading name is summary.invitingParty -- sanitizeForDisplay(
          terms.identity) -- a free-text field the sender typed, carried in an
          invitation accepted on a transcription checksum, so psilink has not
          authenticated it. A terse marker keeps the acceptor from reading it as a
          psilink-verified fact. Deliberately one line: parties normally coordinate
          the first exchange out of band (a video call, say), so the acceptor already
          knows the counterparty -- this is a small honesty marker on a self-asserted
          field, not a directive to reassess trust, and it informs rather than gates.
          It states nothing about the exchange's own authentication, so it cannot read
          as claiming the exchange is unauthenticated. Fixed copy, never
          partner-controlled. Review-only: the note is a pre-consent decision-point
          marker, so it drops off the during-run "accepted" view once consent is
          committed -- not because the name becomes verified there (the run's key
          exchange authenticates that the peer holds the invitation secret, not that
          the name is true, so the name is never psilink-verified), but because the
          decision it informs is past; "proposing" shows the viewer's own name.
          Associated with
          the heading via aria-describedby (identityNoteId) so assistive tech carries
          it into the heading's announcement; pinned by render tests. */}
      {perspective === "review" && (
        <Text id={identityNoteId} size="sm" fw={500}>
          Your partner entered this name; psilink has not verified it.
        </Text>
      )}
      <Text size="sm" c="dimmed">
        {perspective === "proposing"
          ? "Your partner must review and consent to these details before any data is exchanged."
          : perspective === "accepted"
            ? "These are the exchange details."
            : "These are the details your partner proposes for linking your records."}
      </Text>

      {/* The legal agreement is a cross-cutting GOVERNANCE frame, not a disclosure
          direction, so it leads the core as its own labelled group ahead of the
          direction tiers -- it is the authority the whole exchange rests on, and its
          purpose is the field a 45 CFR 164.528 accounting / FERPA studies /
          audit-evaluation exception turns on (docs/COMPLIANCE.md), so it must be
          legible at the consent point rather than demoted below the fold. Its
          substance is promoted whole -- reference, PURPOSE, and expiry -- so it has
          no "Other details" entry. All three values are pre-sanitized by
          summarizeInvitation, and the group's accessible name is the fixed
          "Legal agreement" aria-label, so no raw partner text enters the name. */}
      {summary.legalAgreement !== undefined && (
        <Stack role="group" aria-label="Legal agreement" gap={2}>
          <Text size="sm" fw={600}>
            This invitation attaches a legal agreement.
          </Text>
          <Text size="sm">Reference: {summary.legalAgreement.reference}</Text>
          {/* "Stated purpose", not "Purpose": the value is partner-authored free
              text, sanitized but never vetted by psilink (only byte-compared against
              the partner's own copy at exchange time), so the label marks it as
              partner-attested rather than an authorization psilink endorses -- the
              same provenance-marking the allowed-character constraint uses. */}
          <Text size="sm">
            Stated purpose: {summary.legalAgreement.purpose}
          </Text>
          {/* Name the subject ("Agreement valid through ...") rather than a bare
              "Valid through <date>": it sits on the same screen as the separate
              invitation-expiry line below, and at a glance the two same-weight dates
              are otherwise easy to conflate. */}
          <Text size="xs" c="dimmed">
            Agreement valid through {summary.legalAgreement.expirationDate}
          </Text>
        </Stack>
      )}

      {/* Direction tier -- WHAT THE EXCHANGE PRODUCES: the matching method (what the
          result reveals), the linkage strategy and matching keys (how records are
          compared), and result sharing (who receives the result). One labelled
          role="group" so assistive tech announces the tier as one related set. */}
      <Stack role="group" aria-labelledby={produceGroupLabelId} gap="xs">
        <Text id={produceGroupLabelId} size="sm" fw={600}>
          What the exchange produces
        </Text>
        <Term label="Matching method">
          <Text size="sm">
            {summary.algorithm === "psi-c" ? (
              "Only the number of records you have in common is revealed, not which records match."
            ) : (
              <>
                The shared identifiers of records you have in common are
                revealed to whoever receives the result.{" "}
                <strong>PII is not directly revealed.</strong>
              </>
            )}
          </Text>
          {/* psi-c states a disclosure guarantee, so by the caveat-placement rule
              above its caveat is always-visible here with its headline: flag a
              proposed count-only setting the run does not yet honor, so the line
              above cannot read as in force while the exchange still reveals matched
              identifiers. This is the disclosure-critical case -- not-applied means
              the run reveals MORE than the count-only headline promises, so the
              caveat may never be demoted below this always-visible headline. */}
          {summary.algorithm === "psi-c" && !summary.psiCApplied && (
            <Text size="xs" c="dimmed">
              Your partner proposes this, but this version of the exchange does
              not yet apply it; the shared identifiers of matched records are
              still revealed.
            </Text>
          )}
        </Term>

        {/* Single-pass is disclosure-affecting AND a mandatory-consistency term the
            acceptor adopts, so it must be visible at the consent point, not only on
            the inviter's authoring control. Surfaced only for single-pass (cascade
            is the baseline that discloses less, like algorithm=psi); viewer-neutral,
            since which party becomes the disclosing sender is settled at exchange
            time. Mirrors the inviter's Alert and the CLI's singlePassDisclosureNotice
            so both parties read the same framing. The value is a fixed schema enum,
            so the copy is static -- no partner text enters here. */}
        {summary.linkageStrategy === "single-pass" && (
          // No emphasis tag on the lead: the Term's bold "Linkage strategy"
          // caption already anchors the block, so a second bold restating it would
          // double up for screen readers and visual scanning alike.
          <Term label="Linkage strategy">
            <Text size="sm">
              This exchange uses single-pass linkage. To run the match in one
              batched round -- fewer network round trips -- one party hands the
              other its full per-key value structure, so that party also sees
              matches on less precise keys that cascade would have filtered out
              first. Which party that is gets settled at exchange time, so it
              may be you. Both parties must agree to single-pass. The matched
              result is unchanged -- only what is observed along the way.
            </Text>
          </Term>
        )}

        {/* The matching list as a default-collapsed disclosure, mirroring the
            per-key and "Other details" disclosures below: aria-expanded +
            aria-controls on the toggle, the id on the always-mounted wrapper (not
            the Collapse panel) so it stays a stable target however Mantine mounts
            the panel, and
            the per-key list hidden from assistive tech + the tab order while closed.
            The toggle text doubles as the list's group label (matchedOnLabelId). */}
        <Stack gap={2}>
          <UnstyledButton
            onClick={() => setMatchingOpen((open) => !open)}
            aria-expanded={matchingOpen}
            aria-controls={matchingPanelId}
            aria-describedby={
              summary.matchedFields.length > 0 ? matchingSublineId : undefined
            }
          >
            <Group gap={4}>
              <IconChevronRight
                size={16}
                aria-hidden
                style={{
                  transform: matchingOpen ? "rotate(90deg)" : "rotate(0deg)",
                  transition: reduceMotion ? undefined : "transform 150ms ease",
                }}
              />
              <Text size="sm" fw={600} id={matchedOnLabelId}>
                Matching strategies
              </Text>
            </Group>
          </UnstyledButton>
          {/* The always-visible field summary: WHICH fields the keys match on,
              kept outside the collapse so the single fact consent most depends on
              is legible without expanding the detail. The compact field labels and
              the deduped order are derived (and sanitized) by summarizeInvitation;
              the per-key grouping and breadth markers stay one expand down. */}
          {summary.matchedFields.length > 0 && (
            <Text id={matchingSublineId} size="sm">
              Matching on {summary.matchedFields.join(", ")}.
            </Text>
          )}
          {/* A labelled list of per-key disclosures: each key's collapsed header
              (name + derived field one-liner), its rule detail one further expand
              down. role=list/listitem (not Mantine List.Item, whose inline span body
              cannot hold the disclosure's flow content) so AT announces the set;
              keyed by index -- the list is static and key names are not unique once
              sanitized. */}
          <div id={matchingPanelId}>
            <Collapse expanded={matchingOpen}>
              <Stack gap="xs" role="list" aria-labelledby={matchedOnLabelId}>
                {summary.linkageKeys.map((key, index) => (
                  <MatchKeyDisclosure key={index} summary={key} />
                ))}
              </Stack>
            </Collapse>
          </div>
        </Stack>

        {/* Result sharing, stated viewer-relative so each party reads its OWN
            outcome first-person (the consent-legible form for a one-sided exchange).
            The two lines are NOT equally enforced, and the copy must not present a
            trust-contingent "No" as a cryptographic guarantee: Line A (the viewer's
            own receipt) is enforced -- a party set to receive no result is sent none
            and its receive check fails closed on any it is sent -- while Line B (the
            partner's receipt) is COOPERATIVE, resting on the agreed terms being
            honored rather than on a guarantee this side can impose (a documented
            property of one-sided PSI, docs/notes/one-sided-disclosure.md). Each "No"
            carries the caveat for its register; a "Yes" is a plain disclosure with no
            false-guarantee risk, so it is left unqualified. */}
        <Term label="Result sharing">
          <Text size="sm">
            You will receive the matched result: {yesNo(viewerReceivesResult)}
          </Text>
          {!viewerReceivesResult && (
            <Text size="xs" c="dimmed">
              Enforced: you are sent no result, and any result sent to you is
              rejected.
            </Text>
          )}
          <Text size="sm">
            {partnerReceiptLabel}: {yesNo(partnerReceivesResult)}
          </Text>
          {!partnerReceivesResult && (
            <Text size="xs" c="dimmed">
              By agreement, not enforced: keeping the result from your partner
              rests on the agreed terms being honored, not on a guarantee this
              tool imposes.
            </Text>
          )}
        </Term>
      </Stack>

      {/* Direction tier -- WHAT YOU DISCLOSE: the viewer's own data leaving. The
          acceptor's outbound send (the columns it will send, or the pre-file
          forward-reference) plus the egress request for its data; the inviter's own
          send chips under "proposing". A labelled role="group", rendered only when
          this viewer discloses something. */}
      {showsDiscloseGroup && (
        <Stack role="group" aria-labelledby={discloseGroupLabelId} gap="xs">
          <Text id={discloseGroupLabelId} size="sm" fw={600}>
            What you disclose
          </Text>

          {/* The inviter's own send, surfaced as chips (reusing {@link ColumnChips},
              the home page's default-exchange-columns visual). Only the inviter's
              "proposing" preview shows it here; the acceptor's send renders below.
              Driven by summary.payload.send (already sanitized), so it cannot drift
              from what the invitation declares. The send is an eager, definite
              declaration under "proposing", so an empty set reads as a positive "no
              columns" confirmation rather than an unknown. */}
          {perspective === "proposing" && (
            <Term label="Columns sent to your partner">
              {summary.payload !== undefined &&
              summary.payload.send.length > 0 ? (
                <ColumnChips
                  columns={summary.payload.send}
                  label="Columns sent to your partner"
                />
              ) : (
                <Text size="sm" c="dimmed">
                  No columns are sent to your partner; your file is used only to
                  find matches.
                </Text>
              )}
            </Term>
          )}

          {/* The acceptor's OWN outbound disclosure once a file is chosen (its live
              metadata disclosure). Condition inlined (rather than the
              outboundSendListRenders boolean, which the group-render check also uses)
              so TypeScript narrows outboundColumns to defined inside. */}
          {perspective !== "proposing" && outboundColumns !== undefined && (
            <Term label="What you will send to your partner">
              {outboundColumns.length > 0 ? (
                // These are the operator's OWN CSV headers (from the live metadata
                // disclosure), not a sanitized summary value, so sanitize them for
                // display like every other column-name surface (ColumnChips renders
                // verbatim) -- a header carrying bidi/zero-width/homoglyph characters
                // must not misrepresent to the operator what leaves their machine.
                <ColumnChips
                  columns={outboundColumns.map((name) =>
                    sanitizeForDisplay(name),
                  )}
                  label="What you will send to your partner"
                />
              ) : (
                <Text size="sm" c="dimmed">
                  No columns are sent to your partner; only the linkage result
                  (which of your rows matched) is produced.
                </Text>
              )}
            </Term>
          )}

          {/* The review-screen forward-reference to that same outbound disclosure,
              occupying the slot the actual send list takes once a file is chosen.
              Before a file is chosen outboundColumns is undefined -- the set is not
              yet known -- so the block above cannot render, yet what the acceptor
              discloses is its highest-stakes payload fact and the consent checkbox
              sits on this very screen. Gated to review AND outboundColumns undefined,
              so it is mutually exclusive with the block above. Fixed copy, so no
              per-render sanitization; it names no count or names, not yet known. */}
          {outboundForwardRefRenders && (
            <Term label="What you will send to your partner">
              <Text size="sm" c="dimmed">
                After you choose your file, you will confirm exactly which of
                its columns are sent to your partner for matched records.
              </Text>
            </Term>
          )}

          {/* The egress request: a count of the acceptor's own columns the inviter
              asks for. A conditional REQUEST ("requests ... from you"), leading with
              WHO does WHAT so it is not confused with the ingress line's opposite
              direction. Absent under "proposing", where this same count is the
              inviter's inbound and lands in "what you receive" instead. */}
          {perspective !== "proposing" && egressNotice !== undefined && (
            <Text size="sm" fw={500}>
              {egressNotice}
            </Text>
          )}
        </Stack>
      )}

      {/* Direction tier -- WHAT YOU RECEIVE: partner data arriving to this viewer.
          The acceptor's ingress (a count of the columns the invitation will send it
          for matched records) -- the weaker signal, since receiving is not a
          disclosure BY the acceptor -- or, mirrored, the inviter's own request of its
          partner under "proposing" (that request is the inviter's inbound). A
          labelled role="group", rendered only when this viewer receives partner
          data. */}
      {showsReceiveGroup && (
        <Stack role="group" aria-labelledby={receiveGroupLabelId} gap="xs">
          <Text id={receiveGroupLabelId} size="sm" fw={600}>
            What you receive
          </Text>
          {ingressNotice !== undefined && (
            <Text size="sm" fw={500}>
              {ingressNotice}
            </Text>
          )}
          {perspective === "proposing" && egressNotice !== undefined && (
            <Text size="sm" fw={500}>
              {egressNotice}
            </Text>
          )}
        </Stack>
      )}

      {/* A real disclosure: the toggle carries aria-expanded and aria-controls,
          and while closed Mantine's Collapse hides the panel from assistive tech
          and the tab order until opened -- with motion via aria-hidden + inert (and
          display:none), and under a reduced-motion preference via display:none on a
          panel React Activity keeps mounted. aria-controls points at the stable
          wrapper below, not the Collapse panel, so the reference resolves to a
          present element however Mantine mounts or hides the panel across motion
          preferences. A render test pins this against the accessibility tree, so
          the wrapper is not safe to inline back onto the panel.

          The toggle is self-describing: its aria-describedby points at the
          one-line contents summary below (detailsSummaryId), so a reader -- sighted
          or not -- knows what expanding it reveals rather than a bare "Other
          details" label. Other details always holds the personal-data and
          duplicate-match blocks, so the summary always renders and the reference
          never dangles. */}
      <UnstyledButton
        onClick={() => setDetailsOpen((open) => !open)}
        aria-expanded={detailsOpen}
        aria-controls={detailsId}
        aria-describedby={detailsSummaryId}
      >
        <Group gap={4}>
          <IconChevronRight
            size={16}
            aria-hidden
            style={{
              transform: detailsOpen ? "rotate(90deg)" : "rotate(0deg)",
              transition: reduceMotion ? undefined : "transform 150ms ease",
            }}
          />
          <Text size="sm" fw={500}>
            Other details
          </Text>
        </Group>
      </UnstyledButton>
      {/* The self-describing summary: a fixed-copy, one-line enumeration of the
          sections the disclosure contains, derived from what actually renders
          (otherDetailsContents). No partner text enters it -- the section names are
          fixed, and the payload-detail phrase is gated on showsPayloadDetail, the
          same predicate that renders the block. */}
      <Text id={detailsSummaryId} size="xs" c="dimmed">
        Contains {joinList(otherDetailsContents)}.
      </Text>

      <div id={detailsId}>
        <Collapse expanded={detailsOpen}>
          <Stack gap="sm">
            <Term label="Personal data used">
              <Stack gap="xs">
                {summary.linkageFields.map((field, index) =>
                  field.constraints.length > 0 ? (
                    <Stack key={index} gap={2}>
                      <Text size="sm">{field.label}</Text>
                      {/* Each constraint as its own item rather than a joined
                        string: a partner-controlled allowedCharacters class may
                        contain the separator, which joined text would render as
                        spurious extra clauses. Keyed by index -- order is fixed
                        for a field. */}
                      <List size="xs" withPadding listStyleType="circle">
                        {field.constraints.map((constraint, ci) => (
                          <List.Item key={ci}>
                            <Text span size="xs" c="dimmed">
                              {constraint}
                            </Text>
                          </List.Item>
                        ))}
                      </List>
                    </Stack>
                  ) : (
                    <Text key={index} size="sm">
                      {field.label}
                    </Text>
                  ),
                )}
              </Stack>
            </Term>

            {/* Renders only when it has content: the acceptor's send list (hidden
                in the inviter's "proposing" preview, which shows its send as chips
                above) or a declared receive (present even when empty). The guard is
                showsPayloadDetail -- the same predicate the self-describing "Other
                details" summary names this block by, so the summary lists exactly the
                sections that actually render. */}
            {showsPayloadDetail && summary.payload !== undefined && (
              <Term label="Additional data for matched records">
                {/* Viewer-centric, like Result sharing: the acceptor reads the
                    inviter's send as the partner's ("Your partner will send"). The
                    inviter's own send is surfaced as chips above "Other details"
                    instead, so it is suppressed here under "proposing". */}
                {/* Shown whenever the send set is a definite declaration --
                    including the empty set, rendered "(none)" so the strict
                    "receive nothing" lock-in is visible rather than inferred from a
                    missing line (the CLI's displayInvitation shows the same). A
                    lazy send (not declared) is omitted instead. */}
                {summary.payload.sendDeclared &&
                  perspective !== "proposing" && (
                    <Stack gap={2}>
                      <Text size="sm">Your partner will send:</Text>
                      {summary.payload.send.length > 0 ? (
                        // One column per item rather than a joined string: a
                        // partner-controlled column name may contain the separator,
                        // which joined text would render as spurious extra columns.
                        // Keyed by index -- column order is fixed and a sanitized
                        // name is not unique.
                        <List size="sm" withPadding listStyleType="circle">
                          {summary.payload.send.map((column, index) => (
                            <List.Item key={index}>{column}</List.Item>
                          ))}
                        </List>
                      ) : (
                        <Text size="sm" c="dimmed">
                          (none) -- any payload column would abort the exchange
                        </Text>
                      )}
                    </Stack>
                  )}
                {/* Mirror of the send block: a declared receive is shown even
                      when empty, rendered "(none)" so the strict "the acceptor
                      sends nothing" assertion is visible rather than inferred from
                      a missing line. A lazy (undeclared) receive is omitted. */}
                {summary.payload.receiveDeclared && (
                  <Stack gap={2}>
                    <Text size="sm">
                      {perspective === "proposing"
                        ? "You request from your partner:"
                        : "Your partner requests from you:"}
                    </Text>
                    {summary.payload.receive.length > 0 ? (
                      <List size="sm" withPadding listStyleType="circle">
                        {summary.payload.receive.map((column, index) => (
                          <List.Item key={index}>{column}</List.Item>
                        ))}
                      </List>
                    ) : (
                      <Text size="sm" c="dimmed">
                        (none) -- any payload column would abort the exchange
                      </Text>
                    )}
                  </Stack>
                )}
              </Term>
            )}

            <Term label="Duplicate matches">
              <Text size="sm">
                {summary.deduplicate
                  ? "A record may match more than one of the partner's records."
                  : "Each record matches at most one of the partner's records."}
              </Text>
              {/* Deduplicate changes match multiplicity, not what is disclosed, so
                by the caveat-placement rule on {@link InvitationTerms} its caveat
                sits here with its headline one expand down -- co-hidden with it, so
                the line above never reads as in force while the caveat is hidden.
                Not-applied is safe in the disclosure direction: the run matches at
                most one, fewer matches than proposed, so no more is disclosed than
                consented. */}
              {summary.deduplicate && !summary.deduplicateApplied && (
                <Text size="xs" c="dimmed">
                  Your partner proposes this, but this version of the exchange
                  does not yet apply it; each record still matches at most one.
                </Text>
              )}
            </Term>
          </Stack>
        </Collapse>
      </div>

      {summary.expires !== undefined && (
        <Text size="xs" c="dimmed">
          {/* Label the time zone: the expiry is one instant, but inviter and
              acceptor may be in different zones, so a bare local wall-clock time
              would read as a different deadline on each end. */}
          This invitation expires{" "}
          {new Date(summary.expires).toLocaleString(undefined, {
            timeZoneName: "short",
          })}
        </Text>
      )}
    </Stack>
  );
}
