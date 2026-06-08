import { DirectoryListingBoundsError } from "@psilink/core";

/**
 * Directory-listing enforcement primitives shared by the file-transport adapters
 * ({@link ../connection/localFSClient.LocalFSClient | LocalFSClient} and
 * {@link ../connection/ssh2SftpAdapter.SSH2SFTPClientAdapter}). Centralizing
 * them keeps a single, unit-tested definition of the security invariant: a
 * rendezvous directory with more entries than {@link MAX_DIRECTORY_ENTRIES}, or
 * an entry whose name exceeds {@link MAX_FILENAME_LENGTH}, is refused with a
 * typed, terminal {@link DirectoryListingBoundsError} before the listing is
 * materialized -- so a hostile filedrop/SFTP directory cannot exhaust memory
 * through directory enumeration. This is the directory-enumeration sibling of
 * the per-frame bound in {@link ./frameSizeGuard}: that one caps the per-file
 * body read; this one caps the listing that precedes it.
 *
 * Both adapters enforce these bounds while streaming the directory entry by
 * entry (LocalFSClient via `fs.opendir`; the SFTP adapter via the low-level
 * `opendir`/`readdir`/`close` batch loop), never via `fs.readdir`/the library's
 * `list()` -- which would already have allocated an array proportional to the
 * attacker-chosen entry count before any check could run.
 */

/**
 * Maximum number of entries a transport directory listing will enumerate before
 * it is refused. Enforced at the transport `list()` layer in both adapters,
 * counting every directory entry (file or otherwise -- the attacker controls the
 * entry count regardless of type), so an oversized directory is refused before
 * an array and per-entry metadata proportional to the attacker-chosen entry
 * count can be allocated. See docs/SECURITY_DESIGN.md, "Channel security".
 *
 * Value: 8192. Derived from a memory envelope rather than chosen as a round
 * number. The worst-case bounded allocation when refusing is the entries
 * retained up to the cap, each carrying a name string of up to
 * {@link MAX_FILENAME_LENGTH} characters plus per-entry object overhead (~600
 * bytes total, conservatively), so 8192 entries bound the listing allocation to
 * roughly 5 MiB. That is about two orders of magnitude below the 512 MiB
 * single-frame budget the sibling frame-size bound already governs, so directory
 * enumeration cannot become the dominant memory vector, yet it exceeds the
 * order-of-ten files a legitimate exchange produces (the rendezvous protocol's
 * two `-hello.json` files, at most one `-lock.json` or the `-ack.json` markers,
 * transient `-joining.json` sentinels and `temp-*.tmp` writes, and the bounded
 * set of PSI message frames) by roughly three orders of magnitude. It remains
 * generous for a retain-mode directory that accumulates message and ack files
 * across many sequential exchanges before the operator rotates it (retention is
 * an out-of-band operator responsibility; see fileSyncConnection's poll()).
 *
 * Fixed, not operator-configurable -- mirroring the frame-size bound: a
 * configurable cap risks an operator raising it high enough to reintroduce the
 * denial of service.
 */
export const MAX_DIRECTORY_ENTRIES = 8192;

/**
 * Maximum length, in characters, of a single directory entry's filename.
 * Enforced per entry at the transport `list()` layer in both adapters so an
 * adversary cannot exhaust memory with very long names. See
 * docs/SECURITY_DESIGN.md, "Channel security".
 *
 * Value: 255, the POSIX `NAME_MAX` -- the maximum length of a single path
 * component that every mainstream filesystem accepts (ext4, XFS, APFS, and NTFS
 * all cap a name component at 255 bytes / UTF-16 code units). A derived platform
 * limit, not a round constant: the longest filename a legitimate exchange writes
 * is the ack marker of a timestamped message
 * (`<writerId>-<id>-<timestamp>-<counter>-<byteCount>-ack.json`), on the order of
 * 120 characters with the default UUID peer ids, so 255 leaves comfortable
 * headroom. A name longer than 255 cannot exist on a conformant filesystem, so
 * for the local adapter it is unreachable; the SFTP protocol imposes no name
 * length limit, so a hostile server can synthesize arbitrarily long names in a
 * READDIR response, and 255 is exactly the boundary above which such a name is
 * necessarily synthetic. Fixed for the same reason as
 * {@link MAX_DIRECTORY_ENTRIES}.
 */
export const MAX_FILENAME_LENGTH = 255;

/**
 * Construct the typed, terminal error for a directory whose entry count exceeds
 * {@link MAX_DIRECTORY_ENTRIES}.
 */
export function directoryTooLargeError(
  dirPath: string,
  max: number,
): DirectoryListingBoundsError {
  return new DirectoryListingBoundsError(
    `directory ${dirPath} contains more than ${max} entries; refusing to ` +
      `enumerate it to avoid an unbounded memory allocation`,
  );
}

/**
 * Construct the typed, terminal error for a directory entry whose filename
 * exceeds {@link MAX_FILENAME_LENGTH}. The offending name is truncated in the
 * message so the error (and any log line carrying it) cannot itself relay an
 * attacker-sized string.
 */
export function filenameTooLongError(
  dirPath: string,
  name: string,
  max: number,
): DirectoryListingBoundsError {
  const shown = name.length > 64 ? `${name.slice(0, 64)}...` : name;
  return new DirectoryListingBoundsError(
    `directory ${dirPath} contains an entry whose filename is ${name.length} ` +
      `characters, exceeding the maximum of ${max} (${shown}); refusing to ` +
      `process it`,
  );
}
