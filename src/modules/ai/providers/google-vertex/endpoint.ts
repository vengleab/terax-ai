export const DEFAULT_LOCATION = "global";
export const DEFAULT_MODEL = "gemini-2.5-flash";

/** The location becomes part of a hostname, so it is checked strictly. */
const LOCATION_PATTERN = /^(global|[a-z]+-[a-z]+[0-9]+)$/;
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,99}$/;

export const LOCATION_SUGGESTIONS = [
  "global",
  "us-central1",
  "us-east1",
  "us-east4",
  "us-east5",
  "us-west1",
  "us-west4",
  "europe-west1",
  "europe-west4",
  "europe-west9",
  "asia-northeast1",
  "asia-southeast1",
] as const;

export const MODEL_SUGGESTIONS = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"] as const;

export function isValidLocation(value: string): boolean {
  return LOCATION_PATTERN.test(value);
}

export function isValidProject(value: string): boolean {
  return PROJECT_PATTERN.test(value);
}

export function vertexHost(location: string): string {
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

/** Base URL of Vertex AI's OpenAI-compatible API. Chat completions go to `<base>/chat/completions`. */
export function vertexBaseUrl(project: string, location: string): string {
  if (!isValidLocation(location)) {
    throw new Error(`"${location}" is not a valid Google Cloud location. Use for example global or us-central1.`);
  }
  if (!isValidProject(project)) {
    throw new Error(`"${project}" is not a valid Google Cloud project id.`);
  }
  return `https://${vertexHost(location)}/v1/projects/${encodeURIComponent(project)}/locations/${location}/endpoints/openapi`;
}

/** Vertex's OpenAI-compatible API names models as `<publisher>/<model>`. */
export function vertexModelName(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) throw new Error("No Gemini model is set. Open Settings, Models and enter one.");
  return trimmed.includes("/") ? trimmed : `google/${trimmed}`;
}
