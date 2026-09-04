/**
 * Body-shape helpers shared by the same-origin job-API clients. Both the
 * work-input and SFTP-authoring clients narrow a console response before
 * reading fields off it, so the narrowing lives once here.
 */

/** Narrow a decoded body to a plain object, excluding null and arrays, so a
 * caller can read named fields off it. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Decode a response body as JSON, or null when it is empty or not JSON (an
 * error response may have no body). */
export async function readJsonOrNull(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
