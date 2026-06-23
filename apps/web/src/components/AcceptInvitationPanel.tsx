import {
  Alert,
  Center,
  Checkbox,
  Divider,
  Loader,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";

import { IconAlertCircle } from "@tabler/icons-react";

import { commitAcceptance } from "@psi/acceptConsent";

import FileAcquire from "@components/FileAcquire";
import { InvitationTerms } from "@components/InvitationTerms";

import type { Ref } from "react";

import type { AcquiredBundle, AlertContent } from "@components/FileAcquire";
import type { AcceptableInvitation } from "@psi/acceptInvitation";

/** The decode/validate result: pending while it runs, an error message on a bad
 * or expired invitation, or the validated invitation ready to review and accept. */
export type DecodeState =
  | { status: "pending" }
  | { status: "error"; message: string }
  | { status: "ready"; invitation: AcceptableInvitation };

/**
 * The accept review screen's presentation: a spinner while decoding, a distinct
 * error for a bad or expired invitation (with no consent action), or -- once
 * decoded -- the inviter's linkage terms followed by the consent gate (consent
 * checkbox, name, and a CSV drop), all before any connection.
 *
 * Stateless and effect-free so it can be rendered in isolation: the route owns
 * the decode effect and the consent state and passes them in, and owns the
 * transition to the exchange screen (the embedded file-acquire phase hands a
 * satisfiable bundle up via `onAcquired`). The "Accept and continue" action --
 * {@link FileAcquire}'s submit -- is held disabled by commitAcceptance until the
 * user has consented and named themselves, so no file is parsed and nothing dials
 * before consent.
 */
export function AcceptInvitationPanel({
  decode,
  headingRef,
  errorRef,
  consented,
  onConsentedChange,
  acceptorName,
  onAcceptorNameChange,
  error,
  onAcquireError,
  onAcquired,
}: {
  decode: DecodeState;
  headingRef?: Ref<HTMLHeadingElement>;
  errorRef?: Ref<HTMLDivElement>;
  consented: boolean;
  onConsentedChange: (value: boolean) => void;
  acceptorName: string;
  onAcceptorNameChange: (value: string) => void;
  /** The review-screen error to display beneath the consent gate: a CSV read
   * failure. Cleared at the start of each attempt. */
  error?: AlertContent;
  /** Set or clear the review-screen error; wired to the file-acquire phase's
   * `onError`. */
  onAcquireError: (alert: AlertContent | undefined) => void;
  /** Receive the parsed CSV; wired to the file-acquire phase's `onAcquired`. The
   * route commits consent and transitions to the "Prepare your data" editor from
   * here. */
  onAcquired: (bundle: AcquiredBundle) => void;
}) {
  return (
    <>
      {decode.status === "pending" && (
        <Center mt="md">
          <Loader size="sm" />
        </Center>
      )}
      {decode.status === "error" && (
        // tabIndex + ref so the page can move focus here when decoding resolves
        // to an error, rather than leaving a screen-reader user on the spinner.
        <Alert
          color="red"
          // Severity icon so the error is not signalled by color alone (WCAG
          // 1.4.1); aria-hidden since the title text already names it.
          icon={<IconAlertCircle aria-hidden />}
          title="Cannot accept this invitation"
          mt="md"
          ref={errorRef}
          tabIndex={-1}
          // A decode error is collapsed to a single readable line by
          // describeDecodeError, so this is normally one line; pre-line is kept
          // defensively to render a newline a relayed plain-Error message could
          // still carry on its own line (browsers collapse it otherwise) rather
          // than run two lines together.
          style={{ whiteSpace: "pre-line" }}
        >
          {decode.message}
        </Alert>
      )}
      {decode.status === "ready" && (
        <Stack mt="md">
          <InvitationTerms
            linkageTerms={decode.invitation.token.linkageTerms}
            expires={decode.invitation.token.expires}
            disclosedPayloadColumns={
              decode.invitation.token.disclosedPayloadColumns
            }
            headingRef={headingRef}
          />
          <Divider my="sm" label="Accept and exchange" labelPosition="center" />
          <Text size="sm" c="dimmed">
            To accept your partner's proposed terms, confirm your consent, enter
            your name, and choose your data file. Your browser connects directly
            to your partner.
          </Text>
          <Checkbox
            checked={consented}
            onChange={(event) => onConsentedChange(event.currentTarget.checked)}
            label="I have reviewed my partner's proposed terms and consent to this exchange"
          />
          <TextInput
            value={acceptorName}
            onChange={(event) => onAcceptorNameChange(event.target.value)}
            withAsterisk
            required
            label="Your name"
            description="Recorded in your exchange record so your partner can identify you"
            placeholder="Your name"
          />
          {/* The file-acquire phase parses the chosen CSV on the single "Accept
              and continue" action. commitAcceptance is the authoritative gate,
              used here for the submit's disabled state and again in the route's
              onAcquired handler, so nothing is parsed -- let alone handed off and
              dialed -- before both consent and a name. On a successful parse it
              hands the parsed bundle to onAcquired, which moves to the "Prepare
              your data" editor where the linkage-satisfiability verdict is shown
              and an unsatisfiable file can be fixed rather than dead-ended. */}
          <FileAcquire
            submitLabel="Accept and continue"
            submitDisabled={
              commitAcceptance({ consented, name: acceptorName }) === undefined
            }
            onError={onAcquireError}
            onAcquired={onAcquired}
          />
          {error && (
            // pre-line so a read-failure message's per-cause newlines (from
            // sanitizeErrorForDisplay) render one cause per line.
            <Alert
              color="red"
              icon={<IconAlertCircle aria-hidden />}
              title={error.title}
              style={{ whiteSpace: "pre-line" }}
            >
              {error.message}
            </Alert>
          )}
        </Stack>
      )}
    </>
  );
}
