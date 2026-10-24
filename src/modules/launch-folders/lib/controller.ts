export type LaunchFoldersDeps = {
  /** Collects (and clears) the folders the OS asked the app to open. */
  takePending: () => Promise<string[]>;
  /** Allows the app to run a shell in the folder. Returns the folder's canonical path. */
  authorize: (path: string) => Promise<string>;
  openFolder: (path: string) => void;
};

export function normalizeFolders(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const path = raw.trim().replace(/\\/g, "/");
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * Opens a terminal in each folder the OS hands the app (macOS `open -a Terax <folder>`, which is what
 * VS Code runs for "Open New External Terminal").
 *
 * The backend queues folders and sends a wake-up with no payload, so a folder can only be read from the
 * queue and is never opened twice. Nothing is opened until `setReady(true)`, because the saved tabs are
 * restored at startup and replace the whole tab list, which would discard a tab opened before then.
 */
export function createLaunchFolders(deps: LaunchFoldersDeps) {
  let ready = false;
  let disposed = false;
  let chain: Promise<void> = Promise.resolve();

  const drain = (): Promise<void> => {
    chain = chain.then(async () => {
      if (!ready || disposed) return;
      const pending = await deps.takePending().catch(() => [] as string[]);
      for (const path of normalizeFolders(pending)) {
        if (disposed) return;
        try {
          const canonical = await deps.authorize(path);
          deps.openFolder(canonical.replace(/\\/g, "/"));
        } catch {
          // a folder that cannot be opened (removed meanwhile, not allowed) is skipped, not fatal
        }
      }
    });
    return chain;
  };

  return {
    setReady(value: boolean): Promise<void> {
      ready = value;
      return value ? drain() : Promise.resolve();
    },
    wake: drain,
    dispose() {
      disposed = true;
    },
  };
}
