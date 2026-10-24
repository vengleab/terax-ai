export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_ACCESS_TOKEN_URL =
  "https://github.com/login/oauth/access_token";
export const COPILOT_TOKEN_URL =
  "https://api.github.com/copilot_internal/v2/token";
export const COPILOT_API_FALLBACK = "https://api.githubcopilot.com";

export const EDITOR_VERSION = "vscode/1.105.0";
export const EDITOR_PLUGIN_VERSION = "copilot-chat/0.32.0";
export const COPILOT_USER_AGENT = "GitHubCopilotChat/0.32.0";
export const COPILOT_API_VERSION = "2025-05-01";

export const SESSION_REFRESH_SKEW_MS = 60_000;

export function editorHeaders(): Record<string, string> {
  return {
    "Editor-Version": EDITOR_VERSION,
    "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
    "User-Agent": COPILOT_USER_AGENT,
    "Copilot-Integration-Id": "vscode-chat",
    "Openai-Intent": "conversation-panel",
    "X-GitHub-Api-Version": COPILOT_API_VERSION,
  };
}
