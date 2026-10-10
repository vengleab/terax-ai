const requested = new Map<number, string>();

/** Remembers which server a new tab should open with, until the tab's panes are prepared. */
export function requestServerForTab(tabId: number, profileId: string): void {
  requested.set(tabId, profileId);
}

export function takeRequestedServer(tabId: number): string | undefined {
  const id = requested.get(tabId);
  requested.delete(tabId);
  return id;
}
