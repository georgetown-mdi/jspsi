import { Button, NativeSelect, Radio } from "@mantine/core";

import {
  LIFETIME_CHOICES,
  RESULTS_DIRECTION_LABELS,
  answersRows,
  expiryLabel,
} from "./inviterModel";
import styles from "./bench.module.css";

import type {
  AcquiredCsv,
  InviterEditor,
  SpineProblem,
  SpineTarget,
} from "./inviterModel";
import type { OutputDirection } from "@psi/advancedInvite";

const DIRECTION_CHOICES: ReadonlyArray<{
  value: OutputDirection;
  label: string;
}> = [
  { value: "both", label: `${RESULTS_DIRECTION_LABELS.both} (recommended)` },
  { value: "inviter", label: RESULTS_DIRECTION_LABELS.inviter },
  { value: "partner", label: RESULTS_DIRECTION_LABELS.partner },
];

/**
 * Step 3 of the inviter spine: the review-time decisions (lifetime, result
 * direction, transport), the check-your-answers restatement of the whole
 * proposal, and the create action -- the point of no return whose copy says
 * so. The transport cards for SFTP and a shared directory are present but
 * disabled until exchange-file download ships; their copy carries the
 * channel-capability rule (browsers run live WebRTC exchanges; SFTP and
 * shared-directory exchanges run in the command-line tool).
 */
export function ReviewCreateSection({
  editor,
  csv,
  problems,
  minting,
  onLifetime,
  onDirection,
  onReset,
  onCreate,
  onNavigate,
}: {
  editor: InviterEditor;
  csv: AcquiredCsv;
  problems: ReadonlyArray<SpineProblem>;
  minting: boolean;
  onLifetime: (seconds: number) => void;
  onDirection: (direction: OutputDirection) => void;
  onReset: () => void;
  onCreate: () => void;
  onNavigate: (target: SpineTarget) => void;
}) {
  const canCreate = problems.length === 0 && !minting;
  return (
    <>
      <p className={styles.eyebrow}>Step 3 of 3</p>
      <h1 tabIndex={-1}>Review &amp; create</h1>
      <NativeSelect
        label="Invitation lifetime"
        description="How long this invitation can be accepted before it expires."
        value={String(editor.draft.lifetimeSeconds)}
        data={LIFETIME_CHOICES.map((choice) => ({
          value: String(choice.seconds),
          label: choice.label,
        }))}
        onChange={(event) => onLifetime(Number(event.currentTarget.value))}
      />
      <p className={`${styles.small} ${styles.sub}`}>
        Shared now, it expires{" "}
        <span className={styles.mono}>
          {expiryLabel(editor.draft.lifetimeSeconds, new Date())}
        </span>
        .
      </p>
      <NativeSelect
        label="Who receives the matched results"
        description="The party who receives no results still contributes records to the match."
        value={editor.draft.outputDirection}
        data={DIRECTION_CHOICES.map((choice) => ({
          value: choice.value,
          label: choice.label,
        }))}
        onChange={(event) =>
          onDirection(event.currentTarget.value as OutputDirection)
        }
        mt="md"
      />
      <fieldset className={styles.fieldset}>
        <legend>How will this exchange run?</legend>
        <div className={`${styles.radioCard} ${styles.radioCardSelected}`}>
          <Radio
            checked
            readOnly
            label="Live, in this browser (recommended)"
            description="Your browsers connect directly. You get an invitation link and code to share; keep this tab open while your partner accepts."
          />
        </div>
        <div className={styles.radioCard}>
          <Radio
            disabled
            checked={false}
            readOnly
            label={
              <>
                Over SFTP, run by the psilink command-line tool
                <span className={styles.tagRoadmap}>On the roadmap</span>
              </>
            }
            description="Will save an exchange file that automates the command-line tool over your SFTP server. Your partner accepts with the same invitation code."
          />
        </div>
        <div className={styles.radioCard}>
          <Radio
            disabled
            checked={false}
            readOnly
            label={
              <>
                Over a shared directory, run by the command-line tool
                <span className={styles.tagRoadmap}>On the roadmap</span>
              </>
            }
            description="Will save an exchange file the command-line tool runs against a directory both parties can reach."
          />
        </div>
        <p className={`${styles.small} ${styles.sub}`}>
          This browser runs live exchanges only; SFTP and shared-directory
          exchanges run in the psilink command-line tool.
        </p>
      </fieldset>
      <h2>Exchange proposal</h2>
      <p className={`${styles.small} ${styles.sub}`}>
        Check every term before you create the invitation. Creating it seals the
        terms.
      </p>
      <div className={styles.tableScroll}>
        <table className={`${styles.benchTable} ${styles.answers}`}>
          <caption className={styles.visuallyHidden}>
            Check your answers before creating the invitation
          </caption>
          <tbody>
            {answersRows(editor, csv).map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td className={row.mono === true ? styles.mono : undefined}>
                  {row.value}
                </td>
                <td className={styles.answersChange}>
                  {row.changeTarget !== undefined ? (
                    <button
                      type="button"
                      className={styles.stepLink}
                      onClick={() =>
                        onNavigate(row.changeTarget as SpineTarget)
                      }
                    >
                      Change
                      <span className={styles.visuallyHidden}>
                        {" "}
                        {row.label.toLowerCase()}
                      </span>
                    </button>
                  ) : row.setAbove === true ? (
                    <span className={styles.setAbove}>
                      Set above on this step
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.workFoot}>
        <Button disabled={!canCreate} loading={minting} onClick={onCreate}>
          Create the invitation
        </Button>
        <Button variant="default" disabled={minting} onClick={onReset}>
          Reset to recommended
        </Button>
        <p
          className={
            problems.length === 0
              ? `${styles.statusLine} ${styles.statusLineOk}`
              : `${styles.statusLine} ${styles.statusLineDanger}`
          }
        >
          {problems.length === 0
            ? "Ready to create."
            : `Resolve ${problems.length === 1 ? "the problem" : `the ${problems.length} problems`} in the rail to continue.`}
        </p>
      </div>
    </>
  );
}
