/**
 * Where an operator sends a report that this build and an installed transport
 * library do not fit together, and what to include with it.
 *
 * One definition rather than a literal per site: the SFTP and WebRTC adapters
 * end a dozen operator warnings and refusals on this sentence, and a
 * destination that drifted between them would send some reports nowhere. The
 * issue tracker is the channel SUPPORT.md publishes for a bug report, and the
 * version is what tells the maintainer which library pairing failed.
 *
 * No trailing period: a caller inside a sentence adds its own.
 */
export const REPORT_LIBRARY_INCOMPATIBILITY =
  "report it at https://github.com/georgetown-mdi/jspsi/issues with the " +
  "version from 'psilink --version'";
