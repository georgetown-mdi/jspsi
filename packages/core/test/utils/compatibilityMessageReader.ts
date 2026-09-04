import { TERMS_VALUE_DELIMITER } from "../../src/config/compatibilityMessage";

/**
 * Walks a composed diagnostic under the grammar `quoteTermsValue` emits:
 * outside a run every character stands for itself; inside one, a doubled
 * delimiter is a literal and a single delimiter closes the run.
 *
 * Returns the message's clause skeleton (each run collapsed to one
 * placeholder) and the raw values the runs held. Two runs of the same
 * diagnostic -- one with a benign value, one with an adversarial one --
 * must produce the same skeleton: that is what proves no value can display
 * to the operator as a clause psilink itself wrote.
 *
 * Every message compatibilityMessage.ts composes is read back through this
 * one parser, so the reading compatibilityMessage.test.ts pins against the
 * constructor is the reading every caller's claim rests on.
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
