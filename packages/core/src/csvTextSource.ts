import type { LocalFile } from "papaparse";

/**
 * The Node `Readable` members a CSV source is read through, duck-typed so
 * `@alcove/core` needs no `node:stream` import (which would pull it into the
 * web bundle).
 */
type NodeByteSource = {
  on: (event: string, listener: (arg: never) => void) => unknown;
  removeListener?: (event: string, listener: (arg: never) => void) => unknown;
  pause?: () => unknown;
  resume?: () => unknown;
};

/** A `Blob` (a browser `File`) read through its web byte stream. */
type BlobByteSource = {
  stream: () => ReadableStream<Uint8Array>;
};

type Listener = (arg?: unknown) => void;

/**
 * A CSV source decoded to text as one UTF-8 stream, in the `Readable` shape
 * PapaParse drives with its stream reader (`readable`, `read`, `on`, `pause`,
 * `resume`, `removeListener`), plus {@link release} to stop reading.
 *
 * PapaParse decodes each chunk of a byte source on its own -- a Node `Buffer`
 * with `toString`, a `File` slice with `FileReader.readAsText` -- so a
 * multi-byte character split across two chunks becomes two U+FFFD. One
 * `TextDecoder` in streaming mode holds the partial character over to the next
 * chunk instead. Decoding is non-fatal: an invalid byte becomes U+FFFD, as it
 * did under PapaParse's own decode.
 *
 * The leading text is held back until its first line terminator can be
 * classified -- an LF, or a CR with the character after it -- because PapaParse
 * picks the file's newline from its first chunk alone: a header longer than one
 * read chunk would otherwise be read as LF-terminated, leaving a CR on every
 * last-column value of a CRLF file. The held text is bounded by the caller's
 * single-line byte ceiling.
 */
export class DecodedCSVTextSource {
  /** Read by PapaParse to select its stream reader. */
  readonly readable = true;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly decoder = new TextDecoder("utf-8");
  private leading: string | undefined = "";
  private started = false;
  private released = false;

  constructor(
    private readonly driver: {
      start: (sink: DecodedCSVTextSource) => void;
      pause: () => void;
      resume: () => void;
      release: () => void;
    },
  ) {}

  /** Part of the `Readable` shape PapaParse checks for; data arrives by event. */
  read(): null {
    return null;
  }

  /** Register `listener`; the first `data` listener starts the read. */
  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    if (event === "data" && !this.started) {
      this.started = true;
      this.driver.start(this);
    }
    return this;
  }

  /** Remove a listener {@link on} registered. */
  removeListener(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  /** Stop delivering chunks until {@link resume}. */
  pause(): void {
    this.driver.pause();
  }

  /** Resume delivery after {@link pause}. */
  resume(): void {
    this.driver.resume();
  }

  /** Stop reading the underlying source; no event is delivered after this. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.driver.release();
  }

  /** Driver callback: one chunk of the source. */
  pushChunk(chunk: Uint8Array | string): void {
    if (this.released) return;
    const text =
      typeof chunk === "string"
        ? chunk
        : this.decoder.decode(chunk, { stream: true });
    if (this.leading !== undefined) {
      this.leading += text;
      if (!leadingTerminatorClassifiable(this.leading)) return;
      const held = this.leading;
      this.leading = undefined;
      this.emit("data", held);
      return;
    }
    if (text !== "") this.emit("data", text);
  }

  /** Driver callback: the source ended. */
  end(): void {
    if (this.released) return;
    const tail = (this.leading ?? "") + this.decoder.decode();
    this.leading = undefined;
    if (tail !== "") this.emit("data", tail);
    this.emit("end");
  }

  /** Driver callback: the source failed. */
  fail(error: unknown): void {
    if (this.released) return;
    this.emit("error", error);
  }

  private emit(event: string, arg?: unknown): void {
    const set = this.listeners.get(event);
    if (set === undefined) return;
    for (const listener of [...set]) listener(arg);
  }
}

function leadingTerminatorClassifiable(text: string): boolean {
  const lf = text.indexOf("\n");
  const cr = text.indexOf("\r");
  if (cr === -1) return lf !== -1;
  if (lf !== -1 && lf < cr) return true;
  return cr < text.length - 1;
}

function isNodeByteSource(file: unknown): file is NodeByteSource {
  return typeof (file as Partial<NodeByteSource>).on === "function";
}

function isBlobByteSource(file: unknown): file is BlobByteSource {
  return typeof (file as Partial<BlobByteSource>).stream === "function";
}

function nodeDriver(source: NodeByteSource) {
  let detach = (): void => undefined;
  return {
    start(sink: DecodedCSVTextSource): void {
      const onData = (chunk: Uint8Array | string): void =>
        sink.pushChunk(chunk);
      const onEnd = (): void => sink.end();
      const onError = (error: unknown): void => sink.fail(error);
      source.on("data", onData);
      source.on("end", onEnd);
      // The error listener stays attached after release, so a late source
      // error is not an unhandled `error` event.
      source.on("error", onError);
      detach = () => {
        source.removeListener?.("data", onData);
        source.removeListener?.("end", onEnd);
      };
    },
    pause: (): void => void source.pause?.(),
    resume: (): void => void source.resume?.(),
    release: (): void => detach(),
  };
}

function blobDriver(source: BlobByteSource) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let released = false;
  let paused = false;
  let pendingStep: (() => void) | undefined;
  return {
    start(sink: DecodedCSVTextSource): void {
      const activeReader = source.stream().getReader();
      reader = activeReader;
      const step = (): void => {
        if (released) return;
        if (paused) {
          pendingStep = step;
          return;
        }
        activeReader
          .read()
          .then(({ done, value }) => {
            if (released) return;
            if (done) {
              sink.end();
              return;
            }
            sink.pushChunk(value);
            step();
          })
          .catch((error: unknown) => sink.fail(error));
      };
      step();
    },
    pause: (): void => {
      paused = true;
    },
    resume: (): void => {
      paused = false;
      const next = pendingStep;
      pendingStep = undefined;
      next?.();
    },
    release: (): void => {
      released = true;
      reader?.cancel().catch(() => undefined);
    },
  };
}

/**
 * Wrap a CSV source in a {@link DecodedCSVTextSource}: a Node stream (the CLI's
 * file or stdin, the console server's opened input) or a `Blob` (the web app's
 * `File`). Returns `undefined` for an input with neither shape, which the
 * caller hands to PapaParse unchanged.
 */
export function decodedCSVTextSource(
  file: LocalFile,
): DecodedCSVTextSource | undefined {
  if (isNodeByteSource(file)) return new DecodedCSVTextSource(nodeDriver(file));
  if (isBlobByteSource(file)) return new DecodedCSVTextSource(blobDriver(file));
  return undefined;
}
