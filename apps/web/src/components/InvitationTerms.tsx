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
 * aria-labelledby rather than carrying a second, separately-authored aria-label that
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
 * one component -- the direction tiers, the mechanics tier, the partner-constraint
 * tier, and the legal-agreement governance frame -- so their grouping, heading level,
 * and accessible-name wiring cannot diverge tier by tier, and a tier added later gets
 * the same announcement without re-deriving it.
 *
 * The group is named by its own visible heading via aria-labelledby, so its
 * accessible name has a single source and cannot drift from the caption a sighted
 * reader sees. `accessibleName` replaces that with a fixed aria-label, for a tier
 * whose visible heading is a full sentence rather than a name: a screen reader would
 * otherwise announce the whole sentence as the group's name and then read it again as
 * the heading.
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
 * chips so a reader takes in how much leaves before reading which columns do. It
 * renders only where the set is both known and non-empty -- an empty set and a
 * not-yet-chosen file each state their own case in this slot instead -- so the
 * sentence never asserts a definite send that does not happen. Renders undimmed
 * (no `c="dimmed"`), unlike the empty-set fallback text that occupies this same
 * slot when the set is empty.
 */
function OutboundSendCount({ count }: { count: number }) {
  return (
    <Text size="sm">You will send {dataColumns(count)} to your partner.</Text>
  );
}

