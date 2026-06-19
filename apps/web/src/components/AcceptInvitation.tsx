import { useEffect, useRef, useState } from "react";

import { Paper, Title } from "@mantine/core";

import { describeDecodeError } from "@psilink/core";

import { commitAcceptance } from "@psi/acceptConsent";
import { prepareAcceptedInvitation } from "@psi/acceptInvitation";

import { AcceptInvitationPanel } from "@components/AcceptInvitationPanel";
import { ExchangeView } from "@components/ExchangeView";

import type { AcquiredBundle, AlertContent } from "@components/FileAcquire";
import type { DecodeState } from "@components/AcceptInvitationPanel";

/**
 * The accept route's container: it decodes the invitation from the URL fragment,
 * holds the consent state, and runs the review screen (terms + consent gate + CSV
 * drop) before transitioning in-route to the shared {@link ExchangeView}. Kept as
 * a component (rather than inline in the route file) so it can be mounted and
 * driven in a browser test without the router.
 *
 * The transition is gated on consent: the review screen's "Accept and continue"
 * is disabled until consent and a name are given, and on a satisfiable file the
 * acquire handler re-checks {@link commitAcceptance} before mounting the exchange
 * screen -- so no rendezvous, key exchange, or PSI frame can be set up before
 * consent, and the dialing exchange waits for the user's explicit Start there.
 *
 * The content width (the wider reading width the dense terms want) is declared by
 * the route and supplied by the shell's container, so this page renders only its
 * content -- no `Container` of its own.
 */
export function AcceptInvitation() {
  const [decode, setDecode] = useState<DecodeState>({ status: "pending" });
  // The explicit consent gate: the exchange is committed only after the user
  // affirmatively checks this and provides a name (see commitAcceptance).
  const [consented, setConsented] = useState(false);
  const [acceptorName, setAcceptorName] = useState("");
  // The committed acceptance: the name to record and the CSV the review screen
  // parsed and pre-flighted. Set only after consent + a satisfiable file, its
  // presence is the in-route transition to the exchange screen.
  const [accepted, setAccepted] = useState<{
    name: string;
    acquired: AcquiredBundle;
  }>();
  // The review-screen error (a CSV read failure or a zero-coverage pre-flight
  // block): on a block nothing is handed off, so the user stays on the review
  // screen to choose another file.
  const [acquireError, setAcquireError] = useState<AlertContent>();
  // The partial-coverage advisory the pre-flight raises, carried to the exchange
  // screen so it stays visible through the run (ExchangeView keeps it on success
  // and clears it on a run failure). Set alongside the handoff on partial
  // coverage; cleared by the pre-flight at the start of each attempt.
  const [acquireWarning, setAcquireWarning] = useState<AlertContent>();

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

  const handleAcquired = (bundle: AcquiredBundle) => {
    // The authoritative consent gate: no name is committed -- and so no
    // ExchangeView mounts and nothing is dialed -- unless the user has consented
    // and named themselves. The acquire phase already gates its submit on the
    // same check (submitDisabled), but re-check here so the security-relevant
    // invariant does not rest on the disabled state alone.
    const name = commitAcceptance({ consented, name: acceptorName });
    if (name === undefined) return;
    setAccepted({ name, acquired: bundle });
  };

  return (
    <Paper>
      {/* A generic page h1 rather than the party-specific "Invitation from X"
          (which is the terms section's h2 on the review screen): it must read
          sensibly in the pending, error, and exchange states too. */}
      <Title order={1}>Accept an invitation</Title>
      {decode.status === "ready" && accepted !== undefined ? (
        // The exchange screen: the acceptor arrives pre-acquired (the parsed CSV)
        // and dials only on the explicit Start ExchangeView renders. Keyed by the
        // secret so it never persists across a different invitation. Reload the
        // page to start over.
        <ExchangeView
          key={decode.invitation.token.sharedSecret}
          role="acceptor"
          partyName={accepted.name}
          sharedSecret={decode.invitation.token.sharedSecret}
          expires={decode.invitation.token.expires}
          endpoint={decode.invitation.endpoint}
          linkageTerms={decode.invitation.token.linkageTerms}
          acquired={accepted.acquired}
          initialWarning={acquireWarning}
        />
      ) : (
        <AcceptInvitationPanel
          decode={decode}
          headingRef={readyHeadingRef}
          errorRef={errorRef}
          consented={consented}
          onConsentedChange={setConsented}
          acceptorName={acceptorName}
          onAcceptorNameChange={setAcceptorName}
          error={acquireError}
          onAcquireError={setAcquireError}
          onAcquireWarning={setAcquireWarning}
          onAcquired={handleAcquired}
        />
      )}
    </Paper>
  );
}
