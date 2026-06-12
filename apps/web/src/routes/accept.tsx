import { useEffect, useRef, useState } from "react";

import { Container, Paper, Title } from "@mantine/core";

import { createFileRoute } from "@tanstack/react-router";

import { sanitizeErrorForDisplay } from "@psilink/core";

import { commitAcceptance } from "@psi/acceptConsent";
import { prepareAcceptedInvitation } from "@psi/acceptInvitation";

import { AcceptInvitationPanel } from "@components/AcceptInvitationPanel";
import { Exchange } from "@components/Exchange";

import type { DecodeState } from "@components/AcceptInvitationPanel";

export const Route = createFileRoute("/accept")({
  // The encoded token rides in the URL fragment, which never reaches the server,
  // so decoding and rendering must happen client-side only.
  ssr: false,
  component: Accept,
});

function Accept() {
  const [decode, setDecode] = useState<DecodeState>({ status: "pending" });
  // The explicit consent gate: the exchange is committed only after the user
  // affirmatively checks this and provides a name (see commitAcceptance).
  const [consented, setConsented] = useState(false);
  const [acceptorName, setAcceptorName] = useState("");
  // The name, committed by an explicit "Accept and continue". Once set it seeds
  // the in-flight exchange and the consent controls are replaced by the running
  // Exchange, so the value that seeds it cannot drift.
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
    // exchange UI (which dials) renders only after consent on the "ready" branch,
    // so an expired or malformed invitation can never reach a rendezvous.
    void (async () => {
      try {
        const invitation = await prepareAcceptedInvitation(encoded);
        if (!controller.signal.aborted)
          setDecode({ status: "ready", invitation });
      } catch (err) {
        // The error parses a partner-supplied token, so its message or cause
        // chain can embed partner-controlled bytes (control/ANSI/deceptive
        // Unicode); route it through the display-boundary seam before it reaches
        // the alert, as the exchange's own failure alert does.
        if (!controller.signal.aborted)
          setDecode({ status: "error", message: sanitizeErrorForDisplay(err) });
      }
    })();
    return () => controller.abort();
  }, []);

  // Move focus to the invitation heading once decoding resolves to "ready" (or to
  // the error once it resolves to "error"), so a screen-reader/keyboard user is
  // taken to the revealed terms or the failure rather than left on the spinner
  // (mirrors InvitePanel's post-generate focus move).
  const readyHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (decode.status === "ready") readyHeadingRef.current?.focus();
    else if (decode.status === "error") errorRef.current?.focus();
  }, [decode.status]);

  const handleAccept = () => {
    // The authoritative consent gate: no name is committed -- and so no Exchange
    // mounts and nothing is dialed -- unless the user has consented and named
    // themselves.
    const name = commitAcceptance({ consented, name: acceptorName });
    if (name === undefined) return;
    // Only confirmedName seeds the exchange; the acceptorName field unmounts with
    // the consent controls on the next render, so writing the trimmed value back
    // to it would be unobservable.
    setConfirmedName(name);
  };

  const exchange =
    decode.status === "ready" && confirmedName !== undefined ? (
      // Keyed by the secret so it never persists across a different invitation;
      // the consent controls are unmounted while it runs, so the exchange
      // completes rather than being torn down by an edit. Reload the page to
      // start over.
      <Exchange
        key={decode.invitation.token.sharedSecret}
        role="acceptor"
        partyName={confirmedName}
        sharedSecret={decode.invitation.token.sharedSecret}
        endpoint={decode.invitation.endpoint}
      />
    ) : undefined;

  return (
    <Container size="sm" mt="md">
      <Paper>
        <Title order={2}>Accept an invitation</Title>
        <AcceptInvitationPanel
          decode={decode}
          headingRef={readyHeadingRef}
          errorRef={errorRef}
          consented={consented}
          onConsentedChange={setConsented}
          acceptorName={acceptorName}
          onAcceptorNameChange={setAcceptorName}
          onAccept={handleAccept}
          exchange={exchange}
        />
      </Paper>
    </Container>
  );
}