/**
 * One of the invitation's declared payload directions as a list of column names,
 * bounded by count: at most {@link MAX_DECLARED_NAMES_SHOWN} names are painted and
 * the remainder is counted in the shared closing line; the bound's rationale lives
 * with that constant.
 *
 * Keyed by index: column order is fixed for a decoded invitation and a sanitized name
 * is not unique. One column per item rather than a joined string -- a
 * partner-controlled name may contain the separator, which joined text would render
 * as spurious extra columns.
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
                    for a function core does not recognize -- the shared note
                    saying so. All are fixed/sanitized copy, not raw partner free
                    text; the note is the CLI accept prompt's own wording, read
                    from core so the two consent surfaces cannot drift on what an
                    unexplained rule is called. */}
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
 * Wraps the terms panel's lower reference tiers (what you receive, how records are
 * matched, the legal agreement, and "Other details") in one default-collapsed
 * disclosure when {@link condensed}; otherwise renders them inline unchanged.
 * condensed is set on surfaces that show the terms as post-consent or authored
 * REFERENCE, so the panel stays short.
 * It is NEVER set on the acceptor's pre-consent "review" screen, the one place
 * informed consent is captured, which keeps every tier always-visible. So even though
 * this can fold a tier, it never hides one from the party at the consent decision
 * point. The always-mounted wrapper carrying aria-controls and the
 * self-describing describedby summary mirror the "Other details" idiom, so a folded
 * tier stays out of the accessibility tree and tab order while collapsed yet remains
 * reachable and announced.
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
 * Renders the inviter's linkage terms decoded from an invitation for review. The
 * always-visible core is organized by disclosure DIRECTION and ordered by how much
 * the consent decision turns on it, into labelled tiers ("What you disclose", "What
 * the exchange produces", "What you receive", "How records are matched", then the
 * legal agreement), with the dense remainder behind a single default-collapsed
 * "Other details" disclosure; each tier's own inline comment carries its rationale.
 * Every one of them renders through {@link TermsTier}, so the grouping, heading
 * level, and accessible name a tier is announced with are authored once rather than
 * per tier.
 *
 * Every sentence qualifying a setting's headline follows ONE placement rule, so the
 * flagging is uniform rather than decided per setting: it renders at the SAME
 * visibility level as the headline it qualifies, never one expand down, so a reader
 * can never see a headline setting as in force while what qualifies it is hidden.
 * Which level that is follows the HEADLINE's disclosure weight. The per-element
 * fuzzy comparison is proposed but not applied, and deduplicate is applied at a
 * disclosure cost; both are settings whose headline changes match
 * multiplicity/breadth rather than stating a disclosure guarantee, so those
 * headlines sit in a disclosure rather than the core (deduplicate in "Other
 * details", fuzzy in each key's detail, itself behind the matching disclosure) and
 * their qualifying sentences sit with them, co-hidden. A HEADLINE stating what is
 * disclosed would have to sit always-visible in the core instead, which is where
 * the count-only tier below sits. What each sentence SAYS is fixed copy read from
 * `PROPOSED_NOT_APPLIED_NOTES`, the two deduplicate disclosure statements, and
 * `DEDUPLICATE_ACCEPTOR_SIDE_NOTE` in `@psilink/core`, which the CLI accept
 * prompt renders too, so no partner text enters one and neither surface can
 * restate it. Deduplicate takes two of them: what the setting discloses -- in the
 * shared-result wording where the invitation shares the result, and the
 * sole-receiver wording where the inviting party alone receives it -- and whose
 * records are grouped to disclose it, the inviting party's alone, since
 * acceptance derives the accepting party's own side as false. Render tests pin
 * each at its headline's level against the accessibility tree.
 *
 * The same placement rule governs the count-only facts: what the run itself holds,
 * what its rounds disclose beside the count, and the bound a partner's choice of
 * input puts on both are always-visible with the matching-method headline, the
 * reported-count caveat sits with result sharing, and the no-payload sentence takes
 * the outbound-send slot ahead of every entitlement-driven block there. Every
 * sentence, and the enforced-versus-partner basis behind it, is read from
 * `COUNT_ONLY_DISCLOSURE_STATEMENT` and `CONSENT_FACTS` in `@psilink/core`, which the
 * CLI accept prompt reads too, so the two surfaces cannot state different outcomes
 * for one invitation.
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
 * disclose" rather than as an ingress line. Whichever side is reading, that
 * outbound-send slot is gated on the VIEWER's partner receiving a result -- the
 * payload step transmits nothing at all to a partner not entitled to one, so a
 * column list there would name a disclosure that does not happen -- and the two
 * sides resolve that one fact from opposite `output` fields.
 *
 * Every payload direction therefore states its magnitude as a count in the core, in
 * the one phrasing `dataColumns` builds. The outbound-send slot is the one that also
 * names its columns, so there the count LEADS the chips ({@link OutboundSendCount}):
 * the disclosure that turns hardest on how much leaves is the one a reader must not
 * have to total up from a row of chips. It renders only over a known, non-empty set
 * -- an empty send and a not-yet-chosen file each state their own case in that slot
 * -- so no count line asserts a send the exchange does not make.
 *
 * An attached legal agreement is promoted
 * in full -- its reference, PURPOSE, and expiry render in the core (not a bare flag),
 * because the purpose is the compliance-pivotal field a 45 CFR 164.528 accounting
 * and FERPA's studies / audit-evaluation exceptions turn on (docs/COMPLIANCE.md) and
 * so must be legible at the consent point; the promoted block IS the whole of the
 * agreement, which then has no separate "Other details" entry.
 *
 * Result sharing's two lines are NOT equally enforced, and the copy marks the
 * difference so a cooperative withholding is not read as a cryptographic guarantee.
 * Which register each falls in, and the sentence that says so, are read from
 * `CONSENT_FACTS` in `@psilink/core` -- the same table the CLI accept prompt reads,
 * so the two acceptance surfaces cannot classify one fact two ways or word its
 * caveat differently. The viewer's OWN non-receipt is enforced -- a party set to
 * receive no result is sent none and its receive check fails closed on any it is
 * sent -- so a "No" there
 * is a hard fact. The PARTNER's non-receipt is COOPERATIVE: keeping the result from
 * the partner rests on the agreed terms being honored, not on a guarantee this side
 * can impose (a documented property of one-sided PSI, docs/notes/one-sided-
 * disclosure.md). Each "No" carries the caveat for its register. The partner's "No"
 * additionally carries the honest-helper disclosure: even a fully honest partner
 * that helps compute the match learns which of ITS OWN records are in the viewer's
 * data (membership) -- distinct from, and deliberately not conflated with, the
 * cooperative caveat about a dishonest partner keeping the result table. It is
 * stated as an accepted, documented property -- a non-receiving partner learns its
 * own membership in a one-sided `psi` exchange under either linkage strategy:
 * intrinsically under the cascade, and under single-pass because the receiver
 * currently returns it its matched rows (which it needs whenever it discloses
 * payload for the overlap, and which are returned even when it does not, pending the
 * hardening task in docs/notes/one-sided-disclosure.md) -- bounded so it does not
 * overstate: the helper learns membership of its own records, never which of the
 * viewer's records they matched, nor anything about the rest of the set beyond its
 * size. It is scoped by the ALGORITHM rather than by the strategy, and so is
 * withheld for a `psi-c` invitation: the role rule puts the non-receiving party of a
 * count-only round in the sender seat, which computes nothing from the round and is
 * sent no count-report frame (docs/spec/PROTOCOL.md, PSI-C), so it learns no
 * membership to state -- what such a round does disclose is the count-only tier's.
 * The viewer's own "Yes" is left unqualified; the partner's "Yes" -- the
 * accountable disclosure of the result to them -- carries a brief pointer that the
 * agreement, not this tool, governs its use once the result is out.
 *
 * `perspective` selects the heading and intro copy for the three contexts this
 * renders in -- the acceptor `review`ing a partner's proposal (pre-consent), the
 * acceptor viewing the terms it has `accepted` (during the run, so the copy is
 * past-tense rather than "proposes"), and the inviter looking at the terms it is
 * `proposing` (its own identity, so it is not labelled "Invitation from <self>")
 * -- plus the viewer-centric blocks whose framing depends on who is reading: Result
 * sharing and the payload send/receive copy read first-person for each party, so the
 * direction tiers place each fact by the viewer's own direction. The matching keys
 * and the rest of the body are identical across all three, save the two caveats a
 * partner's own word carries -- the unverified-identity note and the rule-set
 * citation's attribution sentence -- which are `review`-only. The optional `framing`
 * override replaces ONLY the heading and intro strings (for the console direct
 * exchange, which pairs it with `proposing` to render the operator's own inferred
 * terms honestly, with no false partner-consent claim); it leaves every
 * perspective-driven block untouched, so an invitation/accept caller that omits it
 * renders exactly as before. `headingOrder` sets only
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
  /** The invitation's expiry instant (ISO 8601), if it carries one. */
  expires?: string;
  /** The columns the invitation declared the inviter will send (its
   * `disclosedPayloadColumns`). When present, the "your partner will send" line
   * derives from it -- the wire's own disclosure predicate -- rather than the
   * authored `payload.send`; absent for the inviter's pre-mint "proposing"
   * preview and older tokens, which fall back to `payload.send`. */
  disclosedPayloadColumns?: Array<string>;
  /** The invitation's retain-mode declaration (its `inviterRetainsFiles`): the
   * inviter stating that its exchange keeps every file it writes rather than
   * deleting each one once it has been read. Rendered as a consent fact under
   * "What the exchange produces"; nothing is rendered when it is false or absent,
   * neither of which is a claim that files are cleaned up. Passed by the acceptor
   * screen from the decoded token; omitted by the inviter's own preview, whose
   * mode is its own choice rather than a partner's disclosure. */
  inviterRetainsFiles?: boolean;
  /** The invitation's credential-free connection endpoint, passed by the acceptor
   * screen from the decoded token. Read for its SHAPE alone: an endpoint carrying
   * the split inbound/outbound directory pair requires retain mode of any
   * connection built from it, so it states the retention above even where the
   * token declares nothing -- otherwise a party seeded into retain mode from the
   * endpoint would consent to a permanent transcript with nothing said. Nothing
   * else here reads it, and the inviter's own preview omits it. */
  connectionEndpoint?: ConnectionEndpoint;
  /** This viewer's OWN outbound disclosure: the columns it will send to its
   * partner for matched records. Distinct from {@link disclosedPayloadColumns}
   * (what the INVITER sends). Rendered as a count and then chips in the
   * always-visible core, just above "Other details" -- the same slot the inviter's
   * "proposing" send block uses -- so the disclosure sits with the agreed terms
   * rather than after the whole panel. The acceptor passes its live metadata
   * disclosure here; the inviter does not (its own send already renders from
   * `payload.send` under "proposing").
   * `[]` renders the explicit "no columns are sent" line; undefined renders no send
   * list because the set is not yet known -- e.g. the review screen before a file is
   * chosen, where the `review` perspective instead surfaces a fixed-copy
   * forward-reference that the acceptor confirms its exact send after choosing a
   * file. Neither value reaches the screen when the invitation gives the inviting
   * party no result: the payload step transmits nothing at all to a partner not
   * entitled to one, so the block states that instead of any column set. */
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
   * own heading (the bench review step), h2 below the acceptor page's h1, h3
   * below the inviter section's h2. */
  headingOrder?: 1 | 2 | 3;
  // tabIndex + ref so a screen the terms lead can move focus here when they
  // appear, announcing them to assistive tech.
  headingRef?: Ref<HTMLHeadingElement>;
  /** Fold the lower reference tiers (what you receive, how records are matched, the
   * legal agreement, and "Other details") into one default-collapsed disclosure,
   * keeping only "What you disclose" and "What the exchange produces" always visible.
   * Set on surfaces that show the terms as post-consent or authored
   * REFERENCE. NEVER set on the acceptor's
   * pre-consent "review" screen, whose every tier must stay always-visible for
   * informed consent. See {@link CondensableDetails}. */
  condensed?: boolean;
  /** A direct-exchange framing override: replaces ONLY the perspective-derived
   * heading and intro copy with wording honest for a no-invitation direct exchange
   * (the operator's own inferred terms, no partner review/consent). Passed only by
   * the console direct flow, which pairs it with `perspective="proposing"` (the
   * self-terms framing) so every viewer-centric block still renders exactly as the
   * proposing preview does -- the override touches nothing but the two strings.
   * Omitted by every invitation/accept caller, which then renders the
   * perspective-derived heading and intro unchanged. Both strings are fixed,
   * caller-supplied copy, never partner text. */
  framing?: { heading: string; intro: string };
}) {
  const summary = summarizeInvitation({
    linkageTerms,
    expires,
    disclosedPayloadColumns,
    inviterRetainsFiles,
    connectionEndpoint,
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
        ? `You request ${dataColumns(receiveCount)} from your partner.`
        : `Your partner requests ${dataColumns(receiveCount)} from you.`
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
  // leaving amounts to: the inviter's declared send as chips under "proposing", and
  // for the acceptor either the actual send list (a chosen file supplies
  // outboundColumns) or, on the pre-file review screen, the fixed-copy
  // forward-reference. All of them are the viewer's data leaving, so they sit in the
  // "what you disclose" group with the egress request.
  //
  // A partner that receives no result takes the slot ahead of every one of them,
  // whichever side the viewer sits on: the payload step transmits nothing at all to a
  // partner not entitled to the result (an empty message goes on the wire in its
  // place), so no column leaves whatever the operator's file holds, and a listed set
  // would name a disclosure that does not happen. The gate is partnerReceivesResult
  // -- the viewer-relative split computed above -- and not either raw summary field,
  // because the two sides read opposite ones: an inviter transmits when ITS partner
  // (the acceptor) receives, which is the invitation's shareWithPartner, while an
  // acceptor transmits when ITS partner (the inviting party) receives, which is
  // expectsOutput. Gating either preview on the other's field would suppress a
  // disclosure that does happen.
  //
  // For the acceptor the fact also wins over the forward-reference, because the file
  // that reference points at cannot change the answer, and over the empty-set
  // confirmation, because the direction holds however the operator's file changes
  // while an empty disclosure is a property of the metadata resolved for this
  // acceptance alone -- the precedence the CLI accept prompt applies, so the two
  // surfaces resolve an overlapping case the same way. The displayed direction and
  // the run's own gate are the same fact with an aborting check between them:
  // acceptance mirrors the invitation's output direction into this party's terms, and
  // the compatibility check refuses a partner presenting terms that disagree with
  // that mirror.
  //
  // A count-only exchange answers the slot ahead of even that: it carries no payload
  // in either direction whichever party the terms entitle to the count, so the
  // entitlement the gate below reads does not decide the question and the sentence
  // stating it names the algorithm instead.
  const countOnly = summary.algorithm === "psi-c";
  // The set the count-only block takes the slot from: the inviter's declared send
  // under "proposing", the acceptor's own resolved columns otherwise -- the same
  // viewer-relative pair the blocks below render.
  const viewerOutboundSend =
    perspective === "proposing"
      ? (summary.payload?.send ?? [])
      : (outboundColumns ?? []);
  // The count-only block states a precondition of the algorithm rather than a set
  // this component read: psi-c admits no payload in either direction, and a document
  // or input metadata declaring one is refused where the terms are authored, at the
  // local prepare step, and at the agreed-terms run boundary (docs/spec/PROTOCOL.md,
  // PSI-C). What this set holds is the viewer's own side of that -- the inviter's
  // authored send under "proposing", the acceptor's resolved metadata otherwise --
  // and each side is refused ahead of this screen, naming what to change: the
  // Generate gate for the inviter, the columns step's launch gate for the acceptor
  // (both read core's countOnlyTransmitsColumn). This throw is the render-side
  // backstop behind them. Rendering "no data columns in either direction" over a
  // column would take the operator's consent to a disclosure that happens. The
  // message states the fact and names no column.
  if (countOnly && viewerOutboundSend.length > 0)
    throw new Error(
      "count-only terms carry a non-empty outbound column set: a psi-c " +
        "exchange sends no data column in either direction",
    );
  // The mirror of that check on what the INVITATION declares, which this screen
  // renders beside the tier as the ingress and egress notices: a psi-c document
  // declaring a send or a receive asks for exactly the column movement the algorithm
  // refuses, and the no-payload sentence rendered above "Your partner requests 1 data
  // column from you" would state a guarantee the same screen contradicts. The
  // invitation is partner-controlled, so this side cannot assume the authoring
  // refusal ran -- what it can assume is its own decode, which applies the same
  // rule (core's LinkageTermsSchema); the same backstop reading applies. Read off
  // the two counts those notices are composed from, so no declaration can reach a
  // notice this check did not see.
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
  // Every block that can occupy the outbound-send slot carries the same caption, the
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
  // The always-visible core is tiered by disclosure direction: "What you disclose"
  // (the viewer's own data leaving, lifted to lead so the acceptor's hardest-to-undo
  // fact is not skimmed past), "What the exchange produces" (the matching method and
  // result sharing -- what is revealed and to whom), "What you receive" (inbound
  // partner data), and "How records are matched" (the linkage strategy and matching
  // keys -- mechanics the diligent open, kept below the outcome). Every tier renders
  // through {@link TermsTier}, which is what makes a tier a role="group" whose caption
  // is a HEADING (Title) naming it, so a screen reader can both jump between tiers by
  // heading and hear each as one related set. An attached legal agreement is a
  // cross-cutting governance frame (not a direction), so it carries its own tier,
  // named by a fixed "Legal agreement" aria-label (a short noun phrase distinct from
  // its lead heading, so a screen reader does not announce that full sentence twice).

  // The fields carrying a partner-authored allowedCharacters class, surfaced
  // always-visible: a partner-defined character-class constraint applies to a
  // linkage field, so the acceptor must be on notice before consenting rather than
  // finding it dimmed inside the collapsed "Other details" disclosure. The class is
  // already sanitized once in summarizeInvitation, so this filter carries no fresh
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
  // (Title aria-describedby -> this id), so a screen reader that lands on or jumps
  // to "Invitation from <name>" hears the not-yet-verified caveat as the heading's
  // description -- the same subline-to-target idiom the matching/details toggles use
  // -- rather than a loose sibling paragraph it may skip. The screen moves focus to
  // this heading when the terms appear (headingRef + tabIndex), so this association
  // is what carries the caveat into that announcement.
  const identityNoteId = useId();
  // The visible send-columns captions name their chip list via aria-labelledby (the
  // ColumnChips below each references its Term's caption), so the list's accessible
  // name derives from the one visible caption rather than a second, separately-
  // authored aria-label that could drift from it. Two ids because the inviter's
  // "proposing" send and the acceptor's own outbound send are distinct captions
  // (mutually exclusive by perspective, but each names its own list). The pre-file
  // forward-reference reuses the outbound caption text but wraps no list, so it needs
  // no id.
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
          ahead of the other direction tiers because the acceptor's own outbound
          disclosure is its hardest-to-undo fact, and it must not be skimmed past
          before consent. Holds the acceptor's outbound send (the columns it will
          send, or the pre-file forward-reference) plus the egress request for its
          data; the inviter's own send chips under "proposing". Rendered only when
          this viewer discloses something. */}
      {showsDiscloseGroup && (
        <TermsTier heading="What you disclose" headingOrder={tierHeadingOrder}>
          {/* The inviter's own send, surfaced as chips (reusing {@link ColumnChips},
              the home page's default-exchange-columns visual). Only the inviter's
              "proposing" preview shows it here; the acceptor's send renders below.
              Driven by summary.payload.send (already sanitized), so it cannot drift
              from what the invitation declares. The send is an eager, definite
              declaration under "proposing", so an empty set reads as a positive "no
              columns" confirmation rather than an unknown. */}
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
              Rendered at normal weight, not dimmed, for the reason the
              forward-reference is: it sits beside the egress request, which must
              never read more prominently than what actually leaves. The sentence is
              read from `@psilink/core`, one copy for every surface stating the fact
              (it is viewer-relative, so the inviter's preview and the acceptor's
              screens render the same words); it is fixed first-party copy, naming no
              column. */}
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
                      (ColumnChips renders verbatim) -- a header carrying
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

          {/* The review-screen forward-reference to that same outbound disclosure,
              occupying the slot the actual send list takes once a file is chosen.
              Before a file is chosen outboundColumns is undefined -- the set is not
              yet known -- so the block above cannot render, yet what the acceptor
              discloses is its highest-stakes payload fact and the consent checkbox
              sits on this very screen. Gated to review AND outboundColumns undefined,
              so it is mutually exclusive with the block above. Rendered at normal
              weight (NOT dimmed): the acceptor's own disclosure must not be the
              lightest text on the screen -- it is more consequential than the egress
              request below, which it must read at least as prominently as. Fixed
              copy, so no per-render sanitization; it names no count or names, not yet
              known. */}
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
          result reveals -- identifiers or a count only) and result sharing (who
          receives the result), the AC's produce pair, plus the transcript a
          declared retain mode leaves behind, which is the same question asked of
          what outlives the run. The matching mechanics (linkage strategy, matching
          keys) are split into their own "How records are matched" tier below, so
          this group answers the single question "what does the exchange reveal,
          and to whom" rather than overloading unlike concerns. */}
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
              caveat-placement rule above the tier that qualifies it sits beside it
              rather than one expand down: what the enforced half covers, what the
              rounds disclose past the count, and -- the one a reader taking "only
              a number" for the safe option most needs -- the bound a partner's
              choice of input puts on all of it. Each sentence is read from the
              shared table with its basis, so neither surface classifies a half of
              the count-only claim for itself. */}
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

        {/* Result sharing, stated viewer-relative so each party reads its OWN
            outcome first-person (the consent-legible form for a one-sided exchange).
            The two lines are NOT equally enforced, and the copy must not present a
            trust-contingent "No" as a cryptographic guarantee: Line A (the viewer's
            own receipt) is enforced -- a party set to receive no result is sent none
            and its receive check fails closed on any it is sent -- while Line B's
            "No" is COOPERATIVE, resting on the agreed terms being honored rather
            than on a guarantee this side can impose (a documented property of
            one-sided PSI, docs/notes/one-sided-disclosure.md); its "Yes" is a
            disclosure the run itself delivers, and only the partner's use of the
            result rests on the agreement. Each "No" carries the caveat for its
            register. The viewer's own "Yes" is left unqualified (receiving your own
            result needs no note); the partner's "Yes" -- the accountable disclosure
            of your result to them -- carries a brief pointer that the agreement, not
            this tool, governs its use once out. */}
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
          {/* Where a count-only run entitles BOTH parties to the count, only one of
              them computes it and the other is sent that party's report, so one
              side's "Yes" above is a number psilink did not check. Which side is
              settled by the record counts the run exchanges, not by anything on this
              screen, so the fact is stated for both. Where exactly one party is
              entitled, that party is the receiver by the role rule and computes its
              own count, so no report exists to caveat. */}
          {countOnly && viewerReceivesResult && partnerReceivesResult && (
            <Text size="xs" c="dimmed">
              {CONSENT_FACTS.countOnlyReportedCount.note}
            </Text>
          )}
          {partnerReceivesResult ? (
            // The partner DOES receive: the accountable disclosure (the 164.528
            // event). A "Yes" carries no false-guarantee risk, so it stays a plain
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
                  cooperative caveat above: that caveat is about a dishonest
                  partner KEEPING the result table; this states what an HONEST
                  partner learns intrinsically. To help compute the match, a
                  non-receiving partner (the helper) learns which of ITS OWN
                  records are in the viewer's data -- membership -- and this holds
                  whenever the partner does not receive the result of a `psi`
                  exchange, under both linkage strategies: intrinsically under the
                  cascade, and under single-pass because the receiver currently
                  returns the helper its matched rows (needed whenever it discloses
                  payload for the overlap, and returned even when it does not,
                  pending the hardening task in docs/notes/one-sided-disclosure.md).
                  Stated as an accepted, documented property (docs/notes/one-sided-
                  disclosure.md), not a warning of misbehaviour, and bounded so it
                  cannot overstate: the helper learns membership of its OWN
                  records, never which of the viewer's records they matched, nor
                  anything about the rest of the set beyond its size. Fixed copy,
                  so no partner text enters it; strategy-neutral, but NOT
                  algorithm-neutral -- by the role rule the non-receiving party of
                  a count-only run is the SENDER, which computes nothing from the
                  round and is sent no count-report frame (docs/spec/PROTOCOL.md,
                  PSI-C), so it learns no membership. What a count-only run does
                  disclose is the tier the matching-method headline above
                  carries. */}
              {summary.algorithm !== "psi-c" && (
                <Text size="xs" c="dimmed">
                  {CONSENT_FACTS.partnerLearnsOwnMembership.note}
                </Text>
              )}
            </>
          )}
        </Term>

        {/* What the run LEAVES BEHIND, the third thing this tier's exchange
            produces: under retain mode nothing is deleted and the rendezvous
            location becomes a permanent transcript. It sits always-visible with
            the other two produce facts by the same placement rule the psi-c
            headline takes -- it is a disclosure an acceptor could act on, and it
            is the one fact here that outlives the run, so a reader must not have
            to expand for it. Rendered wherever the invitation discloses the mode
            -- declared, or entailed by a split-directory endpoint an acceptor is
            seeded from -- and nothing where it discloses neither: an invitation
            declaring delete mode and one declaring nothing render alike, since
            neither is a cleanup this transport promises
            (`CONSENT_FACTS.retainedFiles` carries why). The sentence is the
            shared copy the CLI accept prompt renders, so the two surfaces cannot
            word one disclosure two ways. */}
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

        {/* Tier -- HOW RECORDS ARE MATCHED: the mechanics of the match, split out of
          "What the exchange produces" and placed below the disclosure/result tiers
          because it is verification detail the diligent open, not the headline the
          consent decision turns on. Holds the linkage strategy (single-pass only) and
          the always-visible field summary, with the dense per-key rule detail behind
          a default-collapsed "Matching strategies" disclosure. Always rendered, since
          there is always at least one linkage key. */}
        <TermsTier
          heading="How records are matched"
          headingOrder={tierHeadingOrder}
        >
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
            to: a key element that splits its value is matched on each candidate,
            and which of the two facts applies follows the strategy -- the one
            that matches candidates, or the refusal every other one takes. The
            copy is read from CONSENT_FACTS rather than written here, so this
            surface and the CLI accept prompt state the consequence in the same
            words. Rendered from the element transforms the invitation carries;
            the inviter's own data standardization can fan out a field no
            invitation shows, which is why this claims nothing about the whole of
            what the inviter runs. */}
          {summary.fansOut && (
            <Term label="Several values per record">
              <Text size="sm">
                {summary.fanOutApplied
                  ? CONSENT_FACTS.fanOutCandidates.note
                  : CONSENT_FACTS.fanOutRefused.note}
              </Text>
            </Term>
          )}

          {/* The rules' citation, above the matching list it cites: a reader meets
            the name before the enumeration it stands for, and meets in the same
            place that the name is the inviting party's word while the keys and
            fields beneath it are what the exchange holds both parties to (the
            caveat is read from LINKAGE_RULE_SET_VERDICT_COPY, so this surface
            and the CLI accept prompt state it in the same words). Keys before
            fields, since the key set is the specific artifact and the field
            set the substrate it is built from. Both names and both versions
            are partner-controlled text, sanitized by summarizeInvitation and
            bound in their own Text between fixed chrome -- never joined into
            the label -- for the reason the allowed-character class below is:
            a crafted value must not be able to read as system chrome. Within
            the box, each half renders through core's terms-value seam
            (`ruleSetCitation`), the grammar the CLI accept prompt and core's own
            mismatch message render this pair with, which is what keeps the name
            from reading as a citation of some other set at some other version.
            The seam rather than the box, because the box separates a half from
            the chrome around it and not the name from the version, and because
            that separation is styling a reader's stylesheet or a copied-out line
            does not carry, while a run's boundaries are in the text itself. It
            runs after summarizeInvitation's escape, not before: that escape
            truncates and redacts, and either applied to an already-delimited run
            could take the closing delimiter off it, while the two compose in this
            order -- the seam emits only printable ASCII, which the escape leaves
            alone.

            Each half's label carries this build's own verdict on it, from the
            same shared table the caveats come from, so a name psilink resolved
            and disproved says so at the citation's own prominence rather than
            under a blanket caveat that nothing had been checked. The marker sits
            on the first-party label, ahead of the value, for the reason the value
            is boxed: a crafted name must not be able to manufacture one. One
            caveat per DISTINCT verdict the two halves reached follows the pair,
            most severe first, so agreeing halves state their sentence once and
            differing ones are tied to it by their markers.

            The names, versions, and verdicts are all true of the terms whoever
            authored them, so the block renders under every perspective. The
            `unchecked` and `consistent` caveats attribute the citation to a
            partner, so they are gated to `review` like the unverified-identity
            note above -- `proposing` shows the viewer's own citation, and
            `accepted` is past the decision they inform. The `contradicted` caveat
            is not gated: it is this build's own finding about the document on
            screen rather than an attribution to anyone, and a false provenance is
            worth stating to the party about to mint it and to the party reading
            back what it accepted. It is the remedy that turns on the reader --
            take the name up with the other party, or correct terms that are your
            own -- so which sentence a perspective gets is core's call
            (`linkageRuleSetVerdictNote`) rather than a second judgment here. */}
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
              keyed by each key's stable id (InvitationKeySummary.id, the raw key
              name) rather than array index or the sanitized display name, so a
              key's own MatchKeyDisclosure -- and the expanded/collapsed state its
              local useState holds -- follows the key when the inviter reorders the
              list rather than staying pinned to the array position. */}
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
          always-visible core as their own labelled group so a partner-defined
          character-class rule on a linkage field is on notice at the consent point,
          not dimmed inside the collapsed "Other details" disclosure. Rendered only
          when at least one field declares such a class. Each entry names the field,
          then a FIXED system label marking the class as partner-supplied and
          unverified, then the raw (already-sanitized) class in its OWN bounded Text.
          The class is never joined into one sentence: it is partner-controlled and
          may contain any separator, so concatenating it with the label would let a
          crafted value impersonate system chrome (the same reason the coercion notes
          bind their partner value apart). The class is advisory (core's
          `withinAllowedCharacters` warns, does not enforce), so the copy states an
          expectation, not a guarantee; the group's accessible name is fixed via
          aria-labelledby, so no raw partner text enters the name. */}
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
                      the coercion-note pattern -- so partner text cannot be read as
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

        {/* The legal agreement -- a cross-cutting GOVERNANCE frame, not a disclosure
          direction, so it carries its own labelled group. Placed last in the
          always-visible core, below the disclosure/result/mechanics tiers, as a
          pre-consent governance checkpoint: it must stay legible at the consent point
          (never demoted below the fold into "Other details"), but it frames the
          decision rather than leading ahead of what the acceptor actually discloses.
          Its purpose is the field a 45 CFR 164.528 accounting / FERPA studies /
          audit-evaluation exception turns on (docs/COMPLIANCE.md), so it is surfaced
          whole -- reference, PURPOSE, and expiry -- and has no "Other details" entry.
          All three values are pre-sanitized by summarizeInvitation, and the group's
          accessible name is the fixed "Legal agreement" aria-label, so no raw partner
          text enters the name. */}
        {summary.legalAgreement !== undefined && (
          <TermsTier
            heading="This invitation attaches a legal agreement."
            headingOrder={tierHeadingOrder}
            accessibleName="Legal agreement"
          >
            {/* The agreement's three fields read as one block, tighter than the
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
                        {/* Each constraint as its own item. These are fixed
                        plain-language phrases (validity, affix removal, a count
                        of excluded values) carrying no partner free text; the
                        partner-authored allowedCharacters class is surfaced apart,
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
                    inviter's own send is surfaced as chips above "Other details"
                    instead, so it is suppressed here under "proposing". */}
                  {/* Shown whenever the send set is a definite declaration --
                    including the empty set, rendered "(none)" so the strict
                    "receive nothing" commitment is visible rather than inferred from
                    a missing line (the CLI's displayInvitation shows the same). A
                    lazy send (not declared) is omitted instead, which is what leaves
                    the bare "(none)" unambiguous: only a declared direction reaches
                    this line at all. */}
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
                {/* What a deduplicating match reveals that a one-to-one one does
                not, and then whose records are grouped to reveal it -- the
                inviting party's alone, since acceptance derives the accepting
                party's own side as false (deriveAcceptedLinkageTerms) rather
                than adopting the invitation's. Both are the shared wording the
                CLI accept prompt uses beneath its own copy of this headline, and
                WHICH disclosure statement is rendered follows the output shape
                the two surfaces read alike: the accepting party reads the
                grouping where the inviting party shares the result, and is
                presented none where the inviting party is the sole receiver. By
                the placement rule on {@link InvitationTerms} they sit at the
                visibility level of the headline they qualify, which is here -- so
                a reader who expands "Other details" to find that several of the
                inviting party's records may match one of theirs meets what that
                costs, and whose file pays it, in the same place. Rendered for
                exactly a deduplicating invitation the run applies: a one-to-one
                exchange discloses no grouping and groups neither party's
                records, and a deduplicating term under a strategy that matches
                no deduplicating cardinality is refused at acceptance
                (assertDeduplicateImplemented), so either sentence would name
                something that does not happen. */}
                {summary.deduplicate && summary.deduplicateApplied && (
                  <>
                    <Text size="xs" c="dimmed">
                      {summary.inviterSharesResult
                        ? DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT
                        : DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT}
                    </Text>
                    {/* The sole-receiver statement states the withholding this
                    client makes; what the rounds still carry to the accepting
                    party's own process is the fact beside it, read from the
                    shared table with its own basis rather than folded into the
                    sentence. Only that shape carries it: where the inviting
                    party shares the result, the accepting party is presented
                    the grouping and there is no display limit to qualify. */}
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
              would read as a different deadline on each end. */}
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
