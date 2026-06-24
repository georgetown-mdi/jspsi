import { useEffect, useRef, useState } from "react";

import { Paper, Title } from "@mantine/core";

import { describeDecodeError } from "@psilink/core";

import { commitAcceptance } from "@psi/acceptConsent";
import { prepareAcceptedInvitation } from "@psi/acceptInvitation";

import {
  clearAcceptHandoff,
  peekAcceptHandoff,
} from "@components/acceptHandoff";
import { AcceptInvitationPanel } from "@components/AcceptInvitationPanel";
import { EXCHANGE_READING_WIDTH } from "@components/contentWidth";
import { ExchangeView } from "@components/ExchangeView";
import { PrepareData } from "@components/PrepareData";

import type { AcquiredBundle, AlertContent } from "@components/FileAcquire";
import type { AcceptorDataEdits } from "@psi/acceptInvitation";
import type { DecodeState } from "@components/AcceptInvitationPanel";

/**
 * The post-consent flow for the accept route. The user reviews and accepts the
 * partner's terms and picks a file ("reviewing"), prepares their data in the
 * editor ("preparing"), then runs the exchange ("exchange"). Modeling it as one
 * discriminated union keeps the parsed bundle and the prepared metadata born and
 * discarded together: a phase that does not hold the bundle cannot run a stale
 * one, and re-acquiring re-enters "preparing" with a fresh bundle.
 */
type AcceptPhase =
  | { status: "reviewing" }
  | { status: "preparing"; name: string; bundle: AcquiredBundle }
  | {
      status: "exchange";
      name: string;
      bundle: AcquiredBundle;
      edits: AcceptorDataEdits;
      warning?: AlertContent;
    };

