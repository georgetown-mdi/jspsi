import { Alert, Anchor } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import { BenchShell } from "./BenchShell";

/**
 * Temporary bench screens shown while the real flows are built out, screen by
 * screen. Each states plainly that it is under construction and points back
 * to the current app, honoring the design's rule that an unshipped capability
 * is never presented as in force. Deleted as the real screens land.
 */

/** Stand-in for the acceptor path's entry screen. */
export function AcceptUnderConstruction() {
  return (
    <BenchShell>
      <h1>Accept an invitation</h1>
      <Alert color="yellow" title="Under construction" mt="md">
        The bench is the next version of psilink and this screen is not built
        yet: the acceptor path arrives after the inviter flow. To run an
        exchange today, use the{" "}
        <Anchor component={Link} to="/">
          current app
        </Anchor>
        .
      </Alert>
    </BenchShell>
  );
}
