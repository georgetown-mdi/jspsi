import { useEffect, useRef, useState } from "react";

import {
  ActionIcon,
  Alert,
  Button,
  Code,
  CopyButton,
  Divider,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useForm } from "@tanstack/react-form";

import { generateInvitation } from "@psi/invitation";

import { Exchange } from "@components/Exchange";

import type { GeneratedInvitation, InvitationLocation } from "@psi/invitation";

/** Upper bound on the inviter's name. It flows into the token's linkage terms
 * and so into the encoded invitation and its deep-link URL; bounding it keeps the
 * shared artifact a sensible length rather than letting an arbitrarily long name
 * produce an unwieldy, possibly over-long link. */
const MAX_INVITER_NAME_LENGTH = 200;

/** This page's location, in the shape {@link generateInvitation} consumes. It
 * reads `window`, so it must be called from a client-side path; it throws rather
 * than return a wrong value if ever reached during SSR, since there is no
 * sensible server-side location. The sole caller is the submit handler, an event
 * that cannot fire during render. */
function invitationLocation(): InvitationLocation {
  if (typeof window === "undefined")
    throw new Error("invitationLocation must be called in the browser");
  return {
    origin: window.location.origin,
    hostname: window.location.hostname,
    port: window.location.port,
  };
}

/** A labelled, copy-to-clipboard view of one shareable artifact. It is only ever
 * rendered on the client -- behind the `invitation` state guard at its call site,
 * which starts `undefined` and is set only in an event handler, so CopyRow is
 * absent from the server render and never participates in hydration. The
 * `typeof navigator` check is defence-in-depth (and hides the button on
 * non-secure origins, where `navigator.clipboard` is undefined), not the SSR
 * safety mechanism -- that is the call-site guard. */
function CopyRow({
  label,
  description,
  value,
}: {
  label: string;
  description: string;
  value: string;
}) {
  return (
    <Stack gap={2}>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      <Text size="xs" c="dimmed">
        {description}
      </Text>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Code block style={{ flex: 1, overflowWrap: "anywhere" }}>
          {value}
        </Code>
        {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          typeof navigator !== "undefined" && navigator.clipboard ? (
            <CopyButton value={value} timeout={1000}>
              {({ copied, copy }) => (
                <Tooltip
                  label={copied ? "Copied" : "Copy to clipboard"}
                  // Open on keyboard focus too, not hover only, so keyboard
                  // users get the same affordance.
                  events={{ hover: true, focus: true, touch: true }}
                >
                  <ActionIcon
                    onClick={copy}
                    variant={copied ? "light" : "filled"}
                    // Name reflects the copied state so a screen reader announces
                    // the success (the icon/tooltip change alone is not conveyed
                    // to assistive tech).
                    aria-label={
                      copied ? `${label} copied` : `Copy ${label.toLowerCase()}`
                    }
                  >
                    {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          ) : null
        }
      </Group>
    </Stack>
  );
}

/** A generated invitation together with the inviter name that produced it. The
 * name is the inviter's own identity in the exchange below, and the secret seeds
 * the rendezvous peer id the inviter listens on. */
interface InviterSession {
  invitation: GeneratedInvitation;
  inviterName: string;
}

export function InvitePanel() {
  const [session, setSession] = useState<InviterSession>();
  const [error, setError] = useState<string>();

  // Move focus to the result heading once an invitation is generated, so a
  // screen-reader / keyboard user is taken to the output rather than left on the
  // button with the new region announced only if they happen to explore for it.
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (session) resultHeadingRef.current?.focus();
  }, [session]);

  const form = useForm({
    defaultValues: { inviterName: "" },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const inviterName = value.inviterName.trim();
      try {
        // A fresh secret each time, so generating again supersedes any prior
        // unsent invitation -- a new secret means a new derived rendezvous id,
        // and one invitation is not expected to back more than one exchange.
        const invitation = await generateInvitation({
          inviterName,
          location: invitationLocation(),
        });
        setSession({ invitation, inviterName });
      } catch (e) {
        setSession(undefined);
        // generateInvitation only fails on internal, non-user-actionable errors
        // (a schema ZodError, an SSR misuse). Show a fixed message rather than
        // the raw error: a raw ZodError dump is unhelpful, and not echoing error
        // internals into a secret-bearing flow keeps a future Zod version that
        // embeds a failing field's value out of the UI. Log only the error type.
        console.error(
          "invitation generation failed:",
          e instanceof Error ? e.name : typeof e,
        );
        setError("Could not generate the invitation. Please try again.");
      }
    },
  });

  return (
    <Paper>
      <Title order={2}>Invite someone to join you in a data exchange</Title>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <Stack>
          <form.Field
            name="inviterName"
            validators={{
              onChange: ({ value }) =>
                !value.trim() ? "Your name is required" : undefined,
            }}
            children={({ state, handleChange, handleBlur }) => (
              <TextInput
                value={state.value}
                onChange={(e) => handleChange(e.target.value)}
                onBlur={handleBlur}
                error={
                  // Show the required-name error once the user has left the field
                  // (isBlurred) or attempted a submit (submissionAttempts) -- not
                  // on every keystroke. The submit case matters for a
                  // whitespace-only name: it passes the native `required` check
                  // (non-empty) but fails this validator, so without the submit
                  // guard the error would never appear and the click would do
                  // nothing visible.
                  (state.meta.isBlurred || form.state.submissionAttempts > 0) &&
                  state.meta.errors.length > 0
                    ? state.meta.errors.join(", ")
                    : undefined
                }
                // Announce the error when it appears (Mantine's error node is
                // otherwise a silent <p>); the input already gets aria-invalid
                // and aria-describedby automatically.
                errorProps={{ role: "alert" }}
                maxLength={MAX_INVITER_NAME_LENGTH}
                withAsterisk
                required
                label="Your name"
                description="Recorded in the invitation's linkage terms so your partner can identify you"
                placeholder="Your name"
              />
            )}
          />
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Button
                type="submit"
                loading={isSubmitting}
                disabled={isSubmitting}
              >
                {session ? "Generate a new invitation" : "Generate invitation"}
              </Button>
            )}
          </form.Subscribe>
          {error && (
            <Alert color="red" title="Could not generate invitation">
              {error}
            </Alert>
          )}
        </Stack>
      </form>

      {session && (
        <Stack mt="md">
          <Title order={3} ref={resultHeadingRef} tabIndex={-1}>
            Share this invitation
          </Title>
          <Text size="sm" c="dimmed">
            Send one of these to your partner over a trusted channel (for
            example, secure email). It carries a one-time secret, so treat it as
            confidential and do not post it publicly. Generating a new
            invitation replaces this one.
          </Text>
          <CopyRow
            label="Invitation link"
            description="Opens the accept page with the invitation prefilled"
            value={session.invitation.deepLink}
          />
          <CopyRow
            label="Invitation code"
            description="Paste into the accept form if the link cannot be used"
            value={session.invitation.encoded}
          />

          <Divider
            my="sm"
            label="Then run the exchange"
            labelPosition="center"
          />
          <Text size="sm" c="dimmed">
            Choose your data file and start. Your browser waits for your partner
            to accept the invitation and connect; keep this tab open.
          </Text>
          {/* A fresh secret per invitation keys a fresh exchange, so remounting
              on regenerate (keyed by the secret) resets the file/stage state. */}
          <Exchange
            key={session.invitation.sharedSecret}
            role="inviter"
            partyName={session.inviterName}
            sharedSecret={session.invitation.sharedSecret}
            expires={session.invitation.expires}
          />
        </Stack>
      )}
    </Paper>
  );
}
