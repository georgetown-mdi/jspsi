import {
  Alert,
  Button,
  Center,
  Checkbox,
  Divider,
  Loader,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";

import { commitAcceptance } from "@psi/acceptConsent";

import { InvitationTerms } from "@components/InvitationTerms";

import type { ReactNode, Ref } from "react";

import type { AcceptableInvitation } from "@psi/acceptInvitation";

/** The decode/validate result: pending while it runs, an error message on a bad
 * or expired invitation, or the validated invitation ready to review and accept. */
export type DecodeState =
  | { status: "pending" }
  | { status: "error"; message: string }
  | { status: "ready"; invitation: AcceptableInvitation };

/**
 * The accept screen's presentation: a spinner while decoding, a distinct error
 * for a bad or expired invitation (with no consent action), or -- once decoded
 * -- the inviter's linkage terms followed by an explicit consent gate.
 *
 * Stateless and effect-free so it can be rendered in isolation: the route owns
 * the decode effect and the consent state and passes them in. The exchange
 * element (which dials) is supplied only once the user has consented, via
 * `exchange`; until then the ready branch shows the consent controls, so no
 * rendezvous, key exchange, or PSI frame can be sent before consent.
 */
export function AcceptInvitationPanel({
  decode,
  headingRef,
  errorRef,
  consented,
  onConsentedChange,
  acceptorName,
  onAcceptorNameChange,
  onAccept,
  exchange,
}: {
  decode: DecodeState;
  headingRef?: Ref<HTMLHeadingElement>;
  errorRef?: Ref<HTMLDivElement>;
  consented: boolean;
  onConsentedChange: (value: boolean) => void;
  acceptorName: string;
  onAcceptorNameChange: (value: string) => void;
  onAccept: () => void;
  exchange?: ReactNode;
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
          title="Cannot accept this invitation"
          mt="md"
          ref={errorRef}
          tabIndex={-1}
          // pre-line preserves the newline sanitizeErrorForDisplay puts before
          // each "caused by:" link (browsers collapse it otherwise) so a
          // multi-cause decode error shows one cause per line; the message is
          // already escaped, so the only newlines present are those separators.
          style={{ whiteSpace: "pre-line" }}
        >
          {decode.message}
        </Alert>
      )}
      {decode.status === "ready" && (
        <Stack mt="md">
          <InvitationTerms
            token={decode.invitation.token}
            headingRef={headingRef}
          />
          <Divider my="sm" label="Accept and exchange" labelPosition="center" />
          {exchange ?? (
            <Stack>
              <Text size="sm" c="dimmed">
                To accept, confirm your consent, enter your name, and choose
                your data file. Your browser connects directly to your partner.
              </Text>
              <Checkbox
                checked={consented}
                onChange={(event) =>
                  onConsentedChange(event.currentTarget.checked)
                }
                label="I have reviewed these linkage terms and consent to this exchange"
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
              {/* commitAcceptance is the authoritative gate, used here for the
                  disabled state and again in the route's onAccept handler, so an
                  exchange cannot be committed without both consent and a name. */}
              <Button
                disabled={
                  commitAcceptance({ consented, name: acceptorName }) ===
                  undefined
                }
                onClick={onAccept}
              >
                Accept and continue
              </Button>
            </Stack>
          )}
        </Stack>
      )}
    </>
  );
}
