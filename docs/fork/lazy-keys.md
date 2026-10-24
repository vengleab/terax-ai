# Lazy API key reads

Terax used to read every saved provider key from the OS secret store when the app started and again when Settings opened. On macOS the Keychain asks for permission once per saved key each time the running app is not already trusted for it, so you were asked at launch and again in Settings. The fork now keeps a small index of which keys exist and reads a key from the secret store only when something actually uses it.

## What changed for you

- **Launching the app and opening Settings, Models no longer touch the secret store.** Providers show as "Connected" from the index. The key field shows "Saved in your keychain" instead of the first and last four characters.
- **A key is read when it is first used**: sending an AI message, an inline completion, a commit message suggestion, voice input. After that it is remembered in memory until you quit the app or change a key in Settings. So you can still see a Keychain prompt, but at most once per key per launch and only when you actually use that provider.
- **One-time catch-up on the first launch after updating.** The app has to learn which keys you already have, so on that first launch it reads each account once, one at a time (the same prompts you have been getting, and not twice). Accounts that have no key never prompt. If you press Deny on one of them, that account is left unknown and is asked about again on the next launch instead of being marked missing.
- **Saving a key** updates the index and remembers the key in memory, so it is not read back. **Removing a key** removes it from both.

macOS ties "Always Allow" to the signature of the running app. If your build is signed differently each time (ad-hoc builds are), the permission will not stick across rebuilds and you will see the prompt at first use after each rebuild. Signing with a stable identity fixes that; this change only removes the reads you did not ask for.

## How it works

`src/modules/ai/lib/lazyKeys.ts` is a drop-in for Tauri's `invoke` that `keyring.ts` now imports. For the `terax-ai` service it answers the key lookups from an index and returns a marker string (`\0terax-keychain:<account>`) instead of the key. Everything else, including the SSH feature's separate `terax-ssh-transfer` secrets, passes straight through.

- The index is `terax-key-index.json` in the app data folder. It holds account names only (for example `openai-api-key`), never keys: which accounts have been checked, and which of those have a key.
- The few places that need the real key resolve the marker first: building a model in `agent.ts` (which covers chat, sub-agents, commit messages and autocomplete), and voice input in `stt.ts`. A plain key (one you just typed) passes through unchanged. If the saved key has been removed behind the app's back, you get the usual "No API key configured" error.
- If the index cannot be read, the old behavior is used (read the secret store directly), so a broken index never hides your keys.
- The in-memory copy is cleared when another window changes a key, using the existing keys-changed event.

### Accounts that are not in the keychain

A provider can register its key slot as an **external account** (`createLazyKeys({ external })`, a map from account name to `{ get, set, delete }`). For those accounts `lazyKeys.ts` answers `secrets_get`, `secrets_get_all` (also inside a mixed batch, in order), `secrets_set` and `secrets_delete` from the backend and never reads the secret store or the index, and the value is returned as it is (not a marker), so `resolveSecret` passes it through. Google Vertex AI uses this: its "key" is the path of the service account file the user chose, kept in plain settings (see `docs/fork/google-vertex.md`). A backend that fails is treated as "no value" in a batch so one broken provider cannot hide the others.

## Limits

- **Verified here:** unit tests for the index (first run, later launches with zero reads, new providers, denied reads, concurrent callers, save and delete, stale entries, fallback), integration tests through `keyring.ts` and `agent.ts` including simulated second and third launches, and a browser run with a mocked backend that counted secret-store reads: first launch 11 (one per account), later launches 0, opening Settings 0.
- **Not verified:** the real macOS Keychain. The sandbox is Linux, so the prompts themselves were never seen. The change relies only on the app not asking, so it does not depend on Keychain behavior, but please confirm on your Mac.
- Keys added to the secret store by something other than Terax (for example in Keychain Access) are not noticed after the first launch with this change. Add them through Settings.
- The index file and the marker text are not secret, but they do reveal which providers you have set up.

## Seams

Upstream files are touched only at `fork:lazy-keys` lines, registered in `scripts/fork/seams.json`: `lib/keyring.ts` (the import), `lib/agent.ts` (4), `lib/stt.ts` (3), `settings/components/ProviderKeyCard.tsx` (2) and `settings/sections/ModelsSection.tsx` (2). To remove the feature, delete `lazyKeys.ts` and its tests, restore the `invoke` import in `keyring.ts`, and delete every line marked `fork:lazy-keys`.
