/**
 * The one contract for an operator's `--identity` label, shared by the client-side
 * confirm-screen guard ({@link ../bench/DirectConfirmSection}), the server intent
 * schema ({@link ../jobs/intent}), and the signing-fingerprint route
 * ({@link ../routes/api/jobs/signing/fingerprint}), which binds the label into a
 * long-lived certificate. Extracted so the browser guard and the server validators
 * cannot drift -- a label one accepts, the others must too -- and so the guard does
 * not pull the server-only intent module (and its `node:url` dependency) into the
 * browser bundle for one constant.
 */

/**
 * Upper bound on the `identity` label a zero-setup intent may hold (the CLI's
 * `--identity` value: the party's name/org/contact string). Generous for a real
 * label yet refuses an unbounded string; a non-secret operator value, never a path
 * or credential.
 */
export const MAX_IDENTITY_LENGTH = 1024;

/**
 * The control characters a label may not contain: C0 (NUL among them), DEL, and
 * the C1 range, with NO exception for tab, line feed, or carriage return --
 * unlike the retention note's rule ({@link ./retentionNoteShape}), whose field
 * is a multi-line textarea. This label rides to the CLI as one
 * `--identity=<value>` token and is bound into a long-lived certificate the
 * partner pins and DISPLAYS, so no control byte in it is text the operator
 * meant to write. Letters outside ASCII are untouched -- the range stops below
 * U+00A0, so a label written in the operator's own script stays admissible.
 *
 * Core's terms-document rule (`TEXT_CONTROL_CHAR_PATTERN`,
 * packages/core/src/config/linkageTermsSchema.ts) draws the same ranges over the four
 * free-text fields of a linkage-terms document, the party `identity` among
 * them, which a label accepted here becomes; the two patterns are held equal
 * by test/unit/identityLabelParity.test.ts. This contract is stricter: it also
 * refuses a leading `-`.
 */
export const IDENTITY_CONTROL_CHAR_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The reason every boundary reports for a label containing one, so the surfaces
 * enforcing the rule say the same thing about the same value. A field path and a
 * shape reason, never the submitted bytes: the label is the submitter's own text,
 * and echoing it back is what the job API's error discipline exists to prevent.
 */
export const IDENTITY_CONTROL_CHAR_MESSAGE =
  "identity must not contain control characters";
