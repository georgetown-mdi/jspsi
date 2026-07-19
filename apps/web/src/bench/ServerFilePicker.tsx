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
  VisuallyHidden,
} from "@mantine/core";
import { IconAlertCircle, IconRefresh } from "@tabler/icons-react";

import { sanitizeForDisplay } from "@psilink/core";

import { fetchJobInputProfile, fetchJobInputs } from "@psi/workInputClient";

import { byteSizeLabel, dateTimeLabel } from "./inviterModel";
import styles from "./bench.module.css";

import type {
  JobInputProfileResult,
  JobInputProfileUnavailableReason,
  JobInputsResult,
  ProfiledJobInput,
  WorkInputReference,
} from "@psi/workInputClient";

/** The picker's per-reason copy for a profile that could not be read: a title and a
 * body, so each distinct failure names what to fix instead of one generic "removed or
 * replaced". */
const PROFILE_UNAVAILABLE_COPY: Record<
  JobInputProfileUnavailableReason,
  { title: string; body: string }
> = {
  not_found: {
    title: "This file is no longer in the work directory",
    body: "It may have been removed or replaced since the listing. Refresh the file list and try another.",
  },
  too_large: {
    title: "This file is too large to read",
    body: "It has a header, field, or line beyond the size this can read. Check that it is a normal CSV, then try another.",
  },
  not_a_csv: {
    title: "This does not look like a CSV",
    body: "It has no columns to read -- it may be empty or may not be a CSV. Choose a CSV file with a header row.",
  },
  parse_failed: {
    title: "Could not read this file as a CSV",
    body: "The appliance could not parse it. Check that it is a valid CSV, then try another.",
  },
  unknown: {
    title: "Could not profile this file",
    body: "The appliance could not read this file. Refresh the file list and try again.",
  },
};

/** The listing settle copy for the aria-live status region. */
function listingLiveMessage(listing: JobInputsResult | "loading"): string {
  if (listing === "loading") return "";
  if (listing.kind === "error") return "The file listing could not be loaded.";
  const { files, configured, readable } = listing.listing;
  if (!configured) return "No work directory is configured on this appliance.";
  if (!readable) return "The work directory could not be read.";
  if (files.length === 0) return "No usable files in the work directory.";
  return `Loaded ${files.length} ${files.length === 1 ? "file" : "files"} from the work directory.`;
}

/** The profile settle copy for the aria-live status region. */
function profileLiveMessage(
  profile: JobInputProfileResult | "loading" | undefined,
): string {
  if (profile === undefined) return "";
  if (profile === "loading") return "Profiling the file on the appliance.";
  if (profile.kind !== "profile")
    return PROFILE_UNAVAILABLE_COPY[profile.reason].title + ".";
  return "File profile ready. Confirm the file before using it.";
}

/**
 * The console's server-file intake: a two-stage picker over the operator-mounted
 * work-input directory ({@link fetchJobInputs}). The first stage lists
 * name/size/modified rows with a refresh control; selecting a row fetches the
 * streaming profile ({@link fetchJobInputProfile}) and shows a confirm panel --
 * columns, row count, size, modified time, and a per-column sample peek -- with an
 * explicit loading state, since a pass over a CLI-scale file takes seconds. "Use this
 * file" commits the profile to the bench.
 *
 * Focus moves to the active stage on a listing<->confirm swap and on a refresh settle
 * (so the loading branch is never a focus dead-end), and a polite status region
 * announces every listing/profile update. The mounted directory is the operator's own
 * trusted data, so the file is read in place with no drift or freshness re-check.
 */
