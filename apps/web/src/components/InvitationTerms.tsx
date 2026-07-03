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
                  {/* Flag a proposed expansion the run does not yet perform, so
                      the acceptor is not told a looser match occurs when it
                      does not. */}
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
 * matching list sits behind a default-collapsed "Matching strategies" disclosure;
 * inside it each linkage key is its own further default-collapsed disclosure, whose
 * header is the key name and a short derived one-liner of the fields it matches on
 * (each carrying a terse breadth marker -- "(partial)", "(fuzzy)" -- when its
 * element loosens matching), and whose expanded body holds the per-element
 * transform/swap/fuzzy detail. The remaining dense detail (personal-data
 * constraints, payload columns, legal agreement, and dedup notes) sits behind a
 * single default-collapsed "Other details" disclosure. The matching method and
 * result sharing stay always-visible.
 *
 * Three facts whose detail lives in that disclosure also carry an always-visible
 * PRESENCE hint in the core, since each would otherwise be invisible until the
 * acceptor expands Details: an extra-payload-egress request (a count of the columns
 * the inviter requests FROM the acceptor), the inbound partner data the invitation
 * will send the acceptor (a count of the columns it will receive -- its ingress),
 * and an attached legal agreement (a fixed-copy flag). Only the presence is
 * surfaced -- the column lists and the agreement text stay in Details, not
 * duplicated into the core. The hints render as one labelled "Before you consent"
 * group (role=group), and the "Other details" toggle references that group as its
 * accessible description, so a screen-reader user hears the flagged facts as a
 * related set and is pointed at the disclosure that expands them. The ingress hint
 * is the weaker payload signal (receiving partner data is not a disclosure by the
 * acceptor) and is omitted from the inviter's "proposing" preview, which already
 * shows its send as chips.
 *
 * `perspective` selects the heading and intro copy for the three contexts this
 * renders in -- the acceptor `review`ing a partner's proposal (pre-consent), the
 * acceptor viewing the terms it has `accepted` (during the run, so the copy is
 * past-tense rather than "proposes"), and the inviter looking at the terms it is
 * `proposing` (its own identity, so it is not labelled "Invitation from <self>")
 * -- plus the few viewer-centric blocks whose framing depends on who is reading:
 * Result sharing and the payload send/receive copy read first-person for each
 * party, and the inviter's `proposing` preview surfaces its sent columns as chips
 * above "Other details" (so they are not also repeated inside it). The matching
 * keys and the rest of the body are identical across all three. `headingOrder`
 * sets only the heading's semantic level (its visual size is fixed), so the
 * outline nests correctly under the page's `h1` (acceptor) or section `h2`
 * (inviter).
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
   * `[]` renders the explicit "no columns are sent" line; undefined renders nothing
   * (the set is not yet known -- e.g. the review screen before a file is chosen). */
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
  // Always-visible egress notice: the count of columns the inviter requests FROM
  // the acceptor (summary.payload.receive) -- the acceptor's own data egress.
  // A count, not the column names: the length is a bounded integer (the column
  // count is capped at decode, MAX_PAYLOAD_ENTRIES), so it carries no partner
  // free text into the always-visible core regardless of what the names contain;
  // the names themselves stay sanitized in Details. The columns the inviter SENDS
  // are data the acceptor receives, not an egress, so they do not trip this
  // notice. Undefined when nothing is requested, so the notice is absent rather
  // than reading "0 columns".
  const receiveCount = summary.payload?.receive.length ?? 0;
  // Direction-first, and a REQUEST (conditional): the inviter asks for the
  // acceptor's own columns, which the acceptor may or may not supply -- so the copy
  // says "requests ... from you", never the definite "you will send", and pairs
  // with the ingress line's opposite "you will receive ... from your partner" below
  // so the two adjacent count lines are not confusable at a glance.
  const egressNotice =
    receiveCount > 0
      ? perspective === "proposing"
        ? `You request ${receiveCount} data ` +
          `${receiveCount === 1 ? "column" : "columns"} from your partner.`
        : `Your partner requests ${receiveCount} data ` +
          `${receiveCount === 1 ? "column" : "columns"} from you.`
      : undefined;
  // Always-visible ingress notice: the count of columns the inviter will SEND the
  // acceptor for matched records (summary.payload.send) -- inbound partner data the
  // acceptor is put on notice of before it expands Details. A count, not the names:
  // the send set is bounded at decode (MAX_PAYLOAD_ENTRIES) and its names are
  // already sanitized in summarizeInvitation, so the length carries no partner free
  // text into the core; the names stay in Details. Weaker than the egress notice --
  // receiving partner data is not a disclosure BY the acceptor -- so it is an
  // informational presence signal, not a consent-integrity one. Absent under
  // "proposing": the inviter's own send is already surfaced as chips in the core
  // there (see below), so its detail is not hidden in Details and the presence-hint
  // precondition is not met (and an acceptor-framed "you will receive" line would be
  // wrong for the inviter there). The declared-empty "receive nothing" lock-in has
  // an empty send (shown "(none)" in Details), so sendCount is 0 and the notice is
  // absent -- there is no incoming data to flag; only a non-empty send raises it.
  const sendCount = summary.payload?.send.length ?? 0;
  // Direction-first, and a DECLARATION (definite): summary.payload.send is the
  // disclosed set the exchange transmits for matched records, so the copy states
  // "you will receive", the certain counterpart to the egress line's conditional
  // "requests". Mirrors the always-visible "Result sharing" block's "You will
  // receive ..." framing directly above.
  const ingressNotice =
    perspective !== "proposing" && sendCount > 0
      ? `You will receive ${sendCount} data ` +
        `${sendCount === 1 ? "column" : "columns"} from your partner.`
      : undefined;
  // The presence-hint region renders when any of its three flags fires; the "Other
  // details" toggle's aria-describedby is gated on the same condition, so it never
  // dangles at an absent region.
  const hasPresenceHints =
    egressNotice !== undefined ||
    ingressNotice !== undefined ||
    summary.legalAgreement !== undefined;
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Stable id linking the disclosure toggle (aria-controls) to its panel; useId
  // keeps it consistent across SSR and hydration.
  const detailsId = useId();
  // The "before you consent" presence-hint region: presenceHintsLabelId names it
  // (aria-labelledby -> its caption) so assistive tech announces the hints as one
  // group, and presenceHintsId is the region the "Other details" toggle references
  // via aria-describedby, so a non-visual user reaching that toggle hears the
  // flagged facts it expands (the same companion-text-to-disclosure association the
  // matching toggle uses).
  const presenceHintsId = useId();
  const presenceHintsLabelId = useId();
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
  const reduceMotion = useReducedMotion();
  return (
    <Stack gap="sm">
      <Title order={headingOrder} size="h2" ref={headingRef} tabIndex={-1}>
        {perspective === "proposing"
          ? "Exchange proposal"
          : `Invitation from ${summary.invitingParty}`}
      </Title>
      <Text size="sm" c="dimmed">
        {perspective === "proposing"
          ? "Your partner must review and consent to these details before any data is exchanged."
          : perspective === "accepted"
            ? "These are the exchange details."
            : "These are the details your partner proposes for linking your records."}
      </Text>

      <Stack gap="xs">
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
          {/* psi-c is a disclosure guarantee: flag a proposed count-only setting
              the run does not yet honor, so the line above cannot read as in
              force while the exchange still reveals matched identifiers. */}
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

        {/* Viewer-centric, so each party reads its OWN outcome first-person rather
            than inferring it from the inviter's perspective: this is the consent-
            legible form for a one-sided exchange, where the acceptor must know plainly
            whether IT receives a result. The viewer is the inviter under
            "proposing" (its preview) and the acceptor under "review"/"accepted"; the
            acceptor receives iff the inviter shares (and shares iff the inviter
            receives), the mirror the exchange derives. */}
        <Term label="Result sharing">
          {perspective === "proposing" ? (
            <>
              <Text size="sm">
                You will receive the matched result:{" "}
                {yesNo(summary.inviterReceivesOutput)}
              </Text>
              <Text size="sm">
                Your partner will receive the result:{" "}
                {yesNo(summary.inviterSharesResult)}
              </Text>
            </>
          ) : (
            <>
              <Text size="sm">
                You will receive the matched result:{" "}
                {yesNo(summary.inviterSharesResult)}
              </Text>
              <Text size="sm">
                Your partner (the inviter) will receive the result:{" "}
                {yesNo(summary.inviterReceivesOutput)}
              </Text>
            </>
          )}
        </Term>

        {/* Always-visible presence hints, grouped in a labelled "Before you
            consent" region and kept OUTSIDE the "Other details" disclosure (the same
            out-of-disclosure pattern the per-key breadth markers follow): an
            extra-payload-egress request, the inbound partner data the invitation
            will send (the acceptor's ingress), and an attached legal agreement
            otherwise have NO surfaced signal that they exist at all -- all sit only
            inside the default-collapsed Details, unlike the matching breadth, which
            is always visible in each key's header. This surfaces only the PRESENCE
            (a count, or a fixed-copy flag), never the detail: the column lists and
            the agreement text stay one expand down.

            The region is a role="group" named by its caption (aria-labelledby), so
            assistive tech announces the hints as one related set rather than three
            disconnected sentences, and the "Other details" toggle points its
            aria-describedby back at this region (when present), so a non-visual user
            reaching that toggle hears the flagged facts that expand there -- the same
            always-visible-companion-to-disclosure association the matching toggle
            uses. Both invariants are pinned by render tests.

            The two payload lines lead with WHO does WHAT so their opposite
            directions are not confusable: the egress line is a conditional REQUEST
            for the acceptor's own data ("requests ... from you"), the ingress line
            the inviter's definite DECLARATION of what it will send ("you will
            receive ... from your partner"). The ingress line is the weaker signal
            (receiving partner data is not a disclosure by the acceptor) and is absent
            under the inviter's own "proposing" preview, which surfaces its send as
            chips in the core instead. */}
        {hasPresenceHints && (
          <Stack
            id={presenceHintsId}
            role="group"
            aria-labelledby={presenceHintsLabelId}
            gap={4}
          >
            <Text id={presenceHintsLabelId} size="sm" fw={600}>
              {perspective === "proposing"
                ? "Before your partner consents"
                : "Before you consent"}
            </Text>
            {egressNotice !== undefined && (
              <Text size="sm" fw={500}>
                {egressNotice}
              </Text>
            )}
            {ingressNotice !== undefined && (
              <Text size="sm" fw={500}>
                {ingressNotice}
              </Text>
            )}
            {summary.legalAgreement !== undefined && (
              <Text size="sm" fw={500}>
                This invitation attaches a legal agreement.
              </Text>
            )}
          </Stack>
        )}

        {/* The columns this party sends to its partner for matched records,
            surfaced as chips in the always-visible core -- right above the "Other
            details" disclosure -- rather than only inside it, reusing the same chip
            visual ({@link ColumnChips}) the home page's default-exchange-columns
            surface uses. Only the inviter's own "proposing" preview shows it here;
            the acceptor's review/accepted views keep the send list inline under
            "Other details". Driven by summary.payload.send (already sanitized by
            summarizeInvitation), so it cannot drift from what the invitation
            declares. The send is an eager, definite declaration under "proposing"
            (the editor preview derives it from the disclosure grid, and both web
            mint paths author it to the disclosed set), so an empty set reads as a
            positive "no columns" confirmation rather than an unknown. */}
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

        {/* The acceptor's OWN outbound disclosure, in the same always-visible slot
            as the inviter's proposing block above, so "Columns you will send" sits
            with the agreed terms and ABOVE "Other details" rather than after the
            whole panel. Only the acceptor passes outboundColumns; the inviter's own
            send already renders from its proposing block. */}
        {perspective !== "proposing" && outboundColumns !== undefined && (
          <Term label="Columns you will send to your partner">
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
                label="Columns you will send to your partner"
              />
            ) : (
              <Text size="sm" c="dimmed">
                No columns are sent to your partner; only the linkage result
                (which of your rows matched) is produced.
              </Text>
            )}
          </Term>
        )}
      </Stack>

      {/* A real disclosure: the toggle carries aria-expanded and aria-controls,
          and while closed Mantine's Collapse hides the panel from assistive tech
          and the tab order until opened -- with motion via aria-hidden + inert (and
          display:none), and under a reduced-motion preference via display:none on a
          panel React Activity keeps mounted. aria-controls points at the stable
          wrapper below, not the Collapse panel, so the reference resolves to a
          present element however Mantine mounts or hides the panel across motion
          preferences. A render test pins this against the accessibility tree, so
          the wrapper is not safe to inline back onto the panel. */}
      <UnstyledButton
        onClick={() => setDetailsOpen((open) => !open)}
        aria-expanded={detailsOpen}
        aria-controls={detailsId}
        aria-describedby={hasPresenceHints ? presenceHintsId : undefined}
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
                above) or a declared receive (present even when empty). The guard
                mirrors the two inner conditions below so the Term never renders an
                empty label -- which it would in the inviter's preview, where the
                send block is suppressed and receive is usually undeclared. */}
            {summary.payload !== undefined &&
              ((summary.payload.sendDeclared && perspective !== "proposing") ||
                summary.payload.receiveDeclared) && (
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
                            (none) -- any payload column would abort the
                            exchange
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

            {summary.legalAgreement !== undefined && (
              <Term label="Legal agreement">
                <Text size="sm">{summary.legalAgreement.reference}</Text>
                <Text size="sm">{summary.legalAgreement.purpose}</Text>
                <Text size="xs" c="dimmed">
                  Valid through {summary.legalAgreement.expirationDate}
                </Text>
              </Term>
            )}

            <Term label="Duplicate matches">
              <Text size="sm">
                {summary.deduplicate
                  ? "A record may match more than one of the partner's records."
                  : "Each record matches at most one of the partner's records."}
              </Text>
              {/* A proposed looser setting the run does not yet honor: flag it
                rather than let the line above read as the behavior in force. */}
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
