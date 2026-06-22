import { useState } from "react";

import { Alert, Button, Group, Stack, Text, Textarea } from "@mantine/core";
import { IconAlertCircle, IconDownload, IconUpload } from "@tabler/icons-react";

import { exportLinkageTerms, importLinkageTerms } from "@psi/linkageTermsIO";
import { gatedActiveSettingMessage } from "@psi/advancedInvite";

import type { LinkageTerms } from "@psilink/core";

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
  anchor.click();
  URL.revokeObjectURL(url);
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
  };

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
      {error !== undefined && (
        <Alert
          color="red"
          icon={<IconAlertCircle aria-hidden />}
          title="Could not import these terms"
          role="alert"
        >
          {error}
        </Alert>
      )}
      {imported && (
        <Text size="xs" c="green" role="status">
          Imported. Review the loaded terms before generating.
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
    </Stack>
  );
}
