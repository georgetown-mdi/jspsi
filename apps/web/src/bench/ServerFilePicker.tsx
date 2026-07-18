import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { IconAlertCircle, IconRefresh } from "@tabler/icons-react";

import { sanitizeForDisplay } from "@psilink/core";

import { fetchJobInputProfile, fetchJobInputs } from "@psi/workInputClient";

import { dateTimeLabel } from "./inviterModel";
import styles from "./bench.module.css";

import type {
  JobInputProfileResult,
  JobInputsResult,
  WorkInputReference,
} from "@psi/workInputClient";
import type { JobInputProfile } from "@jobs/workInputs";

/** Format a byte count for the file rows -- CLI-scale inputs reach gigabytes, so the
 * ladder runs to GB. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} B`;
}

/** Whether the committed file's on-disk size/mtime still match the profiled pair the
 * bench holds; a mismatch (or a vanished entry) is the authoring-time drift. */
function hasDrifted(
  committed: WorkInputReference,
  listing: JobInputsResult,
): boolean {
  if (listing.kind !== "listing") return false;
  const entry = listing.listing.files.find(
    (file) => file.name === committed.name,
  );
  return (
    entry === undefined ||
    entry.sizeBytes !== committed.sizeBytes ||
    entry.modifiedAt !== committed.modifiedAt
  );
}

/**
 * The console inviter's server-file intake: the two-stage picker over the
 * operator-mounted work-input directory ({@link fetchJobInputs}). The first stage
 * lists name/size/modified rows with a refresh control and distinct states for a
 * directory that is not configured, is empty, or holds only inadmissible entries
 * (dotfiles, directories, symlinks -- driven off `totalEntries` vs the admitted
 * count), plus the truncated flag. Selecting a row fetches the streaming profile
 * ({@link fetchJobInputProfile}) and shows a confirm panel -- columns, row count,
 * size, modified time, and a per-column sample peek -- with an explicit loading
 * state, since a pass over a CLI-scale file takes seconds. "Use this file" commits
 * the profile to the bench. A listing refresh compares the committed file's
 * size/mtime against the profiled snapshot and surfaces a drift notice prompting a
 * re-profile.
 */
export function ServerFilePicker({
  committed,
  onUse,
}: {
  /** The file currently committed to the bench (its profiled reference), so its row
   * is marked and an authoring-time drift is flagged on refresh. */
  committed: WorkInputReference | undefined;
  /** Commit a profiled file to the bench -- the second stage's "Use this file". */
  onUse: (profile: JobInputProfile) => void;
}) {
  const [listing, setListing] = useState<JobInputsResult | "loading">(
    "loading",
  );
  const [selectedName, setSelectedName] = useState<string>();
  const [profile, setProfile] = useState<JobInputProfileResult | "loading">();

  // A monotonic id per listing/profile fetch so a superseded resolution (a refresh
  // spam, or a second row picked mid-profile) falls on the floor instead of
  // clobbering the current state. `mounted` additionally drops a resolution that
  // lands after unmount, so no state update races the teardown.
  const listingId = useRef(0);
  const profileId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadListing = useCallback(async () => {
    const id = ++listingId.current;
    setListing("loading");
    const result = await fetchJobInputs();
    if (mounted.current && id === listingId.current) setListing(result);
  }, []);

  useEffect(() => {
    void loadListing();
  }, [loadListing]);

  const selectFile = useCallback(async (name: string) => {
    const id = ++profileId.current;
    setSelectedName(name);
    setProfile("loading");
    const result = await fetchJobInputProfile(name);
    if (mounted.current && id === profileId.current) setProfile(result);
  }, []);

  function cancelSelection() {
    profileId.current += 1;
    setSelectedName(undefined);
    setProfile(undefined);
  }

  function useProfiled(profiled: JobInputProfile) {
    onUse(profiled);
    cancelSelection();
  }

  const drifted =
    committed !== undefined &&
    listing !== "loading" &&
    hasDrifted(committed, listing);

  const driftNotice = drifted ? (
    <Alert
      color="orange"
      icon={<IconAlertCircle />}
      title="This file changed on disk since you profiled it"
    >
      <Stack gap="xs">
        <Text size="sm">
          The exchange will not run against content that changed after you
          profiled it. Re-profile{" "}
          <span className={styles.mono}>
            {sanitizeForDisplay(committed.name)}
          </span>{" "}
          to use its current version.
        </Text>
        <Group>
          <Button
            size="xs"
            variant="light"
            onClick={() => void selectFile(committed.name)}
          >
            Re-profile this file
          </Button>
        </Group>
      </Stack>
    </Alert>
  ) : null;

  return (
    <Stack gap="md" mt="md">
      {driftNotice}
      {selectedName !== undefined ? (
        <ConfirmPanel
          name={selectedName}
          profile={profile}
          onUse={useProfiled}
          onCancel={cancelSelection}
          onRetry={() => void selectFile(selectedName)}
        />
      ) : (
        <ListingView
          listing={listing}
          committed={committed}
          onRefresh={() => void loadListing()}
          onSelect={(name) => void selectFile(name)}
        />
      )}
    </Stack>
  );
}

