import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type {
  Request as PSIRequest,
  Response as PSIResponse,
} from "@openmined/psi.js/implementation/proto/psi_pb.d.ts";

// Splitting one PSI crypto operation into chunks, and reassembling the chunk
// results into the message a single call over the whole set produces. The
// engine (psiEngine.ts) uses it to report a processed count part-way through an
// operation the library would otherwise run as one blocking call; the worker
// sharding bench (test/bench/shardedPsiWasmBench.ts) uses the same merges
// across parallel engines built from one key.
//
// The merge rules, established by driving the vendored engine rather than read
// off its source, and pinned by test/psi/psiEngineChunkIdentity.test.ts on
// every backend the platform has:
//
//   - a Raw server setup holds its masked elements sorted by their bytes, and
//     the sorting permutation maps each sorted position to the input index; the
//     engine's sort is not stable, so which input index a REPEATED value's
//     position takes is an artifact of that sort and a merge cannot reproduce
//     it. The protocol masks distinct values (link.ts masks distinctValues),
//     which is the condition under which the merged permutation is the
//     engine's, and equal values mask to equal bytes, so the merged WIRE bytes
//     match either way;
//   - a request holds its elements in input order, so chunk results
//     concatenate;
//   - an identifier-revealing response holds its elements in the request's
//     order, so those chunk results concatenate too, while a COUNT-ONLY
//     response is sorted by element bytes -- the shuffle that keeps the
//     receiver from pairing a response element with the request position it
//     answers -- so its chunk results merge by that order instead;
//   - an association table holds its pairs in partner-index order, ties broken
//     by local index.

/** A contiguous slice of a value or element list, covered by one chunk. */
export interface PsiChunkRange {
  readonly start: number;
  readonly end: number;
}

/**
 * The smallest set a chunk may cover. The native addon parallelises one call
 * across threads only above its own per-thread floor, below which a chunk runs
 * single-threaded: measured on 10 cores, a 1,000-element call costs 80 us per
 * element against 10.8 us at 20,000, so a chunk under a few thousand elements
 * throws the addon's 6-7x away. A set at or below this floor therefore takes
 * exactly one chunk and runs the single call it always ran.
 */
export const PSI_CHUNK_MIN_ELEMENTS = 8192;

/**
 * The most chunks one operation is split into. Every chunk costs the match
 * operations a re-read of the whole held server setup, so the overhead grows
 * with the chunk COUNT rather than the chunk size: measured at 100,000
 * elements, five chunks keep the association table inside run-to-run noise
 * (~5%) where ten chunks cost up to 41%.
 */
export const PSI_CHUNK_TARGET_COUNT = 5;

/**
 * How many chunks a `total`-element operation is split into: at most
 * {@link PSI_CHUNK_TARGET_COUNT}, and never so many that a chunk would fall
 * below {@link PSI_CHUNK_MIN_ELEMENTS}. Always at least one, so an empty or
 * small set runs exactly as it did before.
 */
export function psiChunkCount(total: number): number {
  return Math.max(
    1,
    Math.min(
      PSI_CHUNK_TARGET_COUNT,
      Math.floor(total / PSI_CHUNK_MIN_ELEMENTS),
    ),
  );
}

/** The ranges {@link psiChunkCount} chunks a `total`-element operation into. */
export function psiChunkRanges(total: number): PsiChunkRange[] {
  return chunkRanges(total, psiChunkCount(total));
}

/**
 * Splits `total` items into `count` contiguous ranges whose sizes differ by at
 * most one. Contiguous rather than strided so every merge below can restore an
 * original index from a chunk offset alone.
 */
export function chunkRanges(total: number, count: number): PsiChunkRange[] {
  const ranges: PsiChunkRange[] = [];
  let start = 0;
  for (let chunk = 0; chunk < count; chunk += 1) {
    const size = Math.floor((total - start) / (count - chunk));
    ranges.push({ start, end: start + size });
    start += size;
  }
  return ranges;
}

/**
 * The ranges splitting `total` items into chunks of at most `size`, for a
 * caller that sets the chunk size itself rather than taking the measured
 * policy above.
 */
export function chunkRangesOfSize(
  total: number,
  size: number,
): PsiChunkRange[] {
  return chunkRanges(total, Math.max(1, Math.ceil(total / Math.max(1, size))));
}

/** Orders two masked elements the way the engine's setup sort does. */
export function compareElementBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** One chunk's masked setup: its own sorted elements and sorting permutation. */
export interface PsiSetupChunk {
  readonly start: number;
  readonly elements: ReadonlyArray<Uint8Array>;
  readonly permutation: ReadonlyArray<number>;
}

