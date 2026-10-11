# GitHub Copilot provider

A fork-only AI provider that lets Terax chat with the models in your GitHub Copilot plan. You sign in with GitHub in Settings, Models (no API key to paste), pick a model, and use it from the chat model picker as **GitHub Copilot**.

## Status: unofficial and untested against the live service

Read this before relying on it.

- **It is unofficial.** GitHub documents no public API for using a Copilot subscription from another app. This provider signs in the way editor plugins do (GitHub's device-code flow with the OAuth client id used by VS Code's Copilot extension), exchanges that token at `api.github.com/copilot_internal/v2/token`, and calls Copilot's chat API with editor-style headers. GitHub officially partners with OpenCode for this; it has made no such arrangement for Terax. Using another product's client id may be against GitHub's terms, and GitHub can change or block it without notice. It is your account, so your call.
- **It was written from third-party descriptions, not tested.** The sandbox it was built in cannot reach GitHub, so the sign-in, token exchange, model list and chat calls have only been exercised against faked responses in unit tests. The endpoint paths, response shapes and header values come from open-source projects that do the same thing and may be stale. Expect to adjust `src/modules/ai/providers/github-copilot/constants.ts` after the first real run.
- **GitHub Models is not an alternative.** It was retired on 2026-07-30 (the first version of this provider targeted it and was removed).

## Using it

1. Settings, Models, Add provider, **GitHub Copilot**, then **Sign in with GitHub**. A code appears and the GitHub page opens. Enter the code and authorize.
2. Terax checks the account, loads the models your plan allows and picks a sensible default. Change it with the model dropdown on the card; the refresh button reloads the list.
3. In chat, choose **GitHub Copilot**. Whatever model is selected on the card is the one used, and changing it takes effect on the next message.
4. **Sign out** removes the stored token and the saved model list.

The sign-in token is stored in the OS keychain like other provider keys (service `terax-ai`, account `github-copilot-oauth-token`). The model choice and list are kept in `terax-github-copilot.json` in the app data folder. The short-lived Copilot token is held in memory only and refreshed about a minute before it expires.

## How it works

| Step | Call |
|---|---|
| Sign in | `POST github.com/login/device/code`, then poll `POST github.com/login/oauth/access_token` |
| Copilot token | `GET api.github.com/copilot_internal/v2/token` with the sign-in token |
| Model list | `GET <api host>/models`, keeping chat models that support tools and `/chat/completions` |
| Chat | `POST <api host>/chat/completions` through the AI SDK's OpenAI-compatible client |

All requests go through the app's Rust HTTP proxy command (`ai_http_stream`), because GitHub's login endpoints do not allow browser CORS. The API host comes from the token response and is only accepted if it is an `https` `githubcopilot.com` host. A 401 from chat refreshes the token and retries once.

The chat picker shows a single entry because Copilot's model list depends on your plan and changes often, so it is fetched live instead of being hard-coded. The request's `model` field is filled in per request from your saved choice.

## Known limits

- One Copilot model is active at a time (the one chosen in Settings), not one picker entry per model.
- Models that only speak the Responses or Anthropic Messages protocol are hidden, because only `/chat/completions` is implemented. Vision input is not wired up.
- Usage counts against your Copilot plan's premium requests. No cost estimate is shown.
- Context size is assumed to be 128k for the usage indicator, whatever the chosen model really allows.

## Layout and seams

| Path | Role |
|---|---|
| `src/modules/ai/providers/github-copilot/data.ts` | Provider info and the single placeholder model. No heavy imports, safe for the eager bundle |
| `constants.ts` | Client id, URLs and the editor header values that are most likely to need updating |
| `deviceFlow.ts`, `copilotApi.ts` | Sign-in, token exchange and refresh, model list parsing |
| `build.ts` | Builds the AI SDK model and the per-request fetch; loaded lazily from `agent.ts` |
| `selection.ts` | Saved model choice and cached list |
| `CopilotCard.tsx` | The Settings card |
| `*.test.ts` | Tests with faked network |

Upstream files are touched only at `fork:github-copilot` seams, registered in `scripts/fork/seams.json`: `config.ts` (5), `lib/agent.ts` (1), `lib/keyring.ts` (1), `ProviderIcon.tsx` (2), `AiStatusBarControls.tsx` (2) and `ModelsSection.tsx` (2). To remove the provider, delete the directory above and every line marked `fork:github-copilot`.
