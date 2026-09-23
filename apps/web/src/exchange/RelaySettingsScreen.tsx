import { useState } from "react";

import { Alert, Anchor, Button, Group, Stack, Textarea } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import {
  parseRelayUrlLines,
  readOwnRelaySetting,
  writeOwnRelaySetting,
} from "@psi/transport/ownRelaySetting";
import styles from "@styles/app.module.css";

import { WorkShell } from "./WorkShell";

import type { RelayUrlLines } from "@psi/transport/ownRelaySetting";

/**
 * What the relay's operator learns, shown beside the setting and stated in
 * docs/COMMUNICATION.md and docs/SHARED_RESPONSIBILITY.md.
 */
export const RELAY_OPERATOR_DISCLOSURE =
  "Whoever runs the relay learns the network address of each party to every " +
  "exchange that uses it, whether or not any traffic is relayed: your browser " +
  "reserves an address on the relay while it gathers connection candidates, " +
  "before it knows whether a direct connection will work. The relay forwards " +
  "encrypted traffic only and cannot read the exchange.";

/**
 * What the relay must hold for each run's credential, shown in the page's
 * opening paragraph and stated in docs/COMMUNICATION.md.
 */
export const RELAY_KEY_NOTICE =
  "Each exchange signs in to the relay with a credential derived from that " +
  "exchange's current shared secret and valid for at most one hour, so the " +
  "relay must hold the key derived from the current secret. The shared secret " +
  "changes after every successful run and this app does not register each " +
  "run's key with the relay itself, so a recurring exchange through your " +
  "relay needs its key registered with the relay again after each run.";

/** The field error for one list's parse, or `undefined` when it parsed. */
function fieldError(lines: RelayUrlLines): string | undefined {
  if (lines.ok) return undefined;
  return lines.problems
    .map((problem) =>
      problem.line === undefined
        ? problem.message
        : `Line ${problem.line}: ${problem.message}`,
    )
    .join("; ");
}

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saved" }
  | { kind: "removed" }
  | { kind: "failed" };

/**
 * The relay settings page: this browser's own TURN and STUN urls, kept in
 * browser storage for this site, with what the relay's operator learns stated
 * beside them. The hosted app and a console each hold their own.
 */
export function RelaySettingsScreen() {
  const [initial] = useState(readOwnRelaySetting);
  const [turnText, setTurnText] = useState(
    initial.kind === "set" ? initial.relay.turn.join("\n") : "",
  );
  const [stunText, setStunText] = useState(
    initial.kind === "set" ? initial.relay.stun.join("\n") : "",
  );
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });

  const turnLines = parseRelayUrlLines(turnText, "turn");
  const stunLines = parseRelayUrlLines(stunText, "stun");
  const turnError = attempted ? fieldError(turnLines) : undefined;
  const stunError = attempted ? fieldError(stunLines) : undefined;

  function save() {
    setAttempted(true);
    if (!turnLines.ok || !stunLines.ok) {
      setStatus({ kind: "idle" });
      return;
    }
    try {
      writeOwnRelaySetting({ turn: turnLines.urls, stun: stunLines.urls });
      setStatus({
        kind:
          turnLines.urls.length + stunLines.urls.length > 0
            ? "saved"
            : "removed",
      });
    } catch {
      setStatus({ kind: "failed" });
    }
  }

  function remove() {
    try {
      writeOwnRelaySetting({ turn: [], stun: [] });
      setTurnText("");
      setStunText("");
      setAttempted(false);
      setStatus({ kind: "removed" });
    } catch {
      setStatus({ kind: "failed" });
    }
  }

  return (
    <WorkShell>
      <h1>Relay server</h1>
      <p className={`${styles.small} ${styles.sub}`}>
        When a direct connection to your partner cannot be made, your browser
        can connect through a TURN relay your side runs. Enter the relay&apos;s
        addresses here. They are kept in this browser for this site only.{" "}
        {RELAY_KEY_NOTICE}
      </p>

      <h2>What the relay&apos;s operator learns</h2>
      <p>{RELAY_OPERATOR_DISCLOSURE}</p>

      {initial.kind === "unreadable" && status.kind === "idle" && (
        <Alert color="yellow" title="The saved relay could not be read">
          Exchanges in this browser use no relay until it is saved again. Enter
          the relay&apos;s addresses and save.
        </Alert>
      )}

      <Stack gap="md" mt="md">
        <Textarea
          label="TURN server urls"
          description="One per line, for example turns:relay.example.org:443?transport=tcp"
          autosize
          minRows={2}
          value={turnText}
          error={turnError}
          errorProps={{ role: "alert" }}
          onChange={(event) => {
            setTurnText(event.currentTarget.value);
            setStatus({ kind: "idle" });
          }}
        />
        <Textarea
          label="STUN server urls"
          description="One per line; left empty, a saved TURN relay is used with no STUN server. For example: stun:stun.example.org:3478"
          autosize
          minRows={2}
          value={stunText}
          error={stunError}
          errorProps={{ role: "alert" }}
          onChange={(event) => {
            setStunText(event.currentTarget.value);
            setStatus({ kind: "idle" });
          }}
        />
      </Stack>

      <div className={styles.workFoot}>
        <Group>
          <Button onClick={save}>Save</Button>
          <Button variant="outline" onClick={remove}>
            Remove relay
          </Button>
        </Group>
        <p className={styles.statusLine} role="status">
          {status.kind === "saved" &&
            "Saved. Exchanges started from now on use this relay."}
          {status.kind === "removed" &&
            "No relay is set. Exchanges connect without one."}
          {status.kind === "failed" &&
            "This browser did not save the setting. Check that site storage is allowed for this site, then save again."}
        </p>
      </div>

      <p className={`${styles.small} ${styles.sub}`}>
        <Anchor inherit component={Link} to="/">
          Back to the start page
        </Anchor>
      </p>
    </WorkShell>
  );
}
