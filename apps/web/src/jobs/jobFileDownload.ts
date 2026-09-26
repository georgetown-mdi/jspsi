import { Readable } from "node:stream";
import fsp from "node:fs/promises";

import { JOB_RESPONSE_HEADERS } from "./gate";

/** What a job artifact is served as: its media type and download name. */
export interface JobFileDownload {
  /** The full `Content-Type` value, charset included. */
  contentType: string;
  /** The fixed, server-derived name in the `Content-Disposition` header. */
  fileName: string;
}

/**
 * Serve a job's server-chosen file as a private attachment, streamed rather than
 * read whole: nosniff, no-store, and the given type and download name.
 *
 * The path must be one the caller composed inside the job's workdir, never one
 * derived from client input. Rejects, before any response exists, when the file
 * cannot be opened or is not a regular file; the caller decides what that is.
 */
export async function jobFileDownloadResponse(
  filePath: string,
  download: JobFileDownload,
): Promise<Response> {
  const handle = await fsp.open(filePath, "r");
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("the job file is not a regular file");
  } catch (error) {
    await handle.close();
    throw error;
  }
  const body = Readable.toWeb(
    handle.createReadStream(),
  ) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": download.contentType,
      "Content-Disposition": `attachment; filename="${download.fileName}"`,
      "X-Content-Type-Options": "nosniff",
      ...JOB_RESPONSE_HEADERS,
    },
  });
}
