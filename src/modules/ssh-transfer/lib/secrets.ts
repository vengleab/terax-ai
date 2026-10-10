import { invoke } from "@tauri-apps/api/core";

const SERVICE = "terax-ssh-transfer";

export type SecretKind = "password" | "passphrase";

export function secretAccount(profileId: string, kind: SecretKind): string {
  return `${profileId}:${kind}`;
}

export async function getSecret(
  profileId: string,
  kind: SecretKind,
): Promise<string | null> {
  try {
    const value = await invoke<string | null>("secrets_get", {
      service: SERVICE,
      account: secretAccount(profileId, kind),
    });
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function setSecret(
  profileId: string,
  kind: SecretKind,
  value: string,
): Promise<void> {
  await invoke("secrets_set", {
    service: SERVICE,
    account: secretAccount(profileId, kind),
    password: value,
  });
}

export async function clearSecret(
  profileId: string,
  kind: SecretKind,
): Promise<void> {
  try {
    await invoke("secrets_delete", {
      service: SERVICE,
      account: secretAccount(profileId, kind),
    });
  } catch {
    // already absent
  }
}

export async function clearProfileSecrets(profileId: string): Promise<void> {
  await Promise.all([
    clearSecret(profileId, "password"),
    clearSecret(profileId, "passphrase"),
  ]);
}
