/** Sets the `model` field of a JSON request body, leaving everything else as sent. */
export function rewriteModel(
  body: BodyInit | null | undefined,
  modelId: string,
): BodyInit | null | undefined {
  if (typeof body !== "string") return body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...(parsed as Record<string, unknown>), model: modelId });
    }
  } catch {
    // not JSON, send as is
  }
  return body;
}
