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

/** The authoring-time state of a committed file's profiled snapshot against a fresh
 * listing. Kept distinct so the notice never claims a file "changed" when it was
 * removed or merely pushed past the truncated listing window. */
export type WorkInputDrift = "none" | "changed" | "removed" | "not-listed";

/**
 * Compare a committed file's profiled `(sizeBytes, modifiedAt)` against a fresh
 * listing. Present with a matching pair, or a listing that could not be read, is
 * `none`; present with a different pair is `changed`; absent from a COMPLETE listing
 * is `removed`; absent from a TRUNCATED listing is `not-listed` -- the file may sit
 * beyond the 512-name window, so its absence there is not evidence it is gone, and
 * flagging it as "changed" would drive the operator to destroy an intact draft.
 */
export function workInputDrift(
  committed: WorkInputReference,
  listing: JobInputsResult,
): WorkInputDrift {
  if (listing.kind !== "listing") return "none";
  const entry = listing.listing.files.find(
    (file) => file.name === committed.name,
  );
  if (entry !== undefined)
    return entry.sizeBytes !== committed.sizeBytes ||
      entry.modifiedAt !== committed.modifiedAt
      ? "changed"
      : "none";
  return listing.listing.truncated ? "not-listed" : "removed";
}

// The aria-live status copy below is deliberately worded distinctly from the visible
// notices it accompanies (the CleaningTab live-region idiom): a screen reader hears
// the region on change, while the visible alert carries the operator-facing detail.

/** The drift live-region copy -- short, name-free (the visible notice carries the
 * name), one line per state. */
function driftLiveMessage(drift: WorkInputDrift): string {
  if (drift === "changed")
    return "The mounted file changed since you profiled it; re-profile it.";
  if (drift === "removed")
    return "The mounted file is gone from the work directory.";
  if (drift === "not-listed")
    return "The mounted file is outside the current listing.";
  return "";
}

/** The listing settle copy for the aria-live status region. */
function listingLiveMessage(listing: JobInputsResult | "loading"): string {
  if (listing === "loading") return "";
  if (listing.kind === "busy") return "The appliance is busy.";
  if (listing.kind === "error") return "The file listing could not be loaded.";
  const { configured, totalEntries, truncated, files } = listing.listing;
  if (!configured) return "This appliance has no work directory configured.";
  if (files.length === 0)
    return totalEntries === 0
      ? "No files are in the work directory yet."
      : "The work directory holds no usable files.";
  return truncated
    ? `Loaded the first ${files.length} files; additional files are present.`
    : `Loaded ${files.length} ${files.length === 1 ? "file" : "files"} from the work directory.`;
}

/** The profile settle copy for the aria-live status region. */
function profileLiveMessage(
  profile: JobInputProfileResult | "loading" | undefined,
): string {
  if (profile === undefined) return "";
  if (profile === "loading") return "Profiling the file on the appliance.";
  if (profile.kind === "busy") return "The appliance is busy.";
  if (profile.kind !== "profile") return "The file could not be profiled.";
  return "File profile ready. Confirm the file before using it.";
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
 * the profile to the bench.
 *
 * A listing refresh compares the committed file's `(size, mtime)` against the
 * profiled snapshot and surfaces one of three distinct notices ({@link
 * workInputDrift}): changed on disk, removed, or not visible in a truncated listing.
 * Focus moves to the active stage on a listing<->confirm swap and on a refresh settle
 * (so the loading branch is never a focus dead-end), and a polite status region
 * announces every listing/profile/drift update.
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

  const drift: WorkInputDrift =
    committed !== undefined && listing !== "loading"
      ? workInputDrift(committed, listing)
      : "none";

  // One polite status region announces the last settled update: the profile result
  // while confirming a file, otherwise the drift (which outranks the plain listing
  // summary) or the listing summary. Computed in render so the region re-announces
  // exactly when the message text changes (the TermsImportExport live-region idiom).
  const liveMessage =
    selectedName !== undefined
      ? profileLiveMessage(profile)
      : drift !== "none"
        ? driftLiveMessage(drift)
        : listingLiveMessage(listing);

  return (
    <Stack gap="md" mt="md">
      <VisuallyHidden role="status" aria-live="polite">
        {liveMessage}
      </VisuallyHidden>
      {committed !== undefined && (
        <DriftNotice
          drift={drift}
          name={committed.name}
          onReprofile={() => void selectFile(committed.name)}
        />
      )}
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

/** The authoring-time drift notice for the committed file, one of three distinct
 * copies ({@link workInputDrift}). Only `changed` offers a re-profile (a removed or
 * out-of-window file cannot be re-profiled from here). */
function DriftNotice({
  drift,
  name,
  onReprofile,
}: {
  drift: WorkInputDrift;
  name: string;
  onReprofile: () => void;
}) {
  const displayName = (
    <span className={styles.mono}>{sanitizeForDisplay(name)}</span>
  );
  if (drift === "changed")
    return (
      <Alert
        color="orange"
        icon={<IconAlertCircle />}
        title="This file changed on disk since you profiled it"
      >
        <Stack gap="xs">
          <Text size="sm">
            The exchange will not run against content that changed after you
            profiled it. Re-profile {displayName} to use its current version.
          </Text>
          <Group>
            <Button size="xs" variant="light" onClick={onReprofile}>
              Re-profile this file
            </Button>
          </Group>
        </Stack>
      </Alert>
    );
  if (drift === "removed")
    return (
      <Alert
        color="red"
        icon={<IconAlertCircle />}
        title="This file is no longer in the work directory"
      >
        <Text size="sm">
          The exchange cannot run against a file that is no longer there. Choose
          another file below, or restore {displayName} to the work directory and
          refresh.
        </Text>
      </Alert>
    );
  if (drift === "not-listed")
    return (
      <Alert
        color="blue"
        icon={<IconAlertCircle />}
        title="This file is not visible in the current listing"
      >
        <Text size="sm">
          {displayName} is beyond the truncated file listing, so its current
          state cannot be checked here. Narrow the work directory to see it,
          then re-profile if it changed.
        </Text>
      </Alert>
    );
  return null;
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
                  {formatBytes(file.sizeBytes)}
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
