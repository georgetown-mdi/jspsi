import Ssh2SftpClient from "ssh2-sftp-client";
import {
  FileInfo,
  FileTransportClient,
  GetOptions,
  PutOptions,
  retryPromise,
} from "@psilink/core";

// Typed interface for the internal ssh2 SFTPWrapper that ssh2-sftp-client
// exposes as `this.sftp`. Defined at file scope so both connect() and
// createExclusive() can share it without repeating the declaration.
interface Ssh2SftpClientInternals {
  sftp: {
    open(
      path: string,
      flags: number,
      attrs: Record<string, unknown>,
      callback: (err: Error | null, handle: Buffer) => void,
    ): void;
    close(handle: Buffer, callback: (err: Error | null) => void): void;
  } | null;
}

export class SSH2SFTPClientAdapter implements FileTransportClient {
  private client: Ssh2SftpClient;
  private options: Ssh2SftpClient.ConnectOptions | undefined;

  constructor() {
    this.client = new Ssh2SftpClient();
  }

  async connect(options: Record<string, unknown>): Promise<void> {
    const maxReconnects =
      (options["maxReconnectAttempts"] as number | undefined) ?? 3;
    // Exclude the psilink-specific key before handing options to ssh2.
    // FileTransportClient uses Record<string,unknown> so the interface stays
    // transport-agnostic; cast here is intentional.
    const { maxReconnectAttempts: _, ...rest } = options;
    const connectOptions = rest as Ssh2SftpClient.ConnectOptions;
    this.options = connectOptions;
    await retryPromise(
      () => this.client.connect(connectOptions),
      maxReconnects,
      1_000,
    );
    // Verify that the sftp session required by createExclusive is available.
    // Run this once after retryPromise resolves rather than inside its
    // callback so an API breakage (a permanent failure mode) does not consume
    // the retry budget with no chance of self-resolving.
    const { sftp } = this.client as unknown as Ssh2SftpClientInternals;
    if (!sftp)
      throw new Error(
        "ssh2-sftp-client 'sftp' session property is not available " +
          "after connect(); the installed version may no longer expose " +
          "it - check for breaking changes in the ssh2-sftp-client " +
          "changelog",
      );
  }

  end(): Promise<void> {
    return this.client.end().then(() => {});
  }

  list(path: string): Promise<FileInfo[]> {
    return this.client.list(path);
  }

  get(path: string, options?: GetOptions): Promise<Buffer<ArrayBufferLike>> {
    return this.client.get(path, undefined, {
      readStreamOptions: options,
    }) as Promise<Buffer<ArrayBufferLike>>;
  }

  put(
    src: string | Buffer | NodeJS.ReadableStream,
    dest: string,
    options?: PutOptions,
  ): Promise<unknown> {
    return retryPromise(
      () => this.client.put(src, dest, { writeStreamOptions: options }),
      this.options!.retries || 5,
      100,
    );
  }

  delete(path: string): Promise<void> {
    return this.client.delete(path).then(() => {});
  }

  safeDelete(path: string): Promise<void> {
    return retryPromise(
      () =>
        this.client.delete(path, true).then(
          () => {},
          () => {},
        ),
      1,
      100,
    );
  }

  rename(fromPath: string, toPath: string): Promise<void> {
    return this.client.rename(fromPath, toPath).then(() => {});
  }

