import type { AuthMethod, SshProfile } from "../types";

const DEFAULT_PORT = 22;
const DEFAULT_KEEPALIVE_SECS = 30;

const MAX_KEEPALIVE_SECS = 3600;
const MAX_TAGS = 16;
const MAX_TAG_LEN = 32;
const MAX_NAME_LEN = 80;
const MAX_HOST_LEN = 253;
const MAX_USER_LEN = 64;
const MAX_PATH_LEN = 4096;

const HOST_CHARS = /^[A-Za-z0-9._:%-]+$/;
const USER_CHARS = /^[A-Za-z0-9._+@-]+$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const WORD_COLOR = /^[A-Za-z0-9-]{1,16}$/;

export const PROFILE_COLORS: readonly { name: string; value: string }[] = [
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Yellow", value: "#eab308" },
  { name: "Green", value: "#22c55e" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Violet", value: "#8b5cf6" },
  { name: "Pink", value: "#ec4899" },
];

export type AuthKind = AuthMethod["kind"];

export type ProfileFormValues = {
  name: string;
  host: string;
  port: string;
  user: string;
  authKind: AuthKind;
  keyPath: string;
  jumpHost: string | null;
  keepaliveSecs: string;
  defaultRemoteDir: string;
  color: string | null;
  tags: string;
  favorite: boolean;
};

type ProfileFormInput = Pick<
  SshProfile,
  | "name"
  | "host"
  | "port"
  | "user"
  | "auth"
  | "jumpHost"
  | "keepaliveSecs"
  | "color"
  | "tags"
  | "favorite"
  | "defaultRemoteDir"
>;

type ProfileFormErrors = Partial<
  Record<
    | "name"
    | "host"
    | "port"
    | "user"
    | "keyPath"
    | "jumpHost"
    | "keepaliveSecs"
    | "defaultRemoteDir"
    | "color"
    | "tags",
    string
  >
>;

export type ProfileFormResult =
  | { ok: true; value: ProfileFormInput }
  | { ok: false; errors: ProfileFormErrors };

export function emptyProfileForm(): ProfileFormValues {
  return {
    name: "",
    host: "",
    port: String(DEFAULT_PORT),
    user: "",
    authKind: "agent",
    keyPath: "",
    jumpHost: null,
    keepaliveSecs: String(DEFAULT_KEEPALIVE_SECS),
    defaultRemoteDir: "",
    color: null,
    tags: "",
    favorite: false,
  };
}

export function profileToForm(profile: SshProfile): ProfileFormValues {
  return {
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    user: profile.user,
    authKind: profile.auth.kind,
    keyPath: profile.auth.kind === "keyFile" ? profile.auth.path : "",
    jumpHost: profile.jumpHost,
    keepaliveSecs: String(profile.keepaliveSecs),
    defaultRemoteDir: profile.defaultRemoteDir ?? "",
    color: profile.color,
    tags: profile.tags.join(", "),
    favorite: profile.favorite,
  };
}

/** Splits comma separated text into trimmed, non-empty, unique tags in first-seen order. */
export function parseTags(text: string): string[] {
  const tags: string[] = [];
  for (const part of text.split(",")) {
    const tag = part.trim();
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** Servers that may be chosen as a jump host: any other server that does not itself use one. */
export function jumpHostCandidates(
  profiles: readonly SshProfile[],
  selfId?: string,
): SshProfile[] {
  return profiles.filter((p) => p.id !== selfId && !p.jumpHost);
}

/** A server that others jump through cannot get a jump host of its own. */
export function isJumpHostForOthers(
  profiles: readonly SshProfile[],
  id: string,
): boolean {
  return profiles.some((p) => p.jumpHost === id);
}

function hasControl(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function charCount(value: string): number {
  return Array.from(value).length;
}

function parseInteger(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

function pathError(value: string): boolean {
  return value.length > MAX_PATH_LEN || value.includes("\0");
}

function hostError(host: string): string | null {
  if (!host) return "Enter a host name or IP address";
  if (host.length > MAX_HOST_LEN) return "Host is too long";
  if (host.startsWith("-")) return "Host cannot start with a dash";
  if (!HOST_CHARS.test(host)) {
    return "Host can only contain letters, digits and . - _ : %";
  }
  return null;
}

function userError(user: string): string | null {
  if (!user) return "Enter a user name";
  if (user.length > MAX_USER_LEN) return "User must be 64 characters or fewer";
  if (user.startsWith("-")) return "User cannot start with a dash";
  if (!USER_CHARS.test(user)) {
    return "User can only contain letters, digits and . _ - + @";
  }
  return null;
}

/** Mirrors `SshProfile::validate` in the Rust crate so the backend rarely has to refuse. */
export function validateProfileForm(
  values: ProfileFormValues,
  options: { selfId?: string } = {},
): ProfileFormResult {
  const errors: ProfileFormErrors = {};

  const name = values.name.trim();
  if (!name) errors.name = "Enter a name";
  else if (charCount(name) > MAX_NAME_LEN) {
    errors.name = "Name must be 80 characters or fewer";
  } else if (hasControl(name)) {
    errors.name = "Name cannot contain control characters";
  }

  const host = values.host.trim();
  const hostProblem = hostError(host);
  if (hostProblem) errors.host = hostProblem;

  const user = values.user.trim();
  const userProblem = userError(user);
  if (userProblem) errors.user = userProblem;

  const port = parseInteger(values.port, 1, 65535);
  if (port === null)
    errors.port = "Port must be a whole number from 1 to 65535";

  const keepaliveSecs = parseInteger(
    values.keepaliveSecs,
    0,
    MAX_KEEPALIVE_SECS,
  );
  if (keepaliveSecs === null) {
    errors.keepaliveSecs = "Keepalive must be a whole number from 0 to 3600";
  }

  let auth: AuthMethod = { kind: "agent" };
  if (values.authKind === "password") {
    auth = { kind: "password" };
  } else if (values.authKind === "keyFile") {
    const path = values.keyPath.trim();
    if (!path) errors.keyPath = "Enter the path to a private key";
    else if (pathError(path)) errors.keyPath = "That is not a valid path";
    auth = { kind: "keyFile", path };
  }

  if (
    values.jumpHost !== null &&
    options.selfId !== undefined &&
    values.jumpHost === options.selfId
  ) {
    errors.jumpHost = "A server cannot jump through itself";
  }

  const dir = values.defaultRemoteDir.trim();
  if (dir && pathError(dir))
    errors.defaultRemoteDir = "That is not a valid path";

  const color = values.color?.trim() || null;
  if (color && !HEX_COLOR.test(color) && !WORD_COLOR.test(color)) {
    errors.color = "Color must be #rrggbb";
  }

  const tags = parseTags(values.tags);
  if (tags.length > MAX_TAGS) {
    errors.tags = "Use at most 16 tags";
  } else if (tags.some((t) => charCount(t) > MAX_TAG_LEN || hasControl(t))) {
    errors.tags = "Each tag must be 1 to 32 printable characters";
  }

  if (
    Object.keys(errors).length > 0 ||
    port === null ||
    keepaliveSecs === null
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      name,
      host,
      port,
      user,
      auth,
      jumpHost: values.jumpHost,
      keepaliveSecs,
      color: color && HEX_COLOR.test(color) ? color.toLowerCase() : color,
      tags,
      favorite: values.favorite,
      defaultRemoteDir: dir || null,
    },
  };
}