/**
 * The accept route's container: it decodes the invitation from the URL fragment,
 * holds the consent state, and drives the review -> prepare -> exchange flow in
 * place (terms + consent gate + CSV drop, then the "Prepare your data" editor,
 * then the shared {@link ExchangeView}). Kept as a component (rather than inline in
 * the route file) so it can be mounted and driven in a browser test without the
 * router.
 *
 * The flow is gated on consent: the review screen's "Accept and continue" is
 * disabled until consent and a name are given, and on a successful parse the
 * acquire handler re-checks {@link commitAcceptance} before advancing -- so no
 * rendezvous, key exchange, or PSI frame can be set up before consent. Past that
 * gate (and the prepare step) the exchange screen dials on arrival with no separate
 * Start press, since the user has already accepted and confirmed.
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
  // The post-consent phase: reviewing -> preparing -> exchange, with a back edge
  // preparing -> reviewing so the operator can pick a different file. Its presence
  // (anything past "reviewing") is the in-route transition off the review screen.
  const [phase, setPhase] = useState<AcceptPhase>({ status: "reviewing" });
  // The review-screen error (a CSV read failure): nothing is handed off, so the
  // user stays on the review screen to choose another file.
  const [acquireError, setAcquireError] = useState<AlertContent>();
  // The file the acceptor chose on the home page, if any, carried in memory across
  // the navigation (a File cannot ride the URL fragment the token occupies). Read
  // once with a pure peek (StrictMode-safe), and used only to pre-fill the acquire
  // dropzone -- the parse still runs behind the consent gate below.
  const [handoffFiles] = useState<Array<File> | undefined>(() => {
    const file = peekAcceptHandoff();
    return file ? [file] : undefined;
  });
  // Consume the hand-off once: clear the module stash so a later back/forward
  // navigation to /accept -- which does not pass through the home page's "Review
  // invitation" submit -- finds nothing and falls back to the dropzone's own
  // picker rather than re-seeding from this now-captured file. Latched so it runs
  // once across React StrictMode's double effect invoke; the file is already held
  // in `handoffFiles` (captured synchronously in the render initializer above), so
  // clearing the stash does not lose it.
  const handoffClearedRef = useRef(false);
  useEffect(() => {
    if (handoffClearedRef.current) return;
    handoffClearedRef.current = true;
    clearAcceptHandoff();
  }, []);
  // The hand-off seeds the acquire dropzone only on its FIRST mount. Once the
  // operator has acquired a file (handleAcquired), a later back edge
  // preparing -> reviewing re-mounts the acquire phase, and without this latch it
  // would re-seed the stale home-page file -- silently discarding whatever file the
  // operator chose in-route. After the first acquire we pass no seed, so the
  // re-mounted dropzone starts empty for a deliberate re-pick.
  const handoffConsumedRef = useRef(false);

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
  // (mirrors InvitePanel's post-generate focus move). Only while still reviewing;
  // the prepare and exchange screens own their own heading focus.
  const readyHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phase.status !== "reviewing") return;
    if (decode.status === "ready") readyHeadingRef.current?.focus();
    else if (decode.status === "error") errorRef.current?.focus();
  }, [decode.status, phase.status]);

  const handleAcquired = (bundle: AcquiredBundle) => {
    // The authoritative consent gate: no name is committed -- and so the prepare
    // editor never mounts -- unless the user has consented and named themselves.
    // The acquire phase already gates its submit on the same check
    // (submitDisabled), but re-check here so the security-relevant invariant does
    // not rest on the disabled state alone.
    const name = commitAcceptance({ consented, name: acceptorName });
    if (name === undefined) return;
    // The seed has now done its job; a back edge to reviewing must not resurrect it
    // over the file just acquired (see handoffConsumedRef).
    handoffConsumedRef.current = true;
    setPhase({ status: "preparing", name, bundle });
  };

  return (
    <Paper
      // Every decoded phase -- review, prepare, and exchange -- is a two-column
      // layout (the consent gate, the data editor, or the run's Status beside the
      // agreed-terms summary), so the panel fills the route's wide container. Only
      // the pre-decode states (the decode spinner and the bad/expired-invitation
      // error) stay a single reading column, capped to EXCHANGE_READING_WIDTH and
      // centered.
      style={
        decode.status === "ready"
          ? undefined
          : { width: EXCHANGE_READING_WIDTH, marginInline: "auto" }
      }
    >
      {/* A generic page h1 rather than the party-specific "Invitation from X"
          (which is the terms section's h2 on the review screen): it must read
          sensibly in the pending, error, prepare, and exchange states too. */}
      <Title order={1}>Accept an invitation</Title>
      {decode.status === "ready" && phase.status === "exchange" ? (
        // The exchange screen: the acceptor arrives pre-acquired (the parsed CSV)
        // and pre-prepared (the editor's metadata/standardization), and dials on
        // arrival (it consented and confirmed already, so no separate Start press).
        // Keyed by the secret so it never persists across a different invitation.
        // Reload to start over.
        <ExchangeView
          key={decode.invitation.token.sharedSecret}
          role="acceptor"
          partyName={phase.name}
          sharedSecret={decode.invitation.token.sharedSecret}
          expires={decode.invitation.token.expires}
          endpoint={decode.invitation.endpoint}
          linkageTerms={decode.invitation.token.linkageTerms}
          disclosedPayloadColumns={
            decode.invitation.token.disclosedPayloadColumns
          }
          acquired={phase.bundle}
          metadata={phase.edits.metadata}
          standardization={phase.edits.standardization}
          initialWarning={phase.warning}
        />
      ) : decode.status === "ready" && phase.status === "preparing" ? (
        // The "Prepare your data" editor: the operator maps columns and confirms
        // disclosure before the exchange. On launch it hands up the edited
        // metadata/standardization (and any partial-coverage advisory), which the
        // exchange screen threads into prepareForExchange.
        <PrepareData
          linkageTerms={decode.invitation.token.linkageTerms}
          disclosedPayloadColumns={
            decode.invitation.token.disclosedPayloadColumns
          }
          columns={phase.bundle.columns}
          rawRows={phase.bundle.rawRows}
          onBack={() => setPhase({ status: "reviewing" })}
          onLaunch={(edits, warning) =>
            setPhase({
              status: "exchange",
              name: phase.name,
              bundle: phase.bundle,
              edits,
              warning,
            })
          }
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
          initialFiles={handoffConsumedRef.current ? undefined : handoffFiles}
          error={acquireError}
          onAcquireError={setAcquireError}
          onAcquired={handleAcquired}
        />
      )}
    </Paper>
  );
}