export function ServerFilePicker({
  committed,
  onUse,
}: {
  /** The file currently committed to the bench (its reference), so its row is
   * marked. */
  committed: WorkInputReference | undefined;
  /** Commit a profiled file to the bench -- the second stage's "Use this file". */
  onUse: (profile: ProfiledJobInput) => void;
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

  function useProfiled(profiled: ProfiledJobInput) {
    onUse(profiled);
    cancelSelection();
  }

  // The active stage receives focus on a listing<->confirm swap and on a refresh
  // settle, so a screen-reader user is never stranded on a control that unmounted
  // and the loading branch (which has no focusable content of its own) is not a
  // dead-end. tabIndex -1 makes the wrapper focusable without adding it to the tab
  // order; a programmatic focus does not trip :focus-visible, so no outline shows.
  const stageRef = useRef<HTMLDivElement>(null);
  const stageMounted = useRef(false);
  useEffect(() => {
    if (stageMounted.current) stageRef.current?.focus();
    stageMounted.current = true;
  }, [selectedName]);

  const focusAfterListing = useRef(false);
  const refresh = useCallback(() => {
    focusAfterListing.current = true;
    void loadListing();
  }, [loadListing]);
  useEffect(() => {
    if (listing === "loading") return;
    if (focusAfterListing.current) {
      focusAfterListing.current = false;
      stageRef.current?.focus();
    }
  }, [listing]);

  // One polite status region announces the last settled update: the profile result
  // while confirming a file, otherwise the listing summary. Computed in render so the
  // region re-announces exactly when the message text changes.
  const liveMessage =
    selectedName !== undefined
      ? profileLiveMessage(profile)
      : listingLiveMessage(listing);

  return (
    <Stack gap="md" mt="md">
      <VisuallyHidden role="status" aria-live="polite">
        {liveMessage}
      </VisuallyHidden>
      <div ref={stageRef} tabIndex={-1} style={{ outline: "none" }}>
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
            onRefresh={refresh}
            onSelect={(name) => void selectFile(name)}
          />
        )}
      </div>
    </Stack>
  );
}

/** The first-stage listing: the loading, error, empty, and file-list states plus the
 * refresh control. */
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

  const { files, configured, readable } = listing.listing;

  // An unconfigured JOB_INPUT_DIR and an empty-but-mounted directory both list zero
  // files; the unconfigured case is a deployment-config gap, so it names the env var
  // rather than telling the operator to place a file in a directory that does not exist.
  if (!configured)
    return (
      <Stack gap="sm">
        <Alert
          color="blue"
          icon={<IconAlertCircle />}
          title="No work directory configured"
        >
          No work directory is configured on this appliance. Set JOB_INPUT_DIR
          to the mounted input directory.
        </Alert>
        {refreshButton}
      </Stack>
    );

  // A configured-but-unreadable mount is distinct from an empty one: the directory is
  // there but could not be read (a mis-mount or a permission fault), so tell the
  // operator to check the mount rather than to place a file that may already be there.
  if (!readable)
    return (
      <Stack gap="sm">
        <Alert
          color="red"
          icon={<IconAlertCircle />}
          title="Could not read the work directory"
        >
          The mounted work directory could not be read. Check that it is mounted
          and readable on this appliance, then refresh.
        </Alert>
        {refreshButton}
      </Stack>
    );

  if (files.length === 0)
    return (
      <Stack gap="sm">
        <Alert
          color="blue"
          icon={<IconAlertCircle />}
          title="No usable files in the work directory"
        >
          Place your input CSV in this appliance's mounted work directory, then
          refresh. Directories and dot-prefixed files are not listed.
        </Alert>
        {refreshButton}
      </Stack>
    );

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="center">
        <h2 style={{ margin: 0 }}>Choose a file from the work directory</h2>
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
            const displayName = sanitizeForDisplay(file.name);
            const action = isCommitted ? "Re-profile" : "Select";
            return (
              <Table.Tr key={file.name}>
                <Table.Td className={styles.mono}>
                  {displayName}{" "}
                  {isCommitted && (
                    <Badge size="xs" color="green" variant="light">
                      Selected
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td className={styles.mono}>
                  {byteSizeLabel(file.sizeBytes)}
                </Table.Td>
                <Table.Td>{dateTimeLabel(new Date(file.modifiedAt))}</Table.Td>
                <Table.Td>
                  <Button
                    size="xs"
                    variant="light"
                    aria-label={`${action} ${displayName}`}
                    onClick={() => onSelect(file.name)}
                  >
                    {action}
                  </Button>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
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
  onUse: (profile: ProfiledJobInput) => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const sampleRows = useMemo(() => {
    if (profile === undefined || profile === "loading") return [];
    if (profile.kind !== "profile") return [];
    return profile.profile.columns.map((column) => ({
      column,
      values: profile.profile.columnSamples.get(column) ?? [],
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

  if (profile.kind !== "profile") {
    const copy = PROFILE_UNAVAILABLE_COPY[profile.reason];
    return (
      <Stack gap="sm">
        <Alert color="red" icon={<IconAlertCircle />} title={copy.title}>
          {copy.body}
        </Alert>
        <Group>
          <Button variant="light" size="xs" onClick={onRetry}>
            Try again
          </Button>
          <Button variant="default" size="xs" onClick={onCancel}>
            Back to the file list
          </Button>
        </Group>
      </Stack>
    );
  }

  const profiled = profile.profile;
  return (
    <Stack gap="sm">
      <h2 style={{ margin: 0 }}>Confirm this file</h2>
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
              {byteSizeLabel(profiled.sizeBytes)}
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
