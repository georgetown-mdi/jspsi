import { TERMS_VALUE_DELIMITER } from "../../src/config/compatibilityMessage";

/**
 * Walks a composed diagnostic under the grammar `quoteTermsValue` emits: a
 * doubled delimiter is a literal and a single one closes a value run.
 * Returns the clause skeleton (each run collapsed to one placeholder) and
 * the raw values held -- two runs of one diagnostic, one benign and one
 * adversarial, must yield the same skeleton, proving no value can display
 * as a clause psilink itself wrote.
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
