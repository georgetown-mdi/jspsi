import Ssh2SftpClient from "ssh2-sftp-client";
import {
  FileInfo,
  FileTransportClient,
  GetOptions,
  PutOptions,
  retryPromise,
} from "@psilink/core";

export class SSH2SFTPClientAdapter implements FileTransportClient {
  private client: Ssh2SftpClient;
  private options: Ssh2SftpClient.ConnectOptions | undefined;

  constructor() {
    this.client = new Ssh2SftpClient();
  }

  connect(options: Record<string, unknown>): Promise<void> {
    const maxReconnects =
      (options["maxReconnectAttempts"] as number | undefined) ?? 3;
    // Exclude the psilink-specific key before handing options to ssh2.
    // FileTransportClient uses Record<string,unknown> so the interface stays
    // transport-agnostic; cast here is intentional.
    const { maxReconnectAttempts: _, ...rest } = options;
    const connectOptions = rest as Ssh2SftpClient.ConnectOptions;
    this.options = connectOptions;
    return retryPromise(
      () => this.client.connect(connectOptions).then(() => {}),
      maxReconnects,
      1_000,
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

  exists(remotePath: string): Promise<boolean> {
    return this.client.exists(remotePath).then(Boolean);
  }
}
