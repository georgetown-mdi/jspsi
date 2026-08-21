/**
 * The field a relayed terminal `error` event carries its rendered cause chain in,
 * link by link, beside the flat `message` the CLI emitted on fd 3.
 *
 * It is the relay's own derivation, not a field of the CLI's event vocabulary:
 * the server splits the rendered chain it received into links and escapes each
 * one at the budget the renderer gave it (`validateAndSanitizeEvent` in
 * `@jobs/cliDriver`), and the console seat rebuilds the chain from the links
 * (`errorMessageOf` in `./serverJobExchangeDriver`). Charging the whole chain to
 * one value's cap instead is what cuts a terminal error's recovery step off
 * before it reaches the operator.
 *
 * The name lives in its own module because the two ends are on opposite sides of
 * the server/browser split -- the relay runs in the Nitro server and imports
 * `node:child_process`, so the seat cannot import it for a constant -- and a
 * field name spelled separately at each end is a field the seat silently stops
 * finding.
 */
export const ERROR_MESSAGE_CHAIN_FIELD = "messageChain";
