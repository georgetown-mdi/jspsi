import { useEffect, useRef, useState } from "react";

import { Container, Paper, Title } from "@mantine/core";

import { describeDecodeError } from "@psilink/core";

import { commitAcceptance } from "@psi/acceptConsent";
import { prepareAcceptedInvitation } from "@psi/acceptInvitation";

import { AcceptInvitationPanel } from "@components/AcceptInvitationPanel";
import { Exchange } from "@components/Exchange";

import type { DecodeState } from "@components/AcceptInvitationPanel";

/**
 * The accept route's container: it decodes the invitation from the URL fragment,
 * holds the consent state, and gates the dialing {@link Exchange} behind explicit
 * consent. Kept as a component (rather than inline in the route file) so it can be
 * mounted and driven in a browser test without the router.
 */
export function AcceptInvitation() {
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
    // Abort on unmount so a resolving decode does not setState after teardown.
    const controller = new AbortController();
    // Decode, check expiry, and require a WebRTC endpoint BEFORE any connect: the
    // exchange UI (which dials) renders only after consent on the "ready" branch,
    // so an expired or malformed invitation can never reach a rendezvous.
    void (async () => {
      try {
        const invitation = await prepareAcceptedInvitation(encoded);
        if (!controller.signal.aborted)
          setDecode({ status: "ready", invitation });
      } catch (err) {
        // A schema-validation failure throws a ZodError whose raw `.message` is a
        // multi-line issues blob; collapse it to a readable one-liner (and let a
        // plain checksum/JSON/base64 Error pass its message through) via the same
        // describeDecodeError the CLI uses. The helper escapes every path
        // component it interpolates -- a Zod path can name a partner-controlled
        // object key in the general case -- so it is the display-boundary seam
        // here and needs no further wrapping pass (which would double-escape
        // those components).
        if (!controller.signal.aborted)
          setDecode({ status: "error", message: describeDecodeError(err) });
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
        expires={decode.invitation.token.expires}
        endpoint={decode.invitation.endpoint}
        linkageTerms={decode.invitation.token.linkageTerms}
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
