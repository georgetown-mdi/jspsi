import { useCallback, useEffect, useRef, useState } from "react";

import {
  Anchor,
  Badge,
  Button,
  Group,
  Stack,
  Table,
  Text,
  VisuallyHidden,
} from "@mantine/core";

import { sanitizeForDisplay } from "@psilink/core";

import { fetchSecretsEntries } from "@psi/sftpAuthoringClient";

import { MountLoading, MountStateNotice, RefreshButton } from "./mountListing";
import { breadcrumbTrail, enterSubdir, fileSubPath } from "./mountNavigation";
import styles from "./bench.module.css";

import type { SecretsEntriesResult } from "@psi/sftpAuthoringClient";

/** The mount-root breadcrumb label. */
const ROOT_LABEL = "secrets";

/** The settle copy for the aria-live status region. */
function secretsLiveMessage(listing: SecretsEntriesResult | "loading"): string {
  if (listing === "loading") return "";
  if (listing.kind === "disabled")
    return "The job API is disabled on this appliance.";
  if (listing.kind === "error")
    return "The secrets directory could not be read.";
  if (!listing.configured)
    return "No secrets directory is configured on this appliance.";
  if (!listing.readable) return "This directory could not be read.";
  if (listing.entries.length === 0) return "This directory is empty.";
  return `Loaded ${listing.entries.length} ${listing.entries.length === 1 ? "entry" : "entries"}.`;
}

/**
 * The console's credential-file picker: a navigable browse of the operator-mounted
 * secrets directory ({@link fetchSecretsEntries}). It lists the directory's
 * subdirectories and files, descends into a `dir` entry (breadcrumb to go back),
 * and yields a `{ mount: "secrets", subPath }` locator when the operator picks a
 * `file` -- the server later resolves that locator to an absolute `@path`, so no
 * container-absolute path is ever shown or sent. No file bytes are read; this is a
 * name browse only (SSH key material and password files, not profiled).
 *
 * A missing or unreadable secrets mount reads as a named config gap (name
 * `JOB_SECRETS_DIR`), not a dead end, reusing the shared listing-shell discipline
 * ({@link MountStateNotice}). A polite status region announces each settle and
 * focus follows a navigation so a screen-reader user is not stranded.
 */
export function SecretsFilePicker({
  onSelect,
}: {
  /** Commit a picked credential file's locator subPath (the directory segments
   * plus the file name). */
  onSelect: (subPath: Array<string>) => void;
}) {
  const [subPath, setSubPath] = useState<Array<string>>([]);
  const [listing, setListing] = useState<SecretsEntriesResult | "loading">(
    "loading",
  );

  // A monotonic id per fetch so a superseded resolution (a fast navigation or a
  // refresh spam) falls on the floor; `mounted` drops a resolution after unmount.
  const listingId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (path: Array<string>) => {
    const id = ++listingId.current;
    setListing("loading");
    const result = await fetchSecretsEntries(path);
    if (mounted.current && id === listingId.current) setListing(result);
  }, []);

  useEffect(() => {
    void load(subPath);
  }, [subPath, load]);

  // Focus the stage on a navigation settle so a screen-reader user is not stranded
  // on a control that unmounted; skipped on mount so initial focus stays put.
  const stageRef = useRef<HTMLDivElement>(null);
  const stageMounted = useRef(false);
  useEffect(() => {
    if (stageMounted.current) stageRef.current?.focus();
    stageMounted.current = true;
  }, [subPath]);

  const refresh = useCallback(() => void load(subPath), [load, subPath]);

  return (
    <Stack gap="sm" mt="sm">
      <VisuallyHidden role="status" aria-live="polite">
        {secretsLiveMessage(listing)}
      </VisuallyHidden>
      <div ref={stageRef} tabIndex={-1} style={{ outline: "none" }}>
        {renderListing(listing, subPath, {
          onEnter: (name) => setSubPath(enterSubdir(subPath, name)),
          onNavigate: (next) => setSubPath(next),
          onSelect: (name) => onSelect(fileSubPath(subPath, name)),
          onRefresh: refresh,
        })}
      </div>
    </Stack>
  );
}

