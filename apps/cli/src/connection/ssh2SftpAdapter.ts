import Ssh2SftpClient from "ssh2-sftp-client";
import {
  FileInfo,
  GetOptions,
  PutOptions,
  retryPromise,
  SFTPClient,
} from "@psilink/core";

export class SSH2SFTPClientAdapter implements SFTPClient {
  private client: Ssh2SftpClient;
  private options: Ssh2SftpClient.ConnectOptions | undefined;

  constructor() {
    this.client = new Ssh2SftpClient();
  }

  connect(options: object): Promise<void> {
    this.options = options;
    return this.client.connect(options).then(() => {});
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

  exists(remotePath: string): Promise<boolean | string> {
    return this.client.exists(remotePath);
  }
}
