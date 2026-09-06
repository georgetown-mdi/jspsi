/**
 * The field a relayed terminal `error` event holds its rendered cause chain in,
 * link by link, beside the flat `message` the CLI emitted on fd 3. The relay
 * derives it: the server splits the rendered chain into links and escapes each at
 * the budget the renderer gave it (`validateAndSanitizeEvent` in
 * `@jobs/cliDriver`), and the console seat rebuilds the chain from the links
 * (`errorMessageOf` in `./serverJobExchangeDriver`). It has its own module because
 * the relay runs in the Nitro server and imports `node:child_process`, so the seat
 * cannot import it for one constant.
 *
 * A terminal the job manager synthesizes for a run that emitted none composes its
 * own links (`diagnosedTerminal` in `@jobs/jobManager`), and composes them RAW:
 * text crossing fd 3 is escaped at the relay as defense in depth and again at the
 * seat, while text the console raises itself takes the seat's pass alone, which is
 * the single escape its own bytes are due (docs/spec/CHANNEL_SECURITY.md, Display
 * sanitization escape format).
 */
export const ERROR_MESSAGE_CHAIN_FIELD = "messageChain";
