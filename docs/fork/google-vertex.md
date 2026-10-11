# Google Vertex AI provider (service account)

A fork-only AI provider that runs Gemini on Google Cloud's Vertex AI, authenticated with a **service account key file** instead of an API key. It appears in Settings, Models as **Google Vertex AI** and in the model picker as one entry, "Google Vertex AI".

## Status: tested against fakes, not against Google

The sandbox this was built in cannot reach Google, so nothing has been run against the real Vertex AI. What was checked: the JWT is signed with a real RSA key and verified with the matching public key, the token request and the Vertex request are built as described below, and the Settings card and file chooser were driven in a browser with the network and file system faked. The endpoint shape comes from third-party gateway docs and the OAuth service-account flow is the standard one. Please run the checklist at the end with a real project.

## Setting it up in Google Cloud

1. In the Google Cloud project that should pay for the requests, enable the **Vertex AI API**.
2. Create a service account (IAM & Admin, Service Accounts) and give it the **Vertex AI User** role (`roles/aiplatform.user`) on that project.
3. On the service account, Keys, Add key, Create new key, **JSON**. A `.json` file downloads.

## Using it

1. Settings, Models, Add provider, **Google Vertex AI**.
2. Press **Find file…** and pick the downloaded `.json` file. The chooser opens in the folder you used last time, otherwise Downloads, and shows folders and `.json` files only (double-click a file to choose it). You can also type or paste the path, including a leading `~`, and press **Use this path**. The card then shows the service account's email, project and the file's path.
3. Set **Location** (`global` by default, or a region such as `us-central1`) and **Model** (default `gemini-2.5-flash`). Both are saved when you leave the field. **Project override** is only needed if the model should run in a different project than the key's own.
4. Press **Test connection**. It signs in and asks the chosen model for one word, and shows Google's own error message if something is wrong (for example the API is not enabled, the role is missing, or the model is not offered in that location).
5. In chat, choose **Google Vertex AI**. The model and location from the card are used, and a change applies from the next message.

**Change file…** picks a different key file. **Disconnect** forgets the path; it does not delete or change the file.

## No keychain

The key file is **not copied and not stored by Terax, and nothing is written to or read from the OS keychain** (so there is no keychain permission prompt for this provider). Terax remembers only the file's path and reads the file from where it is whenever a request needs it. Consequences:

- If you move, rename or delete the file, the card shows "Could not read <path>" as soon as you open Settings and chat fails with the same message. Choose the file again.
- If you replace the file with a new key (same path), the next request uses it; the old access token is not reused for a different key.
- Anyone who can read that file can use the service account, so keep it somewhere only you can read (for example `chmod 600`). Moving it out of Downloads into a private folder is a good idea; the chooser remembers the last folder.

## How it works

| Step | Detail |
|---|---|
| Key file | Read with the app's existing `fs_read_file` command (local, text, size-limited) on every request, then parsed and checked. The private key is held in memory only for that request. |
| Sign in | A JWT (`RS256`, scope `cloud-platform`, lifetime one hour) is signed in the app with the browser's WebCrypto and posted to the key file's token endpoint (`urn:ietf:params:oauth:grant-type:jwt-bearer`) for an access token. No dependency was added. |
| Token use | One access token per key (identified by the key's id plus a checksum of the private key) is kept in memory and renewed a minute before it expires. A 401 renews it and retries once. |
| Chat | Vertex AI's OpenAI-compatible API: `https://<host>/v1/projects/<project>/locations/<location>/endpoints/openapi/chat/completions`, with the model named `google/<model>`. The host is `aiplatform.googleapis.com` for `global`, otherwise `<location>-aiplatform.googleapis.com`. |
| Network | All requests go through the app's Rust HTTP proxy command (`ai_http_stream`). |

The picker shows one entry because the model and location are settings that can change, so the request's URL and `model` field are filled in per request.

## Where things are stored

- **The path** of the key file, plus the service account's email and project (so Settings can show them without opening the file), location, model, project override and the chooser's last folder, are in `terax-google-vertex.json` in the app data folder. None of this is secret.
- **How it plugs into the key code:** the provider's key slot (`google-vertex-service-account`) is registered with `lazyKeys.ts` as an external account, so the rest of the app, which treats the "key" as an opaque string, receives the file path and never the keychain (see `docs/fork/lazy-keys.md`).
- The private key is never shown, logged or put in an error message. Only `https` hosts under `googleapis.com` are accepted as the token endpoint, so a doctored key file cannot send the signed token elsewhere.
- **If you tried an earlier build of this branch** that stored the key in the keychain, those entries (`google-vertex-service-account` and `.part0`, `.part1`, …, service `terax-ai`) are no longer used and can be deleted in Keychain Access or Credential Manager.

## Limits

- **Gemini models served through the OpenAI-compatible endpoint only.** Anthropic Claude on Vertex uses a different API and is not supported. A model id written with a publisher prefix (for example `meta/...`) is passed through unchanged but is untested.
- **The model suggestions are a hint, not a list.** Model names and which locations offer them change; the field is free text and **Test connection** tells you if Google does not recognise it.
- **Locations:** the value is checked (`global` or a region such as `europe-west4`) because it becomes part of the hostname.
- **Key rotation:** keys that were removed in Google Cloud fail at the next sign-in with Google's message ("Invalid JWT Signature" or similar). Download a new key and choose it again.
- **Local files only.** The chooser and the file read use the local file system, not a WSL or remote workspace.
- **Cost and quotas** are Google Cloud's, billed to the key's project (or the override).
- Only RSA keys in the standard downloaded format (`BEGIN PRIVATE KEY`) are supported, which is what Google issues.

## Layout and seams

| Path | Role |
|---|---|
| `src/modules/ai/providers/google-vertex/data.ts` | Provider info and the placeholder model |
| `serviceAccount.ts` | Key file parsing, JWT signing, token exchange and renewal |
| `endpoint.ts` | Location, project and URL rules |
| `keyFile.ts` | Reading and checking the key file from disk |
| `fileBackend.ts` | Makes the saved path look like a "key" to the rest of the app (an external account in `lazyKeys.ts`) |
| `KeyFileBrowser.tsx`, `keyBrowser.ts` | The file chooser and its pure path and listing helpers |
| `settings.ts` | The saved path, account details, settings and last folder |
| `build.ts`, `connection.ts` | The AI SDK client (reads the key file per request) and Test connection |
| `VertexCard.tsx` | The Settings card |
| `src/modules/ai/providers/requestBody.ts` | Shared helper that sets the `model` field (also used by the Copilot provider) |

Upstream files are touched only at `fork:google-vertex` lines, registered in `scripts/fork/seams.json`: `config.ts` (5), `lib/agent.ts` (1), `lib/keyring.ts` (1), `ProviderIcon.tsx` (2), `AiStatusBarControls.tsx` (2) and `ModelsSection.tsx` (2). To remove the provider, delete the directory above and every line marked `fork:google-vertex`.

## Checklist for a real project

1. Press Find file…, pick the downloaded key, press Test connection, and expect a green line naming the model and project.
2. Send a chat message and a tool-using request; confirm streaming and tool calls work.
3. Switch Location and Model on the card and confirm the next message uses them.
4. Restart the app and confirm the provider is still connected and that no keychain prompt appeared.
5. Rename the key file, open Settings and confirm the card says it cannot read it; rename it back and confirm chat works again.
6. Press Disconnect and confirm the provider shows as not connected after restarting, and the key file is still there.
7. On Windows, confirm the chooser lists drives' folders (`C:/Users/...`) and that the path you pick works.
