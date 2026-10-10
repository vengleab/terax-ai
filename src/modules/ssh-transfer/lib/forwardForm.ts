import type { ForwardKind, ForwardSpec } from "../types";

export type ForwardType = ForwardKind["kind"];

export const FORWARD_TYPE_LABELS: Record<ForwardType, string> = {
  local: "Local (-L)",
  remote: "Remote (-R)",
  dynamic: "Dynamic SOCKS (-D)",
};

const DEFAULT_LISTEN_HOST = "127.0.0.1";

const MAX_NAME_LEN = 80;
const MAX_HOST_LEN = 253;
const HOST_CHARS = /^[A-Za-z0-9._:%-]+$/;
const DOTTED_OCTET = /^(0|[1-9]\d{0,2})$/;

/** `host` and `port` are the listen address (local, dynamic) or the bind address on the server (remote). */
export type ForwardFormValues = {
  name: string;
  type: ForwardType;
  host: string;
  port: string;
  destHost: string;
  destPort: string;
  expose: boolean;
};

type ForwardFormErrors = Partial<
  Record<"name" | "host" | "port" | "destHost" | "destPort" | "expose", string>
>;

type ForwardDraft = ForwardKind & {
  id?: string;
  profileId: string;
  name: string;
  autostart: boolean;
  expose: boolean;
};

export type ForwardFormResult =
  | { ok: true; value: ForwardDraft }
  | { ok: false; errors: ForwardFormErrors };

export type ForwardFormContext = {
  profileId: string;
  id?: string;
  autostart?: boolean;
};

function defaultsFor(type: ForwardType): { host: string; destHost: string } {
  return {
    host: DEFAULT_LISTEN_HOST,
    destHost: type === "remote" ? "localhost" : "",
  };
}

export function emptyForwardForm(
  type: ForwardType = "local",
): ForwardFormValues {
  const defaults = defaultsFor(type);
  return {
    name: "",
    type,
    host: defaults.host,
    port: "",
    destHost: defaults.destHost,
    destPort: "",
    expose: false,
  };
}

/** Switches the type and swaps in the new type's default hosts, but never overwrites typed values. */
export function changeForwardType(
  values: ForwardFormValues,
  type: ForwardType,
): ForwardFormValues {
  const before = defaultsFor(values.type);
  const after = defaultsFor(type);
  return {
    ...values,
    type,
    host: values.host === before.host ? after.host : values.host,
    destHost:
      values.destHost === before.destHost ? after.destHost : values.destHost,
  };
}

export function forwardToForm(spec: ForwardSpec): ForwardFormValues {
  if (spec.kind === "remote") {
    return {
      name: spec.name,
      type: "remote",
      host: spec.bindHost,
      port: String(spec.bindPort),
      destHost: spec.destHost,
      destPort: String(spec.destPort),
      expose: false,
    };
  }
  if (spec.kind === "local") {
    return {
      name: spec.name,
      type: "local",
      host: spec.listenHost,
      port: String(spec.listenPort),
      destHost: spec.destHost,
      destPort: String(spec.destPort),
      expose: spec.expose,
    };
  }
  return {
    name: spec.name,
    type: "dynamic",
    host: spec.listenHost,
    port: String(spec.listenPort),
    destHost: "",
    destPort: "",
    expose: spec.expose,
  };
}

function stripBrackets(host: string): string {
  return host.replace(/^\[+|\]+$/g, "");
}

function isLoopbackV4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  if (!parts.every((p) => DOTTED_OCTET.test(p) && Number(p) <= 255)) {
    return false;
  }
  return parts[0] === "127";
}

/** Mirrors the backend: `localhost`, 127.0.0.0/8 and ::1 listen only on this machine. */
export function isLoopbackHost(host: string): boolean {
  const bare = stripBrackets(host.trim());
  if (bare.toLowerCase() === "localhost") return true;
  if (isLoopbackV4(bare)) return true;
  return bare === "::1" || bare === "0:0:0:0:0:0:0:1";
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

function parsePort(text: string, min: number): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= 65535 ? value : null;
}

