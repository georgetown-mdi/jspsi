import { Badge, Group, List, Stack, Text, Title } from "@mantine/core";

import { summarizeInvitation } from "@psi/invitationSummary";

import type { ReactNode, Ref } from "react";

import type { InvitationToken } from "@psilink/core";

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
 * One linkage key: its name, a flag when it carries any non-default matching
 * rule, its ordered elements (each annotated with the transform or fuzzy
 * comparison that alters its match), and a note for a swap. So the acceptor
 * sees every rule that changes which records match -- and, under `psi`, which
 * shared identifiers are disclosed -- not just the key's name.
 */
function MatchKey({ summary }: { summary: InvitationKeySummary }) {
  // A block, not a <List.Item>: it carries flow content (a Group, a nested
  // element list, a swap note), which Mantine's List.Item would place inside an
  // inline <span>, producing invalid markup.
  return (
    <Stack gap={2}>
      <Group gap="xs">
        <Text size="sm">{summary.name}</Text>
        {summary.hasNonDefaultRule && (
          // role="img" makes the aria-label the badge's accessible name: a
          // Mantine Badge renders as a plain <div>, on which an aria-label alone
          // is unreliably exposed to assistive tech and, where honored, would
          // clash with the visible text.
          <Badge
            size="xs"
            color="yellow"
            variant="light"
            role="img"
            aria-label="Warning: this key uses non-standard matching rules"
          >
            Non-standard matching
          </Badge>
        )}
      </Group>
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
                  - fuzzy match: {element.fuzzyComparison}
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
                <Text size="xs" c="dimmed">
                  transformed ({transform.function})
                </Text>
                {/* Plain-language description of the function's matching effect.
                    Fixed copy keyed by the recognized function name (not
                    partner-controlled), so it renders verbatim; absent for a
                    function name core does not recognize. */}
                {transform.description !== undefined && (
                  <Text size="xs" c="dimmed" pl="md" fs="italic">
                    {transform.description}
                  </Text>
                )}
                {transform.params.map((param, pi) => (
                  <Text key={pi} size="xs" c="dimmed" pl="md">
                    {param}
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
      {/* When both swapped elements carry transforms, the receiver applies each
          element's transforms to the OTHER element's field value (the field
          references swap, the transforms stay put), which the generic swap note
          above does not convey. swapTransformInterchange implies swap is set. */}
      {summary.swapTransformInterchange && summary.swap !== undefined && (
        <Text size="xs" c="dimmed">
          When matched in that order, the transforms shown for {summary.swap[0]}{" "}
          are applied to {summary.swap[1]}&rsquo;s value, and those for{" "}
          {summary.swap[1]} to {summary.swap[0]}&rsquo;s value.
        </Text>
      )}
    </Stack>
  );
}

/**
 * Renders the inviter's linkage terms decoded from an {@link InvitationToken}
 * for the accepting user to review before consenting. The acceptor reviews the
 * inviter's proposal as-is; they do not supply alternative terms here.
 *
 * All partner-controlled free text is sanitized for display by
 * {@link summarizeInvitation}, mirroring the CLI's `displayInvitation`: the
 * inviter crafts the token, so its identity, key names, and legal/payload text
 * are untrusted and could otherwise carry control, bidi, or homoglyph
 * characters that JSX escaping alone does not neutralize.
 */
export function InvitationTerms({
  token,
  headingRef,
}: {
  token: InvitationToken;
  // tabIndex + ref so the accept page can move focus here when decoding
  // resolves, announcing the invitation to assistive tech (mirrors the inviter
  // panel's post-generate focus move).
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const summary = summarizeInvitation(token);
  return (
    <Stack gap="sm">
      <Title order={3} ref={headingRef} tabIndex={-1}>
        Invitation from {summary.invitingParty}
      </Title>
      <Text size="sm" c="dimmed">
        These are the terms your partner proposes for linking your records.
        Review them before you continue; nothing is sent to your partner until
        you consent below.
      </Text>

      <Stack gap="xs">
        <Term label="Matching method">
          <Text size="sm">
            {summary.algorithm === "psi-c"
              ? "Only the number of records you have in common is revealed, not which records match."
              : "The shared identifiers of records you have in common are revealed to whoever receives the result."}
          </Text>
        </Term>

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
              Your partner proposes this, but this version of the exchange does
              not yet apply it; each record still matches at most one.
            </Text>
          )}
        </Term>

        <Term label="Records are matched on">
          {/* A Stack of key blocks, not a Mantine List: each key renders flow
              content (see MatchKey), which a List.Item would nest invalidly.
              Keyed by index -- the list is static and key names are not unique
              once sanitized. */}
          <Stack gap="sm">
            {summary.linkageKeys.map((key, index) => (
              <MatchKey key={index} summary={key} />
            ))}
          </Stack>
        </Term>

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

        <Term label="Result sharing">
          <Text size="sm">
            Inviter expects to receive the result:{" "}
            {yesNo(summary.inviterReceivesOutput)}
          </Text>
          <Text size="sm">
            Inviter is willing to share the result with you:{" "}
            {yesNo(summary.inviterSharesResult)}
          </Text>
        </Term>

        {summary.payload !== undefined && (
          <Term label="Additional data for matched records">
            {summary.payload.send.length > 0 && (
              <Stack gap={2}>
                <Text size="sm">Your partner will send:</Text>
                {/* One column per item rather than a joined string: a
                    partner-controlled column name may contain the separator,
                    which joined text would render as spurious extra columns.
                    Keyed by index -- column order is fixed and a sanitized
                    name is not unique. */}
                <List size="sm" withPadding listStyleType="circle">
                  {summary.payload.send.map((column, index) => (
                    <List.Item key={index}>{column}</List.Item>
                  ))}
                </List>
              </Stack>
            )}
            {summary.payload.receive.length > 0 && (
              <Stack gap={2}>
                <Text size="sm">Your partner requests from you:</Text>
                <List size="sm" withPadding listStyleType="circle">
                  {summary.payload.receive.map((column, index) => (
                    <List.Item key={index}>{column}</List.Item>
                  ))}
                </List>
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
      </Stack>

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
