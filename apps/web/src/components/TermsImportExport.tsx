import { useState } from "react";

import {
  Alert,
  Button,
  Group,
  Stack,
  Text,
  Textarea,
  VisuallyHidden,
} from "@mantine/core";
import { IconAlertCircle, IconDownload, IconUpload } from "@tabler/icons-react";

import { exportLinkageTerms, importLinkageTerms } from "@psi/linkageTermsIO";
import { gatedActiveSettingMessage } from "@psi/advancedInvite";

import type { LinkageTerms } from "@psilink/core";

/** How long to keep a download's object URL alive after the click before revoking
 * it. The browser may copy the blob asynchronously, so revoking too soon (even on
 * the next task) can abort the save; a generous fixed delay outlives the transfer
 * while still freeing the URL rather than leaking it for the document lifetime.
 * Matches the long-standing file-saver convention. */
const REVOKE_DELAY_MS = 60_000;

/** Trigger a client-side download of `content` as `filename`. The terms never
 * leave the browser; this writes them to the user's disk the same way the file is
 * read in (locally). */
function downloadDocument(
  filename: string,
  content: string,
  mime: string,
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  // Some environments (older Firefox/Safari, certain sandboxed contexts) only
  // honor the download attribute when the anchor is in the live document; append
  // it before clicking and remove it after so the save fires everywhere.
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Defer the revoke well past the click (see REVOKE_DELAY_MS): a synchronous or
    // next-task revoke can abort a save in browsers that copy the blob
    // asynchronously. The finally makes cleanup unconditional even if click throws.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}

/**
 * The JSON/YAML escape hatch: export the current linkage terms to a portable
 * document, or import one to load the editor from. Export writes the snake_case
 * on-disk form (the "exported from the GUI" reference). Import routes through
 * {@link importLinkageTerms} -- which validates through `safeParseLinkageTerms`,
 * the single validation source -- then refuses any terms that turn on a setting
 * the run does not yet apply ({@link gatedActiveSettingMessage}), so the escape
 * hatch cannot bring a gated-active setting in past the GUI controls. A rejected
 * import surfaces a readable, value-free error and leaves the draft untouched.
 */
export function TermsImportExport({
  currentTerms,
  onImport,
}: {
  /** The terms the current draft represents, for export. */
  currentTerms: LinkageTerms;
  /** Called with validated, non-gated terms to load into the editor. */
  onImport: (terms: LinkageTerms) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [imported, setImported] = useState(false);

  const IMPORT_SUCCESS = "Imported. Review the loaded terms before generating.";

  const handleImport = () => {
    setImported(false);
    const result = importLinkageTerms(text);
    if (!result.success) {
      setError(result.error);
      return;
    }
    const gated = gatedActiveSettingMessage(result.terms);
    if (gated !== undefined) {
      setError(gated);
      return;
    }
    setError(undefined);
    onImport(result.terms);
    setImported(true);
    // Clear the consumed document so a later Reset + Import cannot silently
    // re-import this now-stale paste (the Import button disables on empty text).
    setText("");
  };

  // A single message for the persistent live region below. Conditionally-mounted
  // alerts are missed by screen readers that only watch regions already in the DOM,
  // so the announcement lives in an always-present region whose content changes.
  const liveMessage = error ?? (imported ? IMPORT_SUCCESS : "");

  return (
    <Stack gap="sm">
      <div>
        <Text size="sm" fw={600}>
          Import or export
        </Text>
        <Text size="xs" c="dimmed">
          Export the current terms to a JSON or YAML document, or paste one
          below to load it. Everything stays in your browser.
        </Text>
      </div>

      <Group gap="sm">
        <Button
          variant="default"
          size="xs"
          leftSection={<IconDownload size={14} aria-hidden />}
          onClick={() =>
            downloadDocument(
              "linkage-terms.json",
              exportLinkageTerms(currentTerms, "json"),
              "application/json",
            )
          }
        >
          Download JSON
        </Button>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconDownload size={14} aria-hidden />}
          onClick={() =>
            downloadDocument(
              "linkage-terms.yaml",
              exportLinkageTerms(currentTerms, "yaml"),
              "application/yaml",
            )
          }
        >
          Download YAML
        </Button>
      </Group>

      <Textarea
        label="Paste a JSON or YAML linkage-terms document to import"
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value);
          setImported(false);
        }}
        autosize
        minRows={3}
        maxRows={12}
        placeholder="{ ... }"
        styles={{ input: { fontFamily: "monospace" } }}
      />
      {/* Visual-only status; the announcement is carried by the persistent live
          region at the end so it is not missed when newly mounted. */}
      {error !== undefined && (
        <Alert
          color="red"
          icon={<IconAlertCircle aria-hidden />}
          title="Could not import these terms"
        >
          {error}
        </Alert>
      )}
      {imported && (
        <Text size="xs" c="green">
          {IMPORT_SUCCESS}
        </Text>
      )}
      <Group>
        <Button
          size="xs"
          leftSection={<IconUpload size={14} aria-hidden />}
          onClick={handleImport}
          disabled={text.trim() === ""}
        >
          Import
        </Button>
      </Group>

      {/* Persistent polite live region: always in the DOM, only its text changes,
          so the import result is announced reliably (the visual alert/text above
          mirror it). */}
      <VisuallyHidden role="status" aria-live="polite">
        {liveMessage}
      </VisuallyHidden>
    </Stack>
  );
}