function hasControl(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Mirrors `ForwardSpec::validate` in the Rust crate. */
export function validateForwardForm(
  values: ForwardFormValues,
  context: ForwardFormContext,
): ForwardFormResult {
  const errors: ForwardFormErrors = {};

  const name = values.name.trim();
  if (!name) errors.name = "Enter a name";
  else if (Array.from(name).length > MAX_NAME_LEN) {
    errors.name = "Name must be 80 characters or fewer";
  } else if (hasControl(name)) {
    errors.name = "Name cannot contain control characters";
  }

  const host = values.host.trim();
  const hostProblem = hostError(stripBrackets(host));
  if (hostProblem) errors.host = hostProblem;

  const port = parsePort(values.port, 0);
  if (port === null) {
    errors.port =
      values.type === "remote"
        ? "Port must be a whole number from 0 to 65535"
        : "Port must be a whole number from 0 to 65535, where 0 picks a free port";
  }

  let dest: { host: string; port: number } | null = null;
  if (values.type !== "dynamic") {
    const destHost = values.destHost.trim();
    const destHostProblem = hostError(destHost);
    if (destHostProblem) errors.destHost = destHostProblem;
    const destPort = parsePort(values.destPort, 1);
    if (destPort === null) {
      errors.destPort = "Port must be a whole number from 1 to 65535";
    }
    if (!destHostProblem && destPort !== null) {
      dest = { host: destHost, port: destPort };
    }
  }

  const listensLocally = values.type !== "remote";
  const loopback = isLoopbackHost(host);
  if (listensLocally && !loopback && !values.expose && !errors.host) {
    errors.expose = "Turn on Expose to my network to listen on this address";
  }

  if (Object.keys(errors).length > 0 || port === null) {
    return { ok: false, errors };
  }

  const base = {
    ...(context.id ? { id: context.id } : {}),
    profileId: context.profileId,
    name,
    autostart: context.autostart ?? false,
    expose: listensLocally && !loopback && values.expose,
  };

  if (values.type === "dynamic") {
    return {
      ok: true,
      value: { ...base, kind: "dynamic", listenHost: host, listenPort: port },
    };
  }
  if (!dest) return { ok: false, errors };
  if (values.type === "remote") {
    return {
      ok: true,
      value: {
        ...base,
        kind: "remote",
        bindHost: host,
        bindPort: port,
        destHost: dest.host,
        destPort: dest.port,
      },
    };
  }
  return {
    ok: true,
    value: {
      ...base,
      kind: "local",
      listenHost: host,
      listenPort: port,
      destHost: dest.host,
      destPort: dest.port,
    },
  };
}

function hostPort(host: string, port: number | "auto"): string {
  const bare = stripBrackets(host);
  const shown = bare.includes(":") ? `[${bare}]` : bare;
  return `${shown}:${port}`;
}

function listenPort(port: number): number | "auto" {
  return port === 0 ? "auto" : port;
}

/** One line for a forward, using ASCII arrows: `127.0.0.1:8080 -> db.internal:5432`. */
export function describeForward(spec: ForwardKind): string {
  if (spec.kind === "local") {
    return `${hostPort(spec.listenHost, listenPort(spec.listenPort))} -> ${hostPort(spec.destHost, spec.destPort)}`;
  }
  if (spec.kind === "remote") {
    const bind = isLoopbackHost(spec.bindHost)
      ? `server:${listenPort(spec.bindPort)}`
      : `server ${hostPort(spec.bindHost, listenPort(spec.bindPort))}`;
    return `${bind} -> ${hostPort(spec.destHost, spec.destPort)}`;
  }
  return `SOCKS5 on ${hostPort(spec.listenHost, listenPort(spec.listenPort))}`;
}