/** A setup reassembled from chunks: the element order and its permutation. */
export interface MergedPsiSetup {
  readonly elements: Uint8Array[];
  readonly permutation: number[];
}

/**
 * Reassembles a server setup from chunk results, reproducing the element order
 * and the sorting permutation a single engine emits for the same key and
 * inputs.
 */
export function mergeSetupChunks(
  chunks: ReadonlyArray<PsiSetupChunk>,
): MergedPsiSetup {
  const pairs: Array<{ element: Uint8Array; inputIndex: number }> = [];
  for (const chunk of chunks)
    for (let position = 0; position < chunk.elements.length; position += 1)
      pairs.push({
        element: chunk.elements[position]!,
        inputIndex: chunk.start + chunk.permutation[position]!,
      });
  pairs.sort(
    (a, b) =>
      compareElementBytes(a.element, b.element) || a.inputIndex - b.inputIndex,
  );
  return {
    elements: pairs.map((pair) => pair.element),
    permutation: pairs.map((pair) => pair.inputIndex),
  };
}

/** One chunk's association result, indexed within the chunk's own slice. */
export interface PsiAssociationChunk {
  readonly start: number;
  readonly localIndices: ReadonlyArray<number>;
  readonly partnerIndices: ReadonlyArray<number>;
}

/**
 * Reassembles an association table from chunk results, reproducing the pair
 * order a single engine emits: partner index ascending, ties by local index.
 */
export function mergeAssociationChunks(
  chunks: ReadonlyArray<PsiAssociationChunk>,
): [number[], number[]] {
  const pairs: Array<[number, number]> = [];
  for (const chunk of chunks)
    for (let index = 0; index < chunk.localIndices.length; index += 1)
      pairs.push([
        chunk.start + chunk.localIndices[index]!,
        chunk.partnerIndices[index]!,
      ]);
  pairs.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return [pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1])];
}

/** Concatenates chunk element lists, which the engine emits in input order. */
export function concatChunkElements(
  chunks: ReadonlyArray<ReadonlyArray<Uint8Array>>,
): Uint8Array[] {
  return chunks.flatMap((chunk) => [...chunk]);
}

/**
 * Reassembles a server response from chunk results, in the order a single call
 * over the whole request emits: the request's own order under
 * `revealsIdentifiers`, and element-byte order without it, where the library
 * sorts the response rather than answering position by position.
 */
export function mergeResponseChunks(
  chunks: ReadonlyArray<ReadonlyArray<Uint8Array>>,
  revealsIdentifiers: boolean,
): Uint8Array[] {
  const elements = concatChunkElements(chunks);
  return revealsIdentifiers ? elements : elements.sort(compareElementBytes);
}

function toElementList(elements: ReadonlyArray<Uint8Array>): Uint8Array[] {
  return [...elements];
}

/** Builds the serialized Raw server setup a merged element list stands for. */
export function serializeSetup(
  psi: PSILibrary,
  elements: ReadonlyArray<Uint8Array>,
): Uint8Array {
  const raw = new psi.serverSetup.RawInfo();
  raw.setEncryptedElementsList(toElementList(elements));
  const setup = new psi.serverSetup();
  setup.setRaw(raw);
  return setup.serializeBinary();
}

/**
 * Builds the request message `elements` stands for, under `revealIntersection`
 * -- the flag that rides the request on the wire and that the partner's server
 * enforces agreement on, so it is passed rather than assumed.
 */
export function buildRequest(
  psi: PSILibrary,
  elements: ReadonlyArray<Uint8Array>,
  revealIntersection: boolean,
): PSIRequest {
  const request = new psi.request();
  request.setRevealIntersection(revealIntersection);
  request.setEncryptedElementsList(toElementList(elements));
  return request;
}

/** Builds the serialized request a merged element list stands for. */
export function serializeRequest(
  psi: PSILibrary,
  elements: ReadonlyArray<Uint8Array>,
  revealIntersection: boolean,
): Uint8Array {
  return buildRequest(psi, elements, revealIntersection).serializeBinary();
}

/** Builds the response message `elements` stands for. */
export function buildResponse(
  psi: PSILibrary,
  elements: ReadonlyArray<Uint8Array>,
): PSIResponse {
  const response = new psi.response();
  response.setEncryptedElementsList(toElementList(elements));
  return response;
}

/** Builds the serialized response a merged element list stands for. */
export function serializeResponse(
  psi: PSILibrary,
  elements: ReadonlyArray<Uint8Array>,
): Uint8Array {
  return buildResponse(psi, elements).serializeBinary();
}
