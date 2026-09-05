/**
 * The one contract for a retention note's control-character refusal, shared by
 * the console's authoring guard ({@link ../psi/receiptsModel}) and the server
 * intent schema ({@link ../jobs/intent}). Separate for the same reason as
 * {@link ./identityLabel}: the browser guard and the server validator must not
 * drift, and the guard must not pull the server-only intent module (and its
 * `node:url` dependency) into the browser bundle for one constant.
 */

// C0 and C1 controls plus DEL, minus the three whitespace controls a multi-line
// note may contain (tab, LF, CR): the field is authored in a textarea, so the
// ranges are narrower than the single-segment name rule's in
// ../jobs/workInputName, which admits no whitespace control at all. The note
// goes into the YAML verbatim and from there into this party's exchange record.
export const NOTE_CONTROL_CHAR_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
