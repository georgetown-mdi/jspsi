import { useEffect, useRef, useState } from "react";

import {
  Alert,
  Button,
  Center,
  Container,
  Divider,
  List,
  Loader,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";

import { createFileRoute } from "@tanstack/react-router";

import { errorMessage } from "@psilink/core";

import { prepareAcceptedInvitation } from "@psi/acceptInvitation";

import { Exchange } from "@components/Exchange";

import type { Ref } from "react";

import type { AcceptableInvitation } from "@psi/acceptInvitation";

export const Route = createFileRoute("/accept")({
  // The encoded token rides in the URL fragment, which never reaches the server,
  // so decoding and rendering must happen client-side only.
  ssr: false,
  component: Accept,
});

/** The decode/validate result: pending while it runs, an error message on a bad
 * or expired invitation, or the validated invitation ready to review and accept. */
type DecodeState =
  | { status: "pending" }
  | { status: "error"; message: string }
  | { status: "ready"; invitation: AcceptableInvitation };

/** Minimal review of the inviter's linkage terms, enough to satisfy informed
 * acceptance; the richer consent screen (full terms, expiry context, an explicit
 * consent gate) is a separate task. */
function TermsReview({
  invitation,
  headingRef,
}: {
  invitation: AcceptableInvitation;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const { token } = invitation;
  const { linkageTerms } = token;
  return (
    <Stack gap="xs">
      {/* tabIndex + ref so the accept page can move focus here when decoding
          resolves, announcing the invitation to assistive tech (mirrors the
          inviter panel's post-generate focus move). */}
      <Title order={3} ref={headingRef} tabIndex={-1}>
        Invitation from {linkageTerms.identity}
      </Title>
      <Text size="sm">
        Records will be matched on{" "}
        {linkageTerms.algorithm === "psi-c"
          ? "the count of shared identifiers only"
          : "shared identifiers"}{" "}
        using these keys:
      </Text>
      <List size="sm">
        {linkageTerms.linkageKeys.map((key) => (
          <List.Item key={key.name}>{key.name}</List.Item>
        ))}
      </List>
      {token.expires !== undefined && (
        <Text size="xs" c="dimmed">
          Expires {new Date(token.expires).toLocaleString()}
        </Text>
      )}
    </Stack>
  );
}

function Accept() {
  const [decode, setDecode] = useState<DecodeState>({ status: "pending" });
  const [acceptorName, setAcceptorName] = useState("");
  // The name, committed by an explicit "Continue". Until it is set the field is
  // editable; once set it seeds the in-flight exchange and the field locks, so
  // an edit cannot unmount the Exchange and silently abort a running dial.
  const [confirmedName, setConfirmedName] = useState<string>();

  useEffect(() => {
    // Abort on unmount so a resolving decode does not setState after teardown.
    const controller = new AbortController();
    // The token is the URL fragment minus the leading "#".
    const encoded = window.location.hash.replace(/^#/, "");
    if (!encoded) {
      setDecode({
        status: "error",
        message:
          "No invitation was found in this link. Paste the code on the home " +
          "page instead.",
      });
      return;
    }
    // Decode, check expiry, and require a WebRTC endpoint BEFORE any connect: the
    // exchange UI (which dials) renders only on the "ready" branch, so an expired
    // or malformed invitation can never reach a rendezvous.
    void (async () => {
      try {
        const invitation = await prepareAcceptedInvitation(encoded);
        if (!controller.signal.aborted)
          setDecode({ status: "ready", invitation });
      } catch (err) {
        if (!controller.signal.aborted)
          setDecode({ status: "error", message: errorMessage(err) });
      }
    })();
    return () => controller.abort();
  }, []);

  // Move focus to the invitation heading once decoding resolves to "ready", so a
  // screen-reader/keyboard user is taken to the revealed terms rather than left on
  // the spinner (mirrors InvitePanel's post-generate focus move).
  const readyHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (decode.status === "ready") readyHeadingRef.current?.focus();
  }, [decode.status]);

  return (
    <Container size="sm" mt="md">
      <Paper>
        <Title order={2}>Accept an invitation</Title>
        {decode.status === "pending" && (
          <Center mt="md">
            <Loader size="sm" />
          </Center>
        )}
        {decode.status === "error" && (
          <Alert color="red" title="Cannot accept this invitation" mt="md">
            {decode.message}
          </Alert>
        )}
        {decode.status === "ready" && (
          <Stack mt="md">
            <TermsReview
              invitation={decode.invitation}
              headingRef={readyHeadingRef}
            />
            <Divider
              my="sm"
              label="Accept and exchange"
              labelPosition="center"
            />
            <Text size="sm" c="dimmed">
              To accept, enter your name, choose your data file, and start. Your
              browser connects directly to your partner.
            </Text>
            <TextInput
              value={acceptorName}
              // The handler is the controlled-input contract; once the field is
              // disabled below it is simply inert (a disabled input fires no
              // change), and Continue has already frozen the trimmed name, so the
              // value that seeds the exchange cannot drift.
              onChange={(e) => setAcceptorName(e.target.value)}
              disabled={confirmedName !== undefined}
              withAsterisk
              required
              label="Your name"
              description="Recorded in your exchange record so your partner can identify you"
              placeholder="Your name"
            />
            {confirmedName === undefined ? (
              <Button
                disabled={!acceptorName.trim()}
                onClick={() => {
                  const trimmed = acceptorName.trim();
                  setAcceptorName(trimmed);
                  setConfirmedName(trimmed);
                }}
              >
                Continue
              </Button>
            ) : (
              // Keyed by the secret so it never persists across a different
              // invitation; the name above is locked while it runs, so the
              // exchange completes rather than being torn down by an edit.
              // Reload the page to start over with a different name.
              <Exchange
                key={decode.invitation.token.sharedSecret}
                role="acceptor"
                partyName={confirmedName}
                sharedSecret={decode.invitation.token.sharedSecret}
                endpoint={decode.invitation.endpoint}
              />
            )}
          </Stack>
        )}
      </Paper>
    </Container>
  );
}
