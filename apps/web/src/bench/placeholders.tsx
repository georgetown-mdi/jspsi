import { Alert, Anchor } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import { Rail, RailFacts, RailGroup, RailSteps } from "./Rail";
import { BenchShell } from "./BenchShell";
import { Ledger } from "./Ledger";
import styles from "./bench.module.css";

/**
 * Temporary bench screens shown while the real flows are built out, screen by
 * screen. Each states plainly that it is under construction and points back
 * to the current app, honoring the design's rule that an unshipped capability
 * is never presented as in force. Deleted as the real screens land.
 */

function UnderConstructionNotice({ flow }: { flow: string }) {
  return (
    <Alert color="yellow" title="Under construction" mt="md">
      The bench is the next version of psilink and this screen is not built yet:{" "}
      {flow} To run an exchange today, use the{" "}
      <Anchor component={Link} to="/">
        current app
      </Anchor>
      .
    </Alert>
  );
}

/**
 * Stand-in for the inviter flow's first spine screen. Renders the real rail
 * and ledger so the bench's three-region surface is exercised end to end
 * before the work column has content.
 */
export function ExchangeUnderConstruction() {
  return (
    <BenchShell
      rail={
        <Rail label="Exchange setup">
          <RailGroup label="Set up">
            <RailSteps
              steps={[
                { label: "Your file", state: "current" },
                { label: "Matching & sharing", state: "pending" },
                { label: "Review & create", state: "pending" },
              ]}
            />
          </RailGroup>
          <RailGroup label="Customize" note="Filled in from your file.">
            <RailFacts
              facts={[
                { label: "Cleaning" },
                { label: "Matching keys" },
                { label: "Legal agreement" },
              ]}
            />
          </RailGroup>
        </Rail>
      }
      ledger={
        <Ledger
          rows={[
            { label: "You will send", reference: "Step 2" },
            { label: "You will receive" },
            { label: "Matched on", reference: "Step 2" },
            { label: "Expires", reference: "Step 3" },
            { label: "Results go to", reference: "Step 3" },
            { label: "Agreement" },
            { label: "Transport", reference: "Step 3" },
          ]}
          footer="Fills in as the exchange takes shape - the standing answer to what leaves this machine."
        />
      }
    >
      <p className={styles.eyebrow}>Step 1 of 3</p>
      <h1>Your file</h1>
      <UnderConstructionNotice flow="the inviter flow arrives with the bench's spine screens." />
    </BenchShell>
  );
}

/** Stand-in for the acceptor path's entry screen. */
export function AcceptUnderConstruction() {
  return (
    <BenchShell>
      <h1>Accept an invitation</h1>
      <UnderConstructionNotice flow="the acceptor path arrives after the inviter flow." />
    </BenchShell>
  );
}