  createExclusive(path: string): Promise<void> {
    // ssh2-sftp-client does not expose exclusive file creation; access the
    // underlying SFTP session to open with SSH_FXF_WRITE | SSH_FXF_CREAT |
    // SSH_FXF_EXCL (0x2A). SSH_FXF_EXCL is part of the core SFTPv3 protocol
    // and requires no server extension. Numeric flags are used directly instead
    // of a string alias ('wx') because SFTPWrapper's string-to-openmask
    // translator is not part of the public API contract, and an unrecognized
    // string would silently degrade to a non-exclusive open.
    //
    // On exclusive-create failure, SFTPv4+ servers return
    // SSH_FX_FILE_ALREADY_EXISTS (status 11), which is unambiguously mapped to
    // EEXIST. SFTPv3 servers — including OpenSSH in its default mode — return
    // SSH_FX_FAILURE (status 4), which is the generic SFTPv3 failure code and
    // does not distinguish "file already exists" from quota, permissions, or
    // other I/O errors. For code 4 this method calls exists() after the failure:
    // if the file is present, the exclusive-create lost a genuine lock-file race
    // (EEXIST); if the file is absent, the failure was a real I/O error and the
    // original error is propagated unchanged. This preserves correct lock-file
    // race recovery while surfacing I/O errors at synchronization time rather
    // than deferring them to the first send().
    //
    // ssh2 sets err.code to the numeric SFTP status code, not the POSIX
    // string "EEXIST". The string form is passed through unchanged in case a
    // future ssh2 version normalizes it first.
    //
    // ssh2-sftp-client stores the underlying ssh2 SFTPWrapper in `this.sftp`.
    // This has been true throughout the library's history and is true of the
    // version range in package.json (^12.0.1). There is no public method for
    // exclusive file creation, so we access this field via the file-scope
    // Ssh2SftpClientInternals interface. The null check below guards against
    // a closed or prematurely-ended session; an API rename is caught at
    // connect time by the check in connect().
    const { sftp } = this.client as unknown as Ssh2SftpClientInternals;
    if (!sftp)
      return Promise.reject(
        new Error(
          "SFTP session is not open; if this occurs after a successful " +
            "connect(), the ssh2-sftp-client internal API may have changed - " +
            "verify that the installed version still exposes the 'sftp' " +
            "session property",
        ),
      );
    // SSH_FXF_WRITE (0x02) | SSH_FXF_CREAT (0x08) | SSH_FXF_EXCL (0x20)
    const EXCL_WRITE_CREATE = 0x2a;
    return new Promise<void>((resolve, reject) => {
      sftp.open(path, EXCL_WRITE_CREATE, {}, (openErr, handle) => {
        if (openErr) {
          // Normalize SFTPv4+ FILE_ALREADY_EXISTS (11) directly to EEXIST.
          // SFTPv3 FAILURE (4) is ambiguous: resolve it via an exists() check
          // and normalize to EEXIST only when the file is actually present.
          // If a future ssh2 version already normalizes to the POSIX string
          // "EEXIST", pass the error through unchanged to avoid wrapping noise.
          // A new error is created for the numeric codes rather than mutating
          // openErr: ssh2 constructs a fresh error per callback, but treating
          // the caught object as immutable avoids surprising callers that
          // inspect the original.
          const errCode = (openErr as unknown as Record<string, unknown>).code;
          if (errCode === 11) {
            reject(
              Object.assign(new Error(openErr.message), {
                code: "EEXIST",
                cause: openErr,
              }),
            );
            return;
          }
          if (errCode === 4) {
            // If exists() itself rejects (e.g., a second network failure
            // immediately after the exclusive-open failure), the ambiguity
            // cannot be resolved; propagate openErr unchanged so the caller
            // sees the original I/O error rather than a confusing secondary
            // one.
            this.exists(path).then(
              (fileExists) => {
                reject(
                  fileExists
                    ? Object.assign(new Error(openErr.message), {
                        code: "EEXIST",
                        cause: openErr,
                      })
                    : Object.assign(
                        new Error(
                          `SFTP exclusive-create failed (SSH_FX_FAILURE) ` +
                            `and the target file is not present, so the ` +
                            `cause is a server-side I/O error rather than a ` +
                            `lock-file race. Check the SFTP server logs for ` +
                            `the underlying cause (disk full, permissions, ` +
                            `quota) before retrying; SFTPv3 cannot ` +
                            `distinguish a transient race from a permanent ` +
                            `failure, so a single retry is reasonable only ` +
                            `if a race is plausible. Original error: ` +
                            `${openErr.message}`,
                        ),
                        { cause: openErr },
                      ),
                );
              },
              () => reject(openErr),
            );
            return;
          }
          reject(openErr);
          return;
        }
        sftp.close(handle, (closeErr) => {
          if (closeErr) reject(closeErr);
          else resolve();
        });
      });
    });
  }

  exists(remotePath: string): Promise<boolean> {
    return this.client.exists(remotePath).then(Boolean);
  }
}
