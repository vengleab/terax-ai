import type { EndpointRef, SshProfile } from "../types";

export const LOCAL_LABEL = "This computer";

export function endpointLabel(endpoint: EndpointRef, profiles: SshProfile[]): string {
  if (endpoint.kind === "local") return LOCAL_LABEL;
  return profiles.find((p) => p.id === endpoint.profileId)?.name ?? "Server";
}
