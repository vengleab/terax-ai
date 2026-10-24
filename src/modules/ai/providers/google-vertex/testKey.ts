export type TestAccount = {
  json: string;
  parsed: Record<string, string>;
  publicKey: CryptoKey;
};

/** A throwaway service account key file with a real RSA key, for tests only. */
export async function makeTestAccount(overrides: Record<string, string> = {}): Promise<TestAccount> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const body = Buffer.from(der).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  const parsed = {
    type: "service_account",
    project_id: "demo-project-123",
    private_key_id: "0123456789abcdef0123456789abcdef01234567",
    private_key: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    client_email: "terax@demo-project-123.iam.gserviceaccount.com",
    client_id: "123456789012345678901",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url:
      "https://www.googleapis.com/robot/v1/metadata/x509/terax%40demo-project-123.iam.gserviceaccount.com",
    universe_domain: "googleapis.com",
    ...overrides,
  };
  return { json: JSON.stringify(parsed, null, 2), parsed, publicKey: pair.publicKey };
}
