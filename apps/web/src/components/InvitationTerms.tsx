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

import {
  CONSENT_FACTS,
  COUNT_ONLY_DISCLOSURE_STATEMENT,
  DEDUPLICATE_ACCEPTOR_SIDE_NOTE,
  DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
  DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
  LINKAGE_RULE_SET_VERDICT_COPY,
  MAX_DECLARED_NAMES_SHOWN,
  OUTBOUND_SEND_NO_PAYLOAD_SENTENCE,
  PROPOSED_NOT_APPLIED_NOTES,
  UNRECOGNIZED_TRANSFORM_NOTE,
  distinctLinkageRuleSetVerdicts,
  linkageRuleSetVerdictNote,
  ruleSetCitation,
  sanitizeForDisplay,
  summarizeInvitation,
  unshownDeclaredNamesLine,
} from "@psilink/core";

import { ColumnChips } from "@components/ColumnChips";

import type { ReactNode, Ref } from "react";

import type {
  ConnectionEndpoint,
  InvitationKeySummary,
  LinkageTerms,
} from "@psilink/core";

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

/** The count phrase every payload-column notice states its magnitude with ("1 data
 * column", "3 data columns"). Shared so the outbound-send, egress-request, and
 * ingress lines cannot drift in wording or in the singular/plural form they take at
 * a count of one. */
function dataColumns(count: number): string {
  return `${count} data ${count === 1 ? "column" : "columns"}`;
}

/** Join phrases into an Oxford-comma English list ("a", "a and b", "a, b, and c"),
 * for the self-describing "Other details" summary. */
function joinList(items: Array<string>): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * The bounded frame a raw partner-controlled value is rendered in: its own box,
 * so the value cannot run into the fixed chrome around it. Shared by the
 * rule-set citation and declared apart from the allowed-character class's inline
 * copy only because the citation renders two of them.
 */
const ruleSetValueStyle = {
  border: "1px solid var(--mantine-color-default-border)",
  borderRadius: "var(--mantine-radius-sm)",
  padding: "2px 6px",
  wordBreak: "break-all",
} as const;

/** A labelled block: a bold caption above its value(s). When `captionId` is set it
 * is put on the caption, so a child that is itself a labelled region (a
 * {@link ColumnChips} list) can name itself from the visible caption via
 * aria-labelledby rather than a second, separately-authored aria-label that
 * could drift from the caption. */
function Term({
  label,
  captionId,
  children,
}: {
  label: string;
  captionId?: string;
  children: ReactNode;
}) {
  return (
    <Stack gap={2}>
      <Text size="sm" fw={600} id={captionId}>
        {label}
      </Text>
      {children}
    </Stack>
  );
}

/**
 * One tier of the always-visible core: a heading caption and the facts grouped under
 * it, marked up as a role="group" the heading names. Every tier renders through this
 * one component so grouping, heading level, and accessible-name wiring cannot
 * diverge tier by tier.
 *
 * Named by its own visible heading via aria-labelledby, so the accessible name
 * cannot drift from what a sighted reader sees. `accessibleName` replaces that with
 * a fixed aria-label for a tier whose visible heading is a full sentence, so a
 * screen reader does not announce the sentence twice.
 */
function TermsTier({
  heading,
  headingOrder,
  accessibleName,
  children,
}: {
  heading: ReactNode;
  /** Semantic level of the tier caption, one below the terms heading, so the tiers
   * nest under it and a screen reader can jump between them by heading. */
  headingOrder: 2 | 3 | 4;
  /** A short fixed noun phrase naming the group, for a tier whose heading is a
   * sentence. Omitted by every tier whose heading already names it. */
  accessibleName?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <Stack
      role="group"
      aria-label={accessibleName}
      aria-labelledby={accessibleName === undefined ? headingId : undefined}
      gap="xs"
    >
      <Title order={headingOrder} fz="md" fw={600} id={headingId}>
        {heading}
      </Title>
      {children}
    </Stack>
  );
}

/**
 * The magnitude of this viewer's own outbound send, stated above the column-name
 * chips so a reader takes in how much leaves before which columns do. Renders only
 * where the set is known and non-empty; an empty set or a not-yet-chosen file state
 * their own case in this slot instead. Renders undimmed, unlike the empty-set
 * fallback text that occupies this slot when the set is empty.
 */
function OutboundSendCount({ count }: { count: number }) {
  return (
    <Text size="sm">You will send {dataColumns(count)} to your partner.</Text>
  );
}

/**
 * One of the invitation's declared payload directions as a list of column names,
 * bounded by count: at most {@link MAX_DECLARED_NAMES_SHOWN} names render and the
 * remainder is counted in the closing line.
 *
 * Keyed by index: column order is fixed and a sanitized name is not unique. One
 * column per item, not a joined string -- a partner-controlled name may contain the
 * separator, which joined text would render as spurious extra columns.
 */
function DeclaredColumnList({ columns }: { columns: Array<string> }) {
  const shown = columns.slice(0, MAX_DECLARED_NAMES_SHOWN);
  const unshownCount = columns.length - shown.length;
  return (
    <>
      <List size="sm" withPadding listStyleType="circle">
        {shown.map((column, index) => (
          <List.Item key={index}>{column}</List.Item>
        ))}
      </List>
      {unshownCount > 0 && (
        <Text size="sm">{unshownDeclaredNamesLine(unshownCount)}</Text>
      )}
    </>
  );
}