/** The first-stage listing: the distinct configured/empty/inadmissible/list states
 * plus the refresh control and the truncated flag. */
function ListingView({
  listing,
  committed,
  onRefresh,
  onSelect,
}: {
  listing: JobInputsResult | "loading";
  committed: WorkInputReference | undefined;
  onRefresh: () => void;
  onSelect: (name: string) => void;
}) {
  const refreshButton = (
    <Button
      size="xs"
      variant="default"
      leftSection={<IconRefresh size={14} aria-hidden />}
      onClick={onRefresh}
    >
      Refresh
    </Button>
  );

  if (listing === "loading")
    return (
      <Group gap="xs">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          Loading files from the appliance...
        </Text>
      </Group>
    );

  if (listing.kind === "busy")
    return (
      <Stack gap="sm">
        <Alert color="yellow" icon={<IconAlertCircle />} title="Appliance busy">
          The appliance is finishing another file operation. Try again in a
          moment.
        </Alert>
        {refreshButton}
      </Stack>
    );

  if (listing.kind === "error")
    return (
      <Stack gap="sm">
        <Alert
          color="red"
          icon={<IconAlertCircle />}
          title="Could not list the work directory"
        >
          The appliance did not return a file listing. Check that the job API is
          reachable, then try again.
        </Alert>
        {refreshButton}
      </Stack>
    );

  const { configured, totalEntries, truncated, files } = listing.listing;

  if (!configured)
    return (
      <Alert
        color="blue"
        icon={<IconAlertCircle />}
        title="No work directory is configured"
      >
        <Stack gap="xs">
          <Text size="sm">
            Set the <span className={styles.mono}>JOB_INPUT_DIR</span>{" "}
            environment variable to a directory and mount that directory into
            this appliance, then refresh. Input CSVs placed there become
            selectable here.
          </Text>
          {refreshButton}
        </Stack>
      </Alert>
    );

  if (files.length === 0)
    return (
      <Stack gap="sm">
        <Alert
          color="blue"
          icon={<IconAlertCircle />}
          title={
            totalEntries === 0
              ? "The work directory is empty"
              : "No usable files in the work directory"
          }
        >
          {totalEntries === 0
            ? "Place your input CSV in this appliance's mounted work directory, then refresh."
            : "The work directory has entries, but none are usable input files. Directories, symbolic links, and dot-files are not listed. Place a plain CSV file there, then refresh."}
        </Alert>
        {refreshButton}
      </Stack>
    );

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="center">
        <Text fw={600}>Choose a file from the work directory</Text>
        {refreshButton}
      </Group>
      <Table
        highlightOnHover
        withRowBorders={false}
        aria-label="Work directory files"
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">Name</Table.Th>
            <Table.Th scope="col">Size</Table.Th>
            <Table.Th scope="col">Modified</Table.Th>
            <Table.Th scope="col" />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {files.map((file) => {
            const isCommitted = committed?.name === file.name;
            return (
              <Table.Tr key={file.name}>
                <Table.Td className={styles.mono}>
                  {sanitizeForDisplay(file.name)}{" "}
                  {isCommitted && (
                    <Badge size="xs" color="green" variant="light">
                      Selected
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td className={styles.mono}>
                  {formatBytes(file.sizeBytes)}
                </Table.Td>
                <Table.Td>{dateTimeLabel(new Date(file.modifiedAt))}</Table.Td>
                <Table.Td>
                  <Button
                    size="xs"
                    variant="light"
                    onClick={() => onSelect(file.name)}
                  >
                    {isCommitted ? "Re-profile" : "Select"}
                  </Button>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      {truncated && (
        <Text size="sm" c="dimmed">
          Showing the first {files.length} files; more are present in the work
          directory. Narrow the directory to see the rest.
        </Text>
      )}
    </Stack>
  );
}

/** The second-stage confirm panel: the profile with its explicit loading state, the
 * per-column sample peek, and the "Use this file" commit. */
function ConfirmPanel({
  name,
  profile,
  onUse,
  onCancel,
  onRetry,
}: {
  name: string;
  profile: JobInputProfileResult | "loading" | undefined;
  onUse: (profile: JobInputProfile) => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const sampleRows = useMemo(() => {
    if (profile === undefined || profile === "loading") return [];
    if (profile.kind !== "profile") return [];
    return profile.profile.columns.map((column) => ({
      column,
      values: profile.profile.columnSamples[column] ?? [],
    }));
  }, [profile]);

  if (profile === undefined || profile === "loading")
    return (
      <Stack gap="sm">
        <Group gap="xs">
          <Loader size="sm" />
          <Text size="sm">
            Profiling{" "}
            <span className={styles.mono}>{sanitizeForDisplay(name)}</span>...
          </Text>
        </Group>
        <Text size="sm" c="dimmed">
          The appliance reads the whole file to count rows and sample columns.
          For a large file this can take several seconds.
        </Text>
        <Group>
          <Button variant="default" size="xs" onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      </Stack>
    );

  if (profile.kind === "busy")
    return (
      <Stack gap="sm">
        <Alert color="yellow" icon={<IconAlertCircle />} title="Appliance busy">
          The appliance is finishing another file operation. Try profiling this
          file again in a moment.
        </Alert>
        <Group>
          <Button variant="light" size="xs" onClick={onRetry}>
            Try again
          </Button>
          <Button variant="default" size="xs" onClick={onCancel}>
            Choose another file
          </Button>
        </Group>
      </Stack>
    );

  if (profile.kind !== "profile")
    return (
      <Stack gap="sm">
        <Alert
          color="red"
          icon={<IconAlertCircle />}
          title="Could not profile this file"
        >
          The appliance could not read this file. It may have been removed or
          replaced since the listing. Refresh the file list and try another.
        </Alert>
        <Group>
          <Button variant="default" size="xs" onClick={onCancel}>
            Back to the file list
          </Button>
        </Group>
      </Stack>
    );

  const profiled = profile.profile;
  return (
    <Stack gap="sm">
      <Text fw={600}>Confirm this file</Text>
      <Table withRowBorders={false} aria-label="File profile">
        <Table.Tbody>
          <Table.Tr>
            <Table.Th scope="row">File</Table.Th>
            <Table.Td className={styles.mono}>
              {sanitizeForDisplay(profiled.name)}
            </Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Th scope="row">Rows</Table.Th>
            <Table.Td>
              {new Intl.NumberFormat("en-US").format(profiled.rowCount)}
            </Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Th scope="row">Size</Table.Th>
            <Table.Td className={styles.mono}>
              {formatBytes(profiled.sizeBytes)}
            </Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Th scope="row">Modified</Table.Th>
            <Table.Td>{dateTimeLabel(new Date(profiled.modifiedAt))}</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Th scope="row">Columns</Table.Th>
            <Table.Td className={styles.mono}>
              {profiled.columns
                .map((column) => sanitizeForDisplay(column))
                .join(", ")}
            </Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
      <Text fw={600} size="sm">
        Sample values
      </Text>
      <Table withRowBorders={false} aria-label="Column samples">
        <Table.Tbody>
          {sampleRows.map(({ column, values }) => (
            <Table.Tr key={column}>
              <Table.Th scope="row" className={styles.mono}>
                {sanitizeForDisplay(column)}
              </Table.Th>
              <Table.Td className={styles.mono}>
                {values.length === 0
                  ? "(no sample values)"
                  : values.map((value) => sanitizeForDisplay(value)).join(", ")}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Group>
        <Button onClick={() => onUse(profiled)}>Use this file</Button>
        <Button variant="default" onClick={onCancel}>
          Choose another file
        </Button>
      </Group>
    </Stack>
  );
}
