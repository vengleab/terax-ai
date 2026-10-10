# GitHub Models provider

A fork-only AI provider that sends chat requests to [GitHub Models](https://docs.github.com/en/github-models) (`https://models.github.ai/inference`, OpenAI-compatible) using a GitHub token. It appears in Settings, Models as **GitHub Models** and in the model picker with models labelled "(GitHub)".

## What it is, and is not

It is the official GitHub Models API. It is **not** the GitHub Copilot subscription: models included in a Copilot plan are not reachable through it, and signing in with a Copilot account is not supported. (The Copilot chat endpoint is undocumented, and community tools reach it only with VS Code's OAuth client id, which is a terms-of-service risk, so the fork does not use it.)

## Setting it up

1. Create a token at <https://github.com/settings/personal-access-tokens/new>. A fine-grained token needs the account permission **Models: read**. A classic token also works.
2. Open Settings, Models, add **GitHub Models** and paste the token. It is stored through the app's secret store like every other provider key (service `terax-ai`, account `github-models-api-key`).
3. Pick one of the "(GitHub)" models in the AI model picker.

Models that are not in the built-in list can still be used through the existing **OpenAI Compatible** custom endpoint: base URL `https://models.github.ai/inference`, the token as the key, and the model id from the catalog (`publisher/name`, for example `openai/gpt-4.1`).

## Known limits

- The model list is static. It was written without access to the live catalog, so check it against `GET https://models.github.ai/catalog/models` (with your token) and adjust `src/modules/ai/providers/github-models/data.ts` if an id has been renamed or retired.
- GitHub Models has rate limits and per-request token caps, and the free tier's caps are small. The agent's system prompt plus tool definitions can be large, so on a free account chats may fail with a request-too-large or rate-limit error until the account uses the paid tier. This comes from the service, not the integration.
- Requests go through the app's Rust HTTP proxy command (`ai_http_stream`), like the other cloud providers that need it, which avoids browser CORS limits.
- No pricing is recorded, so the cost estimate shows nothing for these models.
- It has not been called against the real service from this repository's CI or from the sandbox it was written in. The unit tests cover registration, routing, the endpoint and headers.

## Layout and seams

| Path | Role |
|---|---|
| `src/modules/ai/providers/github-models/data.ts` | Provider info, model list, context limits. No runtime imports, safe for the eager bundle |
| `src/modules/ai/providers/github-models/build.ts` | Builds the AI SDK model; loaded lazily from `agent.ts` |
| `src/modules/ai/providers/github-models/github-models.test.ts` | Registration, routing and request-shape tests |

Upstream files are touched only at `fork:github-models` seams, registered in `scripts/fork/seams.json`: `config.ts` (5), `lib/agent.ts` (1), `lib/keyring.ts` (1), `settings/components/ProviderIcon.tsx` (2) and `components/AiStatusBarControls.tsx` (2). All are single-line insertions. To remove the provider, delete the directory above and every line marked `fork:github-models`.