/**
 * One linkage key as a collapsible disclosure: the always-visible header is the
 * key's name and a derived one-liner of the fields it matches on, and the expanded
 * body is the per-element transform/swap/fuzzy detail ({@link MatchKeyDetails}).
 * The field one-liner is derived from the schema-validated semantic types
 * ({@link InvitationKeySummary.headerFields}), so a partner-controlled key name
 * cannot misrepresent what the key matches on.
 *
 * aria-expanded/aria-controls on the toggle, the id on the always-mounted wrapper
 * (not the Collapse panel) so it stays a stable target, and the panel hidden from
 * assistive tech and the tab order while closed. The toggle's accessible name is
 * the key name alone; the field one-liner is its description (aria-describedby)
 * rather than folded into the name.
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
          if ever reached, so the joined line contains no unescaped partner text. */}
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
  // A block, not a <List.Item>: it holds flow content (a nested element list, a
  // swap note), which Mantine's List.Item would place inside an inline <span>,
  // producing invalid markup. The key name is not repeated here -- the disclosure
  // header states it.
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
                  {/* Fuzzy changes match breadth, not the disclosure guarantee, so by
                      the caveat-placement rule on {@link InvitationTerms} it stays here
                      with the annotation it qualifies, flagging a proposed expansion
                      the run does not yet perform. Not-applied narrows the match, the
                      safe direction, so it needs no core prominence. */}
                  {!element.fuzzyComparisonApplied &&
                    ` ${PROPOSED_NOT_APPLIED_NOTES.fuzzyComparisons}`}
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
                    for a function core does not recognize -- the shared note saying
                    so. Fixed/sanitized copy, read from core so the two consent
                    surfaces cannot state an unexplained rule differently. */}
                <Text size="xs" c="dimmed">
                  {transform.effect !== undefined
                    ? `Matches on ${transform.effect}`
                    : (transform.description ?? UNRECOGNIZED_TRANSFORM_NOTE)}
                </Text>
                {/* The function name as secondary detail under whichever lead ran,
                    so the technical identity stays available while never standing
                    where the matching consequence goes. */}
                <Text size="xs" c="dimmed" pl="md" fs="italic">
                  {transform.function}
                </Text>
                {transform.params.map((param, pi) => (
                  <Text key={pi} size="xs" c="dimmed" pl="md">
                    {param}
                  </Text>
                ))}
                {/* Runtime-coercion notes for params the function overrides (e.g.
                    replacement: null runs as the empty string). Rendered as their
                    own element with the fixed "runs as" copy as static JSX text
                    between two core-derived values -- never folded into a
                    partner-controlled param line -- so the note cannot be
                    impersonated. The VisuallyHidden lead-in gives that same
                    provenance to a screen reader, since the italic marking is not
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
      {/* Each swapped element's transforms run against the OTHER element's field
          value (the field references swap, the transforms stay put), which the
          generic swap note above does not convey. When both sides have transforms
          it is a bidirectional interchange; when one does, a one-directional donor
          -> recipient note. Both flags imply swap is set and are mutually
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
 * Wraps the terms panel's lower reference tiers (what you receive, how records are
 * matched, the legal agreement, and "Other details") in one default-collapsed
 * disclosure when {@link condensed}; otherwise renders them inline unchanged.
 * Never set on the acceptor's pre-consent "review" screen, the one place informed
 * consent is captured, so no tier is ever hidden from that decision.
 *
 * The always-mounted wrapper, with aria-controls and the self-describing
 * describedby summary, mirrors the "Other details" idiom, so a folded tier stays out
 * of the accessibility tree and tab order while collapsed yet remains reachable.
 */
function CondensableDetails({
  condensed,
  children,
}: {
  condensed: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Stable ids across SSR/hydration for the toggle -> panel and toggle -> summary
  // associations, matching every other disclosure on this screen.
  const panelId = useId();
  const summaryId = useId();
  const reduceMotion = useReducedMotion();
  // Non-condensed: a transparent passthrough (a Fragment adds no DOM node), so the
  // acceptor's full render is byte-identical to the un-wrapped tree.
  if (!condensed) return <>{children}</>;
  return (
    <Stack gap={2}>
      <UnstyledButton
        onClick={() => setOpen((isOpen) => !isOpen)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={summaryId}
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
            See the full terms
          </Text>
        </Group>
      </UnstyledButton>
      {/* Self-describing, like "Other details": always truthful across configs -- the
          matching keys are always present, and "the other terms" covers the
          receive/legal/dedup/payload sections whichever render. Perspective-neutral
          ("terms", not "proposed terms") so it reads correctly on the acceptor's
          post-consent "accepted" surfaces, where the terms are agreed, not proposed. */}
      <Text id={summaryId} size="xs" c="dimmed">
        Contains how records are matched and the other terms.
      </Text>
      <div id={panelId}>
        <Collapse expanded={open}>
          <Stack gap="sm">{children}</Stack>
        </Collapse>
      </div>
    </Stack>
  );
}

/**
 * Renders the inviter's linkage terms decoded from an invitation for review,
 * organized by disclosure DIRECTION into labelled tiers ("What you disclose",
 * "What the exchange produces", "What you receive", "How records are matched",
 * then the legal agreement), with the dense remainder behind a single
 * default-collapsed "Other details" disclosure. Every tier renders through
 * {@link TermsTier}.
 *
 * A caveat that qualifies a headline setting renders at the SAME visibility level
 * as that headline, never one collapse-level down, so a reader can never see a
 * headline as in force while what qualifies it is hidden. Copy is read from
 * `CONSENT_FACTS`, `PROPOSED_NOT_APPLIED_NOTES`, and the deduplicate disclosure
 * statements in `@psilink/core`, which the CLI accept prompt renders too, so the
 * two surfaces cannot state one fact two ways.
 *
 * Result sharing is stated viewer-relative. The viewer's OWN non-receipt is
 * enforced (a party set to receive no result is sent none); the PARTNER's
 * non-receipt is COOPERATIVE, resting on the agreed terms rather than a guarantee
 * this side can impose (docs/notes/one-sided-disclosure.md), and a non-receiving
 * partner in a `psi` exchange additionally learns its own records' membership -- a
 * documented, bounded property, not disclosed under `psi-c`.
 *
 * An attached legal agreement renders whole (reference, purpose, expiry) because
 * its purpose is the field a 45 CFR 164.528 / FERPA exception turns on
 * (docs/COMPLIANCE.md).
 *
 * `perspective` selects the heading, intro, and viewer-centric framing for the
 * three contexts this renders in (`review`, `accepted`, `proposing`); `framing`
 * overrides only the heading/intro strings, for the console's direct-exchange
 * flow. All partner-controlled free text is sanitized via
 * {@link summarizeInvitation}, mirroring the CLI's `displayInvitation`.
 */
export function InvitationTerms({
  linkageTerms,
  expires,
  disclosedPayloadColumns,
  inviterRetainsFiles,
  connectionEndpoint,
  outboundColumns,
  perspective = "review",
  headingOrder = 2,
  headingRef,
  condensed = false,
  framing,
}: {
  linkageTerms: LinkageTerms;
  /** The invitation's expiry instant (ISO 8601), if it has one. */
  expires?: string;
  /** The columns the invitation declared the inviter will send (its
   * `disclosedPayloadColumns`). When present, the "your partner will send" line
   * derives from it -- the wire's own disclosure predicate -- rather than the
   * authored `payload.send`; absent for the inviter's pre-mint "proposing"
   * preview and older tokens, which fall back to `payload.send`. */
  disclosedPayloadColumns?: Array<string>;
  /** The invitation's retain-mode declaration: the inviter stating its exchange
   * keeps every file it writes rather than deleting each once read. Rendered as a
   * consent fact under "What the exchange produces"; nothing renders when false or
   * absent, neither of which claims files are cleaned up. Passed by the acceptor
   * screen from the decoded token; omitted by the inviter's own preview. */
  inviterRetainsFiles?: boolean;
  /** The invitation's credential-free connection endpoint, passed by the acceptor
   * screen from the decoded token. Read for its SHAPE alone: a split
   * inbound/outbound endpoint requires retain mode, so it states the retention
   * above even where the token declares nothing -- otherwise a party seeded into
   * retain mode from the endpoint would consent with nothing said. */
  connectionEndpoint?: ConnectionEndpoint;
  /** This viewer's OWN outbound disclosure: the columns it will send to its
   * partner for matched records. Distinct from {@link disclosedPayloadColumns}
   * (what the INVITER sends). Rendered as a count and then chips in the
   * always-visible core, in the same slot the inviter's "proposing" send block
   * uses. The acceptor passes its live metadata disclosure here; the inviter does
   * not.
   *
   * `[]` renders the explicit "no columns are sent" line; undefined renders no
   * send list because the set is not yet known (e.g. before a file is chosen,
   * where `review` shows a forward-reference instead). Neither value reaches the
   * screen when the invitation gives the inviting party no result. */
  outboundColumns?: Array<string>;
  /** Which context this renders in. Drives the heading and intro copy, the
   * viewer-centric blocks (Result sharing, the payload send/receive framing, and
   * the inviter-only sent-columns chips above "Other details"), and the two
   * `review`-only caveats on a partner's own word (the unverified identity and
   * the rule-set citation's attribution); the matching keys and the rest of the
   * body are identical. */
  perspective?: "review" | "accepted" | "proposing";
  /** Semantic heading level (its visual size is fixed at the h2 scale), so the
   * heading nests correctly under its container -- h1 when this is the page's
   * own heading (the console review step), h2 below the acceptor page's h1, h3
   * below the inviter section's h2. */
  headingOrder?: 1 | 2 | 3;
  // tabIndex + ref so a screen the terms lead can move focus here when they
  // appear, announcing them to assistive tech.
  headingRef?: Ref<HTMLHeadingElement>;
  /** Fold the lower reference tiers (what you receive, how records are matched, the
   * legal agreement, and "Other details") into one default-collapsed disclosure,
   * keeping only "What you disclose" and "What the exchange produces" always
   * visible. NEVER set on the acceptor's pre-consent "review" screen, whose every
   * tier must stay always-visible for informed consent. See
   * {@link CondensableDetails}. */
  condensed?: boolean;
  /** A direct-exchange framing override: replaces ONLY the perspective-derived
   * heading and intro copy, for a no-invitation direct exchange (the operator's own
   * inferred terms, no partner review/consent). Passed only by the console direct
   * flow, paired with `perspective="proposing"`, so every viewer-centric block still
   * renders as the proposing preview does. Fixed, caller-supplied copy, never
   * partner text. */
  framing?: { heading: string; intro: string };
}) {
  const summary = summarizeInvitation({
    linkageTerms,
    expires,
    disclosedPayloadColumns,
    inviterRetainsFiles,
    connectionEndpoint,
  });
  // A count of the columns the inviter requests FROM the acceptor (the acceptor's
  // own data egress). A count, not names: the length is a bounded integer
  // (MAX_PAYLOAD_ENTRIES at decode), so no partner free text enters the
  // always-visible core; names stay sanitized in Details. Lands in the acceptor's
  // "what you disclose" group and, mirrored, the inviter's "what you receive"
  // group.
  const receiveCount = summary.payload?.receive.length ?? 0;
  // Direction-first, and a REQUEST (conditional): the inviter asks for the
  // acceptor's own columns, which the acceptor may or may not supply -- so the copy
  // says "requests ... from you", never the definite "you will send", and pairs
  // with the ingress line's opposite "you will receive ... from your partner" so the
  // two count lines are not confusable at a glance.
  const egressNotice =
    receiveCount > 0
      ? perspective === "proposing"
        ? `You request ${dataColumns(receiveCount)} from your partner.`
        : `Your partner requests ${dataColumns(receiveCount)} from you.`
      : undefined;
  // A count of the columns the inviter will SEND the acceptor for matched records --
  // inbound partner data the acceptor receives. A count, not names: bounded at
  // decode (MAX_PAYLOAD_ENTRIES) and already sanitized, so no partner free text
  // enters the core. Lands in the acceptor's "what you receive" group. Absent under
  // "proposing": the inviter's own send is shown as chips there instead.
  const sendCount = summary.payload?.send.length ?? 0;
  // Direction-first, and a DECLARATION (definite): summary.payload.send is the
  // disclosed set the exchange transmits for matched records, so the copy states
  // "you will receive", the certain counterpart to the egress line's conditional
  // "requests". Mirrors the "Result sharing" block's "You will receive ..." framing.
  const ingressNotice =
    perspective !== "proposing" && sendCount > 0
      ? `You will receive ${dataColumns(sendCount)} from your partner.`
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
  // The outbound-send slot holds whichever block states what this viewer's own data
  // leaving amounts to: count-only (no payload moves) takes precedence, then a
  // partner receiving no result (nothing is transmitted, gated on
  // partnerReceivesResult -- the viewer-relative split, not either raw summary
  // field, since the two sides read opposite ones), then for the acceptor the
  // actual send list once a file is chosen, else the pre-file forward-reference.
  // The precedence matches the CLI accept prompt's, so the two surfaces resolve an
  // overlapping case the same way.
  //
  // The displayed direction and the run's own gate are the same fact with an
  // aborting check between them: acceptance mirrors the invitation's output
  // direction into this party's terms, and the compatibility check refuses a
  // partner presenting terms that disagree with that mirror.
  const countOnly = summary.algorithm === "psi-c";
  // The set the count-only block takes the slot from: the inviter's declared send
  // under "proposing", the acceptor's own resolved columns otherwise -- the same
  // viewer-relative pair the blocks below render.
  const viewerOutboundSend =
    perspective === "proposing"
      ? (summary.payload?.send ?? [])
      : (outboundColumns ?? []);
  // psi-c admits no payload in either direction; a document or input metadata
  // declaring one is refused where the terms are authored and at the agreed-terms
  // run boundary (docs/spec/PROTOCOL.md, PSI-C). This throw is the render-side
  // safety check behind those refusals: rendering "no data columns in either
  // direction" over a column would take the operator's consent to a disclosure
  // that happens.
  if (countOnly && viewerOutboundSend.length > 0)
    throw new Error(
      "count-only terms carry a non-empty outbound column set: a psi-c " +
        "exchange sends no data column in either direction",
    );
  // The mirror check on what the INVITATION declares: a psi-c document declaring a
  // send or receive asks for the column movement the algorithm refuses, which would
  // contradict the no-payload sentence rendered above. The invitation is
  // partner-controlled, so this side cannot assume the authoring refusal ran --
  // only that its own decode applied the same rule (core's LinkageTermsSchema).
  if (countOnly && (sendCount > 0 || receiveCount > 0))
    throw new Error(
      "count-only terms declare a payload column: a psi-c exchange moves no " +
        "data column in either direction",
    );
  const outboundNoPayloadRenders = !countOnly && !partnerReceivesResult;
  const proposingSendChipsRender =
    perspective === "proposing" && !countOnly && !outboundNoPayloadRenders;
  const outboundSendListRenders =
    perspective !== "proposing" &&
    !countOnly &&
    !outboundNoPayloadRenders &&
    outboundColumns !== undefined;
  const outboundForwardRefRenders =
    perspective === "review" &&
    !countOnly &&
    !outboundNoPayloadRenders &&
    outboundColumns === undefined;
  // Every block that can occupy the outbound-send slot has the same caption, the
  // one naming the viewer's own send: the inviter's declared send under "proposing",
  // the acceptor's own otherwise. The caption follows the VIEWER, never the direction
  // fact, so the slot does not rename itself when the gate above answers it.
  const outboundSendSlotLabel =
    perspective === "proposing"
      ? "Columns sent to your partner"
      : "What you will send to your partner";
  // The "what you disclose" group renders when this viewer discloses anything: its
  // outbound-send slot (which always holds one block under "proposing", and holds one
  // for the acceptor once the gate or a chosen file answers it) and/or the egress
  // request.
  const showsDiscloseGroup =
    countOnly ||
    proposingSendChipsRender ||
    outboundNoPayloadRenders ||
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
  // Tiered by disclosure direction: "What you disclose" (lifted to lead so the
  // acceptor's hardest-to-undo fact is not skimmed past), "What the exchange
  // produces", "What you receive", and "How records are matched" (mechanics kept
  // below the outcome). An attached legal agreement is a cross-cutting governance
  // frame, not a direction, so it has its own tier with a fixed "Legal
  // agreement" aria-label distinct from its lead heading.

  // The fields with a partner-authored allowedCharacters class stay
  // always-visible: a partner-defined character-class constraint applies to a
  // linkage field, so the acceptor must be on notice before consenting rather than
  // finding it dimmed inside the collapsed "Other details" disclosure. The class is
  // already sanitized once in summarizeInvitation, so this filter performs no fresh
  // derivation of partner text -- only a presence selection.
  const constrainedFields = summary.linkageFields.filter(
    (field) => field.allowedCharacters !== undefined,
  );
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
  // (Title aria-describedby -> this id), so a screen reader landing on "Invitation
  // from <name>" hears the not-yet-verified caveat as the heading's description
  // rather than a loose paragraph it may skip.
  const identityNoteId = useId();
  // The visible send-columns captions name their chip list via aria-labelledby, so
  // the accessible name derives from the one visible caption rather than a second,
  // separately-authored aria-label that could drift. Two ids because the inviter's
  // "proposing" send and the acceptor's own outbound send are distinct captions.
  const proposingSendCaptionId = useId();
  const outboundSendCaptionId = useId();
  const reduceMotion = useReducedMotion();
  // Tier captions are headings one level below the terms heading, so a screen reader
  // can jump between tiers by heading and the outline nests under the page's own
  // heading. headingOrder is 1 | 2 | 3, so this is 2 | 3 | 4 (all valid Title
  // orders).
  const tierHeadingOrder = (headingOrder + 1) as 2 | 3 | 4;
  return (
    <Stack gap="xs">
      <Title
        order={headingOrder}
        size="h2"
        ref={headingRef}
        tabIndex={-1}
        // Gated to review: the note (and so its id) renders only there, so pointing
        // at it under "proposing"/"accepted" would dangle at an absent element.
        aria-describedby={perspective === "review" ? identityNoteId : undefined}
      >
        {framing?.heading ??
          (perspective === "proposing"
            ? "Exchange proposal"
            : `Invitation from ${summary.invitingParty}`)}
      </Title>
      {/* summary.invitingParty is a free-text field the sender typed, accepted on a
          transcription checksum -- psilink has not authenticated it. This is a
          small honesty marker on that self-asserted field, not a directive to
          reassess trust. Review-only: it is a pre-consent decision-point marker, so
          it drops off the during-run "accepted" view once consent is committed --
          not because the name becomes verified there (the run's key exchange
          authenticates that the peer holds the invitation secret, never that the
          name is true). Associated with the heading via aria-describedby
          (identityNoteId); pinned by render tests. */}
      {perspective === "review" && (
        <Text id={identityNoteId} size="sm" fw={500}>
          {CONSENT_FACTS.invitingParty.note}
        </Text>
      )}
      <Text size="sm" c="dimmed">
        {framing?.intro ??
          (perspective === "proposing"
            ? "Your partner must review and consent to these details before any data is exchanged."
            : perspective === "accepted"
              ? "These are the exchange details."
              : "These are the details your partner proposes for linking your records.")}
      </Text>

      {/* Direction tier -- WHAT YOU DISCLOSE: the viewer's own data leaving. Led
          ahead of the other direction tiers because it is the acceptor's
          hardest-to-undo fact and must not be skimmed past before consent. Rendered
          only when this viewer discloses something. */}
      {showsDiscloseGroup && (
        <TermsTier heading="What you disclose" headingOrder={tierHeadingOrder}>
          {/* The inviter's own send, shown as chips. Only the "proposing" preview
              shows it here; the acceptor's send renders below. Driven by
              summary.payload.send (already sanitized). An eager, definite
              declaration under "proposing", so an empty set is treated as a positive
              "no columns" confirmation rather than an unknown. */}
          {proposingSendChipsRender && (
            <Term
              label={outboundSendSlotLabel}
              captionId={proposingSendCaptionId}
            >
              {summary.payload !== undefined &&
              summary.payload.send.length > 0 ? (
                <>
                  <OutboundSendCount count={summary.payload.send.length} />
                  <ColumnChips
                    columns={summary.payload.send}
                    labelledBy={proposingSendCaptionId}
                  />
                </>
              ) : (
                <Text size="sm" c="dimmed">
                  No columns are sent to your partner; your file is used only to
                  find matches.
                </Text>
              )}
            </Term>
          )}

          {/* A count-only run moves no data column in either direction, so this slot
              states the algorithm as the reason rather than the entitlement the
              block below reads -- under psi-c the partner may well receive the
              count, and a sentence reasoning from receipt would be answering a
              different question. Read from `@psilink/core` like every other block
              in this slot; fixed first-party copy, naming no column. */}
          {countOnly && (
            <Term label={outboundSendSlotLabel}>
              <Text size="sm">{CONSENT_FACTS.countOnlyNoPayload.note}</Text>
            </Term>
          )}

          {/* This viewer's partner receives no result, so the payload step sends
              nothing whatever the operator's file holds -- the case that takes the
              slot ahead of every other block in it (see the precedence above).
              Rendered at normal weight, not dimmed: it sits beside the egress
              request, which must never read more prominently than what actually
              leaves. Read from `@psilink/core`, one copy for every surface. */}
          {outboundNoPayloadRenders && (
            <Term label={outboundSendSlotLabel}>
              <Text size="sm">{OUTBOUND_SEND_NO_PAYLOAD_SENTENCE}</Text>
            </Term>
          )}

          {/* The acceptor's OWN outbound disclosure once a file is chosen (its live
              metadata disclosure). */}
          {outboundSendListRenders && (
            <Term
              label={outboundSendSlotLabel}
              captionId={outboundSendCaptionId}
            >
              {outboundColumns.length > 0 ? (
                <>
                  {/* Counted off the same array the chips below render, so the two
                      cannot disagree, and as a plain length -- none of the operator's
                      header text enters the sentence. */}
                  <OutboundSendCount count={outboundColumns.length} />
                  {/* These are the operator's OWN CSV headers (from the live
                      metadata disclosure), not a sanitized summary value, so
                      sanitize them for display like every other column-name surface
                      (ColumnChips renders verbatim) -- a header containing
                      bidi/zero-width/homoglyph characters must not misrepresent to
                      the operator what leaves their machine. */}
                  <ColumnChips
                    columns={outboundColumns.map((name) =>
                      sanitizeForDisplay(name),
                    )}
                    labelledBy={outboundSendCaptionId}
                  />
                </>
              ) : (
                <Text size="sm" c="dimmed">
                  No columns are sent to your partner; only the linkage result
                  (which of your rows matched) is produced.
                </Text>
              )}
            </Term>
          )}

          {/* The review-screen forward-reference to the outbound disclosure,
              occupying the slot the actual send list takes once a file is chosen.
              Before a file is chosen outboundColumns is undefined, so the block
              above cannot render, yet this is the acceptor's highest-stakes payload
              fact and the consent checkbox sits on this screen. Rendered at normal
              weight, NOT dimmed: it must read at least as prominently as the egress
              request below. */}
          {outboundForwardRefRenders && (
            <Term label={outboundSendSlotLabel}>
              <Text size="sm">
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
        </TermsTier>
      )}

      {/* Direction tier -- WHAT THE EXCHANGE PRODUCES: the matching method (what the
          result reveals), result sharing (who receives it), and what a retain-mode
          transcript leaves behind. Matching mechanics (linkage strategy, matching
          keys) are split into their own "How records are matched" tier below, so
          this group answers only "what does the exchange reveal, and to whom". */}
      <TermsTier
        heading="What the exchange produces"
        headingOrder={tierHeadingOrder}
      >
        <Term label="Matching method">
          <Text size="sm">
            {summary.algorithm === "psi-c" ? (
              COUNT_ONLY_DISCLOSURE_STATEMENT
            ) : (
              <>
                The shared identifiers of records you have in common are
                revealed to whoever receives the result.{" "}
                <strong>PII is not directly revealed.</strong>
              </>
            )}
          </Text>
          {/* The count-only headline states a disclosure guarantee, so by the
              caveat-placement rule the caveats sit beside it rather than one expand
              down: what the enforced half covers, what the rounds disclose past the
              count, and the bound a partner's choice of input puts on all of it.
              Read from the shared table with its basis. */}
          {countOnly && (
            <>
              <Text size="xs" c="dimmed">
                {CONSENT_FACTS.countOnlyResult.note}
              </Text>
              <Text size="xs" c="dimmed">
                {CONSENT_FACTS.countOnlyRoundDisclosures.note}
              </Text>
              <Text size="xs" c="dimmed">
                {CONSENT_FACTS.countOnlyInputChoice.note}
              </Text>
            </>
          )}
        </Term>

        {/* Result sharing, stated viewer-relative so each party reads its own
            outcome first-person. The two lines are NOT equally enforced: the
            viewer's own receipt is enforced (a party set to receive none is sent
            none, and its receive check fails closed on any it is sent), while the
            partner's is COOPERATIVE, resting on the agreed terms rather than a
            guarantee this side can impose (docs/notes/one-sided-disclosure.md).
            Each "No" states the caveat for its register. */}
        <Term label="Result sharing">
          <Text size="sm">
            You will receive the matched result: {yesNo(viewerReceivesResult)}
          </Text>
          {!viewerReceivesResult && (
            <Text size="xs" c="dimmed">
              {CONSENT_FACTS.viewerReceivesNoResult.note}
            </Text>
          )}
          <Text size="sm">
            {partnerReceiptLabel}: {yesNo(partnerReceivesResult)}
          </Text>
          {/* Where a count-only run entitles BOTH parties, only one computes the
              count and the other is sent that party's report, so one side's "Yes"
              above is a number psilink did not check. Where exactly one party is
              entitled, that party computes its own count, so no report exists to
              caveat. */}
          {countOnly && viewerReceivesResult && partnerReceivesResult && (
            <Text size="xs" c="dimmed">
              {CONSENT_FACTS.countOnlyReportedCount.note}
            </Text>
          )}
          {partnerReceivesResult ? (
            // The partner DOES receive: the accountable disclosure (the 164.528
            // event). A "Yes" has no false-guarantee risk, so it stays a plain
            // disclosure, but a brief pointer marks that once the result is out, the
            // agreement -- not this tool -- governs its use, mirroring the cooperative
            // caveat's "the tool is not the control here" frame.
            <Text size="xs" c="dimmed">
              {CONSENT_FACTS.partnerReceivesResult.note}
            </Text>
          ) : (
            <>
              <Text size="xs" c="dimmed">
                {CONSENT_FACTS.partnerReceivesNoResult.note}
              </Text>
              {/* The honest-helper membership disclosure, kept DISTINCT from the
                  cooperative caveat above: this states what an HONEST partner learns
                  intrinsically. A non-receiving partner in a `psi` exchange learns
                  which of ITS OWN records are in the viewer's data -- membership --
                  under both linkage strategies (docs/notes/one-sided-disclosure.md).
                  Bounded so it cannot overstate: never which of the viewer's records
                  they matched, nor anything about the rest of the set beyond its
                  size. Not disclosed under `psi-c`, whose non-receiving party is the
                  sender and learns no membership. */}
              {summary.algorithm !== "psi-c" && (
                <Text size="xs" c="dimmed">
                  {CONSENT_FACTS.partnerLearnsOwnMembership.note}
                </Text>
              )}
            </>
          )}
        </Term>

        {/* What the run LEAVES BEHIND: under retain mode nothing is deleted and the
            rendezvous location becomes a permanent transcript. Always-visible since
            it is the one fact here that outlives the run. Rendered wherever the
            invitation discloses the mode -- declared, or entailed by a
            split-directory endpoint -- and nothing where it discloses neither: a
            declared delete mode and no declaration render alike, since neither is a
            cleanup this transport promises (`CONSENT_FACTS.retainedFiles` states
            why). */}
        {summary.disclosesRetainedFiles && (
          <Term label="Exchange files">
            <Text size="sm">
              Kept as a permanent transcript, not deleted after the run.
            </Text>
            <Text size="xs" c="dimmed">
              {CONSENT_FACTS.retainedFiles.note}
            </Text>
          </Term>
        )}
      </TermsTier>

      <CondensableDetails condensed={condensed}>
        {/* Direction tier -- WHAT YOU RECEIVE: partner data arriving to this viewer.
          The acceptor's ingress (a count of the columns the invitation will send it
          for matched records) -- the weaker signal, since receiving is not a
          disclosure BY the acceptor -- or, mirrored, the inviter's own request of its
          partner under "proposing" (that request is the inviter's inbound). Rendered
          only when this viewer receives partner data. */}
        {showsReceiveGroup && (
          <TermsTier heading="What you receive" headingOrder={tierHeadingOrder}>
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
          </TermsTier>
        )}

        {/* Tier -- HOW RECORDS ARE MATCHED: match mechanics, split out of "What the
          exchange produces" and placed below the disclosure/result tiers since it is
          verification detail the diligent open, not the headline the consent
          decision turns on. Always rendered, since there is always at least one
          linkage key. */}
        <TermsTier
          heading="How records are matched"
          headingOrder={tierHeadingOrder}
        >
          {/* Single-pass is disclosure-affecting AND a mandatory-consistency term the
            acceptor adopts, so it must be visible at the consent point. Shown only
            for single-pass (cascade is the baseline that discloses less).
            Viewer-neutral, since which party becomes the disclosing sender is
            settled at exchange time. Mirrors the inviter's Alert and the CLI's
            singlePassDisclosureNotice. */}
          {summary.linkageStrategy === "single-pass" && (
            // No emphasis tag on the lead: the Term's bold "Linkage strategy"
            // caption already anchors the block, so a second bold restating it would
            // double up for screen readers and visual scanning alike.
            <Term label="Linkage strategy">
              <Text size="sm">
                This exchange matches in a single pass. That means one of you
                sends the other everything it prepared for every linkage key at
                once, so that party also sees matches on the weaker keys, not
                only the strongest. Which of you sends is decided when the
                exchange runs, so it may be you. Both parties must agree to
                single-pass. The matched result is the same either way; what
                differs is how much your partner can observe while it runs.
              </Text>
            </Term>
          )}

          {/* Value-level matching multiplicity, beside the strategy it is coupled
            to: a key element that splits its value is matched on each candidate.
            Copy is read from CONSENT_FACTS, so this surface and the CLI accept
            prompt state the consequence in the same words. Rendered from the
            element transforms the invitation declares; the inviter's own data
            standardization can fan out a field no invitation shows, so this claims
            nothing about the whole of what the inviter runs. */}
          {summary.fansOut && (
            <Term label="Several values per record">
              <Text size="sm">
                {summary.fanOutApplied
                  ? CONSENT_FACTS.fanOutCandidates.note
                  : CONSENT_FACTS.fanOutRefused.note}
              </Text>
            </Term>
          )}

          {/* The rules' citation renders above the matching list it cites: a reader
            meets the name before the enumeration it stands for. Both names and
            versions are partner-controlled, sanitized by summarizeInvitation and
            bound in their own Text between fixed chrome -- never joined into the
            label -- so a crafted value cannot display as system chrome. Each half
            renders through core's `ruleSetCitation`, the same grammar the CLI
            accept prompt and core's own mismatch message use, and runs after
            summarizeInvitation's escape (which truncates and redacts) since either
            order risks the closing delimiter.

            Each half's label states this build's own verdict, from the same
            shared table the caveats come from. One caveat per DISTINCT verdict the
            two halves reached follows the pair, most severe first. The `unchecked`
            and `consistent` caveats attribute the citation to a partner, so they
            are gated to `review`; the `contradicted` caveat is not gated, being
            this build's own finding about the document on screen rather than an
            attribution to anyone. Which sentence a perspective gets is core's call
            (`linkageRuleSetVerdictNote`). */}
          {summary.linkageRuleSet !== undefined && (
            <Term label="Linkage rule set">
              <Stack gap={2}>
                <Text size="sm">
                  Keys (
                  {
                    LINKAGE_RULE_SET_VERDICT_COPY[
                      summary.linkageRuleSet.keySet.verdict
                    ].marker
                  }
                  ):
                </Text>
                <Text size="sm" ff="monospace" style={ruleSetValueStyle}>
                  {ruleSetCitation(
                    summary.linkageRuleSet.keySet.name,
                    summary.linkageRuleSet.keySet.version,
                  )}
                </Text>
                <Text size="sm">
                  Fields (
                  {
                    LINKAGE_RULE_SET_VERDICT_COPY[
                      summary.linkageRuleSet.fieldSet.verdict
                    ].marker
                  }
                  ):
                </Text>
                <Text size="sm" ff="monospace" style={ruleSetValueStyle}>
                  {ruleSetCitation(
                    summary.linkageRuleSet.fieldSet.name,
                    summary.linkageRuleSet.fieldSet.version,
                  )}
                </Text>
              </Stack>
              {distinctLinkageRuleSetVerdicts(
                summary.linkageRuleSet.keySet.verdict,
                summary.linkageRuleSet.fieldSet.verdict,
              )
                .filter(
                  (verdict) =>
                    verdict === "contradicted" || perspective === "review",
                )
                .map((verdict) => (
                  <Text
                    key={verdict}
                    size="sm"
                    fw={verdict === "contradicted" ? 500 : undefined}
                  >
                    {linkageRuleSetVerdictNote(
                      verdict,
                      perspective === "proposing"
                        ? "citing-party"
                        : "recipient",
                    )}
                  </Text>
                ))}
            </Term>
          )}

          {/* The matching list as a default-collapsed disclosure, mirroring the
            per-key and "Other details" disclosures: aria-expanded/aria-controls on
            the toggle, the id on the always-mounted wrapper (not the Collapse
            panel) so it stays a stable target, and the per-key list hidden from
            assistive tech and the tab order while closed. The toggle text doubles
            as the list's group label. */}
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
                    transition: reduceMotion
                      ? undefined
                      : "transform 150ms ease",
                  }}
                />
                <Text size="sm" fw={600} id={matchedOnLabelId}>
                  Matching strategies
                </Text>
              </Group>
            </UnstyledButton>
            {/* The always-visible field summary: WHICH fields the keys match on,
              kept outside the collapse so the single fact consent most depends on
              is clear without expanding the detail. The compact field labels and
              the deduped order are derived (and sanitized) by summarizeInvitation;
              the per-key grouping and breadth markers stay one expand down. */}
            {summary.matchedFields.length > 0 && (
              <Text id={matchingSublineId} size="sm">
                Matching on {summary.matchedFields.join(", ")}.
              </Text>
            )}
            {/* A labelled list of per-key disclosures. role=list/listitem (not
              Mantine List.Item, whose inline span body cannot hold the disclosure's
              flow content) so AT announces the set; keyed by each key's stable id
              (InvitationKeySummary.id) rather than array index, so a key's own
              expanded/collapsed state follows the key when the inviter reorders the
              list. */}
            <div id={matchingPanelId}>
              <Collapse expanded={matchingOpen}>
                <Stack gap="xs" role="list" aria-labelledby={matchedOnLabelId}>
                  {summary.linkageKeys.map((key) => (
                    <MatchKeyDisclosure key={key.id} summary={key} />
                  ))}
                </Stack>
              </Collapse>
            </div>
          </Stack>
        </TermsTier>

        {/* Partner-authored allowed-character constraints, promoted to the
          always-visible core so a partner-defined character-class rule is on notice
          at the consent point, not dimmed inside "Other details". Each entry names
          the field, a FIXED system label marking the class as partner-supplied and
          unverified, then the raw sanitized class in its OWN bounded Text -- never
          joined into one sentence, since a crafted value could impersonate system
          chrome. Advisory (core's `withinAllowedCharacters` warns, does not
          enforce), so the copy states an expectation, not a guarantee. */}
        {constrainedFields.length > 0 && (
          <TermsTier
            heading="Partner-defined character constraints"
            headingOrder={tierHeadingOrder}
          >
            <Text size="sm">{CONSENT_FACTS.allowedCharacterPatterns.note}</Text>
            <Stack gap="xs">
              {/* Keyed by index: the fields are already deduped and their order is
                  fixed for a given terms document, and the sanitized label is not
                  unique across fields of one type. */}
              {constrainedFields.map((field, index) => (
                <Stack key={index} gap={2}>
                  <Text size="sm" fw={500}>
                    {field.label}
                  </Text>
                  {/* The fixed system label as static JSX, then the raw class in
                      its own bounded Text between core-derived chrome -- mirroring
                      the coercion-note pattern -- so partner text cannot display as
                      the label. field.allowedCharacters is present here (the filter
                      above selects on it), sanitized once in summarizeInvitation. */}
                  <Text size="sm">
                    Allowed characters (partner-supplied, unverified):
                  </Text>
                  <Text
                    size="sm"
                    ff="monospace"
                    style={{
                      border: "1px solid var(--mantine-color-default-border)",
                      borderRadius: "var(--mantine-radius-sm)",
                      padding: "2px 6px",
                      wordBreak: "break-all",
                    }}
                  >
                    {field.allowedCharacters}
                  </Text>
                </Stack>
              ))}
            </Stack>
          </TermsTier>
        )}

        {/* The legal agreement is a cross-cutting GOVERNANCE frame, not a disclosure
          direction, so it has its own labelled group, placed last: it frames the
          decision rather than leading ahead of what the acceptor actually
          discloses. Its purpose is the field a 45 CFR 164.528 / FERPA exception
          turns on (docs/COMPLIANCE.md), so it is shown whole -- reference,
          purpose, and expiry -- with no "Other details" entry. Pre-sanitized by
          summarizeInvitation. */}
        {summary.legalAgreement !== undefined && (
          <TermsTier
            heading="This invitation attaches a legal agreement."
            headingOrder={tierHeadingOrder}
            accessibleName="Legal agreement"
          >
            {/* The agreement's three fields display as one block, tighter than the
                spacing between a tier's heading and its content. */}
            <Stack gap={2}>
              <Text size="sm">
                Reference: {summary.legalAgreement.reference}
              </Text>
              {/* "Stated purpose", not "Purpose": the value is partner-authored free
                text, sanitized but never vetted by psilink (only byte-compared
                against the partner's own copy at exchange time), so the label marks
                it as partner-attested rather than an authorization psilink endorses
                -- the same provenance-marking the allowed-character constraint
                uses. */}
              <Text size="sm">
                Stated purpose: {summary.legalAgreement.purpose}
              </Text>
              {/* Name the subject ("Agreement valid through ...") rather than a bare
                "Valid through <date>": it sits on the same screen as the separate
                invitation-expiry line below, and at a glance the two same-weight
                dates are otherwise easy to conflate. */}
              <Text size="xs" c="dimmed">
                Agreement valid through {summary.legalAgreement.expirationDate}
              </Text>
            </Stack>
          </TermsTier>
        )}

        {/* The toggle has aria-expanded and aria-controls; while closed Mantine's
          Collapse hides the panel from assistive tech and the tab order.
          aria-controls points at the stable wrapper below, not the Collapse panel,
          so the reference resolves to a present element however Mantine mounts or
          hides the panel across motion preferences. A render test pins this against
          the accessibility tree.

          Self-describing: aria-describedby points at the one-line contents summary
          below (detailsSummaryId). Other details always holds the personal-data
          and duplicate-match blocks, so the summary always renders and the
          reference never dangles. */}
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
                        {/* Each constraint as its own item. These are fixed
                        plain-language phrases (validity, affix removal, a count
                        of excluded values) containing no partner free text; the
                        partner-authored allowedCharacters class is shown apart,
                        in the always-visible constraints group above. Keyed by
                        index -- order is fixed for a field. */}
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
                    inviter's own send is shown as chips above "Other details"
                    instead, so it is suppressed here under "proposing". */}
                  {/* Shown whenever the send set is a definite declaration --
                    including the empty set, rendered "(none)" so the strict
                    "receive nothing" commitment is visible rather than inferred from
                    a missing line. A lazy (undeclared) send is omitted instead. */}
                  {summary.payload.sendDeclared &&
                    perspective !== "proposing" && (
                      <Stack gap={2}>
                        <Text size="sm">Your partner will send:</Text>
                        {summary.payload.send.length > 0 ? (
                          <DeclaredColumnList columns={summary.payload.send} />
                        ) : (
                          <Text size="sm" c="dimmed">
                            (none)
                          </Text>
                        )}
                      </Stack>
                    )}
                  {/* Mirror of the send block: a declared receive is shown even
                      when empty, rendered "(none)" so the strict "the acceptor
                      sends nothing" assertion is visible rather than inferred from
                      a missing line. A lazy (undeclared) receive is omitted, so the
                      "(none)" is the inviter asking for no column rather than asking
                      for none in particular. */}
                  {summary.payload.receiveDeclared && (
                    <Stack gap={2}>
                      <Text size="sm">
                        {perspective === "proposing"
                          ? "You request from your partner:"
                          : "Your partner requests from you:"}
                      </Text>
                      {summary.payload.receive.length > 0 ? (
                        <DeclaredColumnList columns={summary.payload.receive} />
                      ) : (
                        <Text size="sm" c="dimmed">
                          (none)
                        </Text>
                      )}
                    </Stack>
                  )}
                </Term>
              )}

              <Term label="Duplicate matches">
                <Text size="sm">
                  {summary.deduplicate
                    ? "More than one of the inviting party's records may match a single one of the accepting party's records."
                    : "Each of the inviting party's records matches at most one of the accepting party's records."}
                </Text>
                {/* What a deduplicating match reveals, and whose records are
                grouped to reveal it -- the inviting party's alone, since
                acceptance derives the accepting party's own side as false
                (deriveAcceptedLinkageTerms). Shared wording with the CLI accept
                prompt; WHICH statement renders follows the output shape: grouping
                where the inviting party shares the result, none where it is the
                sole receiver. Rendered for exactly a deduplicating invitation the
                run applies -- a strategy that cannot deduplicate is refused at
                acceptance (assertDeduplicateImplemented). */}
                {summary.deduplicate && summary.deduplicateApplied && (
                  <>
                    <Text size="xs" c="dimmed">
                      {summary.inviterSharesResult
                        ? DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT
                        : DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT}
                    </Text>
                    {/* The sole-receiver statement states the withholding this
                    client makes; what the rounds still disclose to the accepting
                    party's own process is the fact beside it, read from the shared
                    table. Only that shape needs it: where the inviting party shares
                    the result, the accepting party is presented the grouping and
                    there is no display limit to qualify. */}
                    {!summary.inviterSharesResult && (
                      <Text size="xs" c="dimmed">
                        {CONSENT_FACTS.duplicateGroupingDisplayLimit.note}
                      </Text>
                    )}
                    <Text size="xs" c="dimmed">
                      {DEDUPLICATE_ACCEPTOR_SIDE_NOTE}
                    </Text>
                  </>
                )}
              </Term>
            </Stack>
          </Collapse>
        </div>

        {summary.expires !== undefined && (
          <Text size="xs" c="dimmed">
            {/* Label the time zone: the expiry is one instant, but inviter and
              acceptor may be in different zones, so a bare local wall-clock time
              would display as a different deadline on each end. */}
            This invitation expires{" "}
            {new Date(summary.expires).toLocaleString(undefined, {
              timeZoneName: "short",
            })}
          </Text>
        )}
      </CondensableDetails>
    </Stack>
  );
}
