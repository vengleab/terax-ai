# Google Vertex AI provider (service account)

A fork-only AI provider that runs Gemini on Google Cloud's Vertex AI, authenticated with a **service account key file** instead of an API key. It appears in Settings, Models as **Google Vertex AI** and in the model picker as one entry, "Google Vertex AI".

## Status: tested against fakes, not against Google

The sandbox this was built in cannot reach Google, so nothing has been run against the real Vertex AI. What was checked: the JWT is signed with a real RSA key and verified with the matching public key, the token request and the Vertex request are built as described below, and the Settings card was driven in a browser with the network faked. The endpoint shape comes from third-party gateway docs and the OAuth service-account flow is the standard one. Please run the checklist at the end with a real project.

## Setting it up in Google Cloud

1. In the Google Cloud project that should pay for the requests, enable the **Vertex AI API**.
2. Create a service account (IAM & Admin, Service Accounts) and give it the **Vertex AI User** role (`roles/aiplatform.user`) on that project.
3. On the service account, Keys, Add key, Create new key, **JSON**. A `.json` file downloads.

## Using it

1. Settings, Models, Add provider, **Google Vertex AI**.
2. Paste the JSON, or press **Choose file…**, then **Save key**. The card shows the service account's email and project.
3. Set **Location** (`global` by default, or a region such as `us-central1`) and **Model** (default `gemini-2.5-flash`). Both are saved when you leave the field. **Project override** is only needed if the model should run in a different project than the key's own.
4. Press **Test connection**. It signs in and asks the chosen model for one word, and shows Google's own error message if something is wrong (for example the API is not enabled, the role is missing, or the model is not offered in that location).
5. In chat, choose **Google Vertex AI**. The model and location from the card are used, and a change applies from the next message.

**Remove key** deletes the key file from your keychain.

## How it works

| Step | Detail |
|---|---|
| Sign in | A JWT (`RS256`, scope `cloud-platform`, lifetime one hour) is signed in the app with the browser's WebCrypto and posted to the key file's token endpoint (`urn:ietf:params:oauth:grant-type:jwt-bearer`) for an access token. No dependency was added. |
| Token use | The access token is kept in memory and renewed a minute before it expires. A 401 renews it and retries once. |
| Chat | Vertex AI's OpenAI-compatible API: `https://<host>/v1/projects/<project>/locations/<location>/endpoints/openapi/chat/completions`, with the model named `google/<model>`. The host is `aiplatform.googleapis.com` for `global`, otherwise `<location>-aiplatform.googleapis.com`. |
| Network | All requests go through the app's Rust HTTP proxy command (`ai_http_stream`). |

The picker shows one entry because the model and location are settings that can change, so the request's URL and `model` field are filled in per request.

## Where things are stored

- **The key file** is in the OS keychain (service `terax-ai`), like other provider keys, and is read only when a request needs it (see `docs/fork/lazy-keys.md`). Windows Credential Manager holds at most 1280 characters per entry and a key file is about 2400, so it is saved in pieces of at most 1000 characters (`google-vertex-service-account.part0`, `.part1`, …). The provider's own slot (`google-vertex-service-account`) holds a short pointer with a fingerprint of the file, so replacing the key is picked up immediately.
- **Non-secret details** (the service account's email and project, location, model, project override) are in `terax-google-vertex.json` in the app data folder, so Settings can show them without reading the keychain.
- The private key is never shown, logged or put in an error message. Only `https` hosts under `googleapis.com` are accepted as the token endpoint, so a doctored key file cannot send the signed token elsewhere.

## Limits

- **Gemini models served through the OpenAI-compatible endpoint only.** Anthropic Claude on Vertex uses a different API and is not supported. A model id written with a publisher prefix (for example `meta/...`) is passed through unchanged but is untested.
- **The model suggestions are a hint, not a list.** Model names and which locations offer them change; the field is free text and **Test connection** tells you if Google does not recognise it.
- **Locations:** the value is checked (`global` or a region such as `europe-west4`) because it becomes part of the hostname.
- **Key rotation:** keys that were removed in Google Cloud fail at the next sign-in with Google's message ("Invalid JWT Signature" or similar). Replace the key in Settings.
- **Cost and quotas** are Google Cloud's, billed to the key's project (or the override).
- Only RSA keys in the standard downloaded format (`BEGIN PRIVATE KEY`) are supported, which is what Google issues.

## Layout and seams

| Path | Role |
|---|---|
| `src/modules/ai/providers/google-vertex/data.ts` | Provider info and the placeholder model |
| `serviceAccount.ts` | Key file parsing, JWT signing, token exchange and renewal |
| `endpoint.ts` | Location, project and URL rules |
| `credentialStore.ts` | Saving the key file in keychain-sized pieces |
| `settings.ts` | Non-secret settings and saved-account details |
| `build.ts`, `connection.ts` | The AI SDK client with its per-request fetch, and Test connection |
| `VertexCard.tsx` | The Settings card |
| `src/modules/ai/providers/requestBody.ts` | Shared helper that sets the `model` field (also used by the Copilot provider) |

Upstream files are touched only at `fork:google-vertex` lines, registered in `scripts/fork/seams.json`: `config.ts` (5), `lib/agent.ts` (1), `lib/keyring.ts` (1), `ProviderIcon.tsx` (2), `AiStatusBarControls.tsx` (2) and `ModelsSection.tsx` (2). To remove the provider, delete the directory above and every line marked `fork:google-vertex`.

## Checklist for a real project

1. Save a key, press Test connection, and expect a green line naming the model and project.
2. Send a chat message and a tool-using request; confirm streaming and tool calls work.
3. Switch Location and Model on the card and confirm the next message uses them.
4. Remove the key and confirm the provider shows as not connected after restarting.
5. On Windows, confirm the key saves (it is stored in several entries).
