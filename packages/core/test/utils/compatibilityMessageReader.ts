import { TERMS_VALUE_DELIMITER } from "../../src/config/compatibilityMessage";

/**
 * Walk a composed diagnostic under the grammar `quoteTermsValue` emits: outside
 * a run every character stands for itself; inside one, a doubled delimiter is a
 * literal and a single delimiter closes the run.
 *
 * Returns the message's CLAUSE SKELETON -- each run collapsed to one placeholder
 * -- and the raw values the runs carried. The skeleton is what the seam's
 * assertions compare: two runs of the same diagnostic, one with a benign value
 * and one with an adversarial one, must produce the SAME skeleton, which is the
 * precise statement that no value can be shown to the operator as a clause
 * psilink wrote.
 *
 * Shared rather than restated per suite: every message the seam composes is read
 * back through this one parser, so the reader `compatibilityMessage.test.ts` pins
 * against the constructor is the reader each caller's claim rests on.
 */
export const readMessage = (
  message: string,
): { skeleton: string; values: string[] } => {
  let skeleton = "";
  const values: string[] = [];
  let index = 0;
  while (index < message.length) {
    if (message[index] !== TERMS_VALUE_DELIMITER) {
      skeleton += message[index];
      index += 1;
      continue;
    }
    index += 1;
    let value = "";
    let closed = false;
    while (index < message.length) {
      if (message[index] === TERMS_VALUE_DELIMITER) {
        if (message[index + 1] === TERMS_VALUE_DELIMITER) {
          value += TERMS_VALUE_DELIMITER;
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      value += message[index];
      index += 1;
    }
    values.push(value);
    skeleton += closed ? "<value>" : "<unterminated>";
  }
  return { skeleton, values };
};