function renderListing(
  listing: SecretsEntriesResult | "loading",
  subPath: Array<string>,
  actions: {
    onEnter: (name: string) => void;
    onNavigate: (subPath: Array<string>) => void;
    onSelect: (name: string) => void;
    onRefresh: () => void;
  },
) {
  const refresh = <RefreshButton onRefresh={actions.onRefresh} />;

  if (listing === "loading")
    return <MountLoading message="Loading the secrets directory..." />;

  // The whole job API is off (JOB_DATA_ROOT unset): a stable config state, so it
  // reads as informational and names the variable to set.
  if (listing.kind === "disabled")
    return (
      <MountStateNotice
        color="blue"
        title="The job API is disabled on this appliance"
        action={refresh}
      >
        The job API is off because JOB_DATA_ROOT is not set, so this appliance
        cannot browse credential files. Set it to the mounted data root and
        restart the appliance -- see the{" "}
        <Anchor
          inherit
          href="https://github.com/georgetown-mdi/jspsi/blob/main/docs/DEPLOYMENT.md"
          target="_blank"
          rel="noreferrer"
        >
          deployment guide
        </Anchor>
        .
      </MountStateNotice>
    );

  if (listing.kind === "error")
    return (
      <MountStateNotice
        color="red"
        title="Could not read the secrets directory"
        action={refresh}
      >
        The appliance did not return a listing. Check that the job API is
        reachable, then try again.
      </MountStateNotice>
    );

  // An unset JOB_SECRETS_DIR means there is no separate secrets mount to browse.
  // It is not a dead end: the operator can still reference a credential file in
  // their mounted folder by typing an @-file reference. A separate read-only
  // secrets directory is recommended hardening, not a requirement.
  if (!listing.configured)
    return (
      <MountStateNotice
        color="blue"
        title="No separate secrets directory"
        action={refresh}
      >
        This appliance has no separate secrets directory to browse, so type a
        file reference below to a credential file (a password file or an SSH
        private key) in your mounted folder. For better isolation, mount a
        separate read-only directory as JOB_SECRETS_DIR and reference the file
        there instead, then restart the appliance.
      </MountStateNotice>
    );

  const trail = breadcrumbTrail(ROOT_LABEL, subPath);
  const breadcrumb = (
    <nav aria-label="Secrets directory path">
      <Group gap={4} align="center">
        {trail.map((crumb, index) => {
          const isCurrent = index === trail.length - 1;
          const label =
            index === 0 ? crumb.label : sanitizeForDisplay(crumb.label);
          return (
            <Group gap={4} key={index} align="center">
              {index > 0 && (
                <Text size="sm" c="dimmed" aria-hidden>
                  /
                </Text>
              )}
              {isCurrent ? (
                <Text size="sm" fw={600} className={styles.mono}>
                  {label}
                </Text>
              ) : (
                <Button
                  variant="subtle"
                  size="compact-sm"
                  className={styles.mono}
                  onClick={() => actions.onNavigate(crumb.subPath)}
                >
                  {label}
                </Button>
              )}
            </Group>
          );
        })}
      </Group>
    </nav>
  );

  // A configured-but-unreadable subdirectory: the breadcrumb still lets the
  // operator step back out, so it is not a dead end.
  if (!listing.readable)
    return (
      <Stack gap="sm">
        {breadcrumb}
        <MountStateNotice
          color="red"
          title="Could not read this directory"
          action={refresh}
        >
          This directory in the secrets mount could not be read. It may have
          been removed since the listing. Step back with the path above, or
          refresh.
        </MountStateNotice>
      </Stack>
    );

  if (listing.entries.length === 0)
    return (
      <Stack gap="sm">
        {breadcrumb}
        <MountStateNotice
          color="blue"
          title="This folder is empty"
          action={refresh}
        >
          This folder has no files or subdirectories. Step back with the path
          above and pick another, or place your credential file in the secrets
          mount and refresh.
        </MountStateNotice>
      </Stack>
    );

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="center">
        {breadcrumb}
        {refresh}
      </Group>
      <Table
        highlightOnHover
        withRowBorders={false}
        aria-label="Secrets directory entries"
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">Name</Table.Th>
            <Table.Th scope="col" />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {listing.entries.map((entry) => {
            const displayName = sanitizeForDisplay(entry.name);
            return (
              <Table.Tr key={entry.name}>
                <Table.Td className={styles.mono}>
                  {displayName}{" "}
                  {entry.kind === "dir" && (
                    <Badge size="xs" color="gray" variant="light">
                      Folder
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  {entry.kind === "dir" ? (
                    <Button
                      size="xs"
                      variant="default"
                      aria-label={`Open ${displayName}`}
                      onClick={() => actions.onEnter(entry.name)}
                    >
                      Open
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      variant="light"
                      aria-label={`Use ${displayName}`}
                      onClick={() => actions.onSelect(entry.name)}
                    >
                      Use this file
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
