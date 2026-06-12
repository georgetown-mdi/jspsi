import { List, Stack, Text, Title } from "@mantine/core";

import { summarizeInvitation } from "@psi/invitationSummary";

import type { ReactNode, Ref } from "react";

import type { InvitationToken } from "@psilink/core";

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

        <Term label="Records are matched on">
          <List size="sm" withPadding>
            {/* Keyed by index, not the name: the schema enforces uniqueness on
                the raw key names, but two that differ only in characters
                sanitizeForDisplay escapes would collide as React keys. The list
                is static, so the index is a stable key. */}
            {summary.linkageKeyNames.map((name, index) => (
              <List.Item key={index}>{name}</List.Item>
            ))}
          </List>
        </Term>

        <Term label="Personal data used">
          <Text size="sm">{summary.linkageFieldLabels.join(", ")}</Text>
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
              <Text size="sm">
                Your partner will send: {summary.payload.send.join(", ")}
              </Text>
            )}
            {summary.payload.receive.length > 0 && (
              <Text size="sm">
                Your partner requests from you:{" "}
                {summary.payload.receive.join(", ")}
              </Text>
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
          This invitation expires {new Date(summary.expires).toLocaleString()}
        </Text>
      )}
    </Stack>
  );
}
