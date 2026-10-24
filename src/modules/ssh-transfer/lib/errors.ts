import type {
  ErrorCode,
  HopErrorData,
  HostKeyErrorData,
} from "../types";

export class SshApiError extends Error {
  readonly code: ErrorCode | "unknown";
  readonly data: unknown;

  constructor(code: ErrorCode | "unknown", message: string, data?: unknown) {
    super(message);
    this.name = "SshApiError";
    this.code = code;
    this.data = data;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Tauri rejects with the serialized SshError object, or a plain string for framework errors. */
export function toApiError(value: unknown): SshApiError {
  if (value instanceof SshApiError) return value;
  if (isRecord(value) && typeof value.message === "string") {
    const code = typeof value.code === "string" ? value.code : "unknown";
    return new SshApiError(code as ErrorCode, value.message, value.data);
  }
  if (typeof value === "string") return new SshApiError("unknown", value);
  if (value instanceof Error) return new SshApiError("unknown", value.message);
  return new SshApiError("unknown", "Something went wrong");
}

export function isCancelled(error: unknown): boolean {
  return toApiError(error).code === "cancelled";
}

export function hostKeyData(error: SshApiError): HostKeyErrorData | null {
  const data = error.data;
  if (!isRecord(data) || !isRecord(data.presented)) return null;
  if (typeof data.host !== "string" || typeof data.port !== "number") {
    return null;
  }
  return data as unknown as HostKeyErrorData;
}

export function hopData(error: SshApiError): HopErrorData | null {
  const data = error.data;
  if (!isRecord(data)) return null;
  if (typeof data.host !== "string" || typeof data.port !== "number") {
    return null;
  }
  return { host: data.host, port: data.port };
}

export function errorMessage(error: unknown): string {
  return toApiError(error).message;
}
