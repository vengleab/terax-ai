import type { ConnectionInfo, ConnectRequest, SshProfile } from "../types";
import { sshApi } from "./api";
import { hopData, hostKeyData, SshApiError, toApiError } from "./errors";
import { clearSecret, getSecret, setSecret, type SecretKind } from "./secrets";
import { askHostKey, askSecret } from "../store/promptStore";

const MAX_ATTEMPTS = 8;

type Collected = Pick<
  ConnectRequest,
  "password" | "keyPassphrase" | "jumpPassword" | "jumpKeyPassphrase"
>;

type Remember = { profileId: string; kind: SecretKind; value: string };

function secretKindFor(profile: SshProfile): SecretKind | null {
  if (profile.auth.kind === "password") return "password";
  if (profile.auth.kind === "keyFile") return "passphrase";
  return null;
}

async function storedSecrets(target: SshProfile, jump: SshProfile | null): Promise<Collected> {
  const out: Collected = {};
  const targetKind = secretKindFor(target);
  if (targetKind) {
    const value = await getSecret(target.id, targetKind);
    if (value) {
      if (targetKind === "password") out.password = value;
      else out.keyPassphrase = value;
    }
  }
  const jumpKind = jump ? secretKindFor(jump) : null;
  if (jump && jumpKind) {
    const value = await getSecret(jump.id, jumpKind);
    if (value) {
      if (jumpKind === "password") out.jumpPassword = value;
      else out.jumpKeyPassphrase = value;
    }
  }
  return out;
}

function cancelled(): SshApiError {
  return new SshApiError("cancelled", "Connection cancelled");
}

/**
 * Connects to a server, asking the user whenever the backend needs a decision: an unknown or
 * changed host key, or a password or key passphrase that is missing or wrong.
 */
export async function connectProfile(
  target: SshProfile,
  jump: SshProfile | null,
): Promise<ConnectionInfo> {
  const secrets = await storedSecrets(target, jump);
  const remember: Remember[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const info = await sshApi.connect({ profileId: target.id, ...secrets });
      await Promise.all(remember.map((r) => setSecret(r.profileId, r.kind, r.value)));
      return info;
    } catch (caught) {
      const error = toApiError(caught);

      if (error.code === "host_key_unknown" || error.code === "host_key_changed") {
        const data = hostKeyData(error);
        if (!data) throw error;
        const changed = error.code === "host_key_changed";
        if (!(await askHostKey(data, changed))) throw cancelled();
        await sshApi.trustHostKey(data.host, data.port, data.presented.publicKey, changed);
        continue;
      }

      const wantsSecret =
        error.code === "password_required" ||
        error.code === "passphrase_required" ||
        error.code === "passphrase_invalid" ||
        (error.code === "auth" && target.auth.kind === "password");
      if (!wantsSecret) throw error;

      const hop = hopData(error);
      const failing =
        jump && hop && hop.host === jump.host && hop.port === jump.port && !(hop.host === target.host && hop.port === target.port)
          ? jump
          : target;
      const kind = secretKindFor(failing);
      if (!kind) throw error;
      const invalid = error.code === "passphrase_invalid" || error.code === "auth";
      const answer = await askSecret(failing.name, kind, invalid);
      if (!answer) throw cancelled();

      const isJump = failing.id !== target.id;
      if (kind === "password") {
        if (isJump) secrets.jumpPassword = answer.value;
        else secrets.password = answer.value;
      } else if (isJump) secrets.jumpKeyPassphrase = answer.value;
      else secrets.keyPassphrase = answer.value;

      if (answer.remember) remember.push({ profileId: failing.id, kind, value: answer.value });
      else if (invalid) void clearSecret(failing.id, kind);
    }
  }
  throw new SshApiError("auth", "Could not sign in after several attempts");
}
