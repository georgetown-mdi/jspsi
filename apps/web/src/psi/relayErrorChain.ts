/**
 * The field a relayed terminal `error` event holds its rendered cause chain in,
 * link by link, beside the flat `message` the CLI emitted on fd 3. The relay
 * derives it: the server splits the rendered chain into links and escapes each at
 * the budget the renderer gave it (`validateAndSanitizeEvent` in
 * `@jobs/cliDriver`), and the console seat rebuilds the chain from the links
 * (`errorMessageOf` in `./serverJobExchangeDriver`). It has its own module because
 * the relay runs in the Nitro server and imports `node:child_process`, so the seat
 * cannot import it for one constant.
 */
export const ERROR_MESSAGE_CHAIN_FIELD = "messageChain";
