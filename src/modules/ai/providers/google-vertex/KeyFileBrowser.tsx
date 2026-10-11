import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ArrowUp01Icon, File01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { useCallback, useEffect, useState } from "react";
import {
  type BrowserEntry,
  chooserEntries,
  expandHome,
  joinPath,
  normalizePath,
  parentPath,
  type RawEntry,
  startFolders,
} from "./keyBrowser";
import { vertexState } from "./settings";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (path: string) => void;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function listFolder(path: string): Promise<BrowserEntry[]> {
  const entries = await invoke<RawEntry[]>("fs_read_dir", {
    path,
    showHidden: false,
    gitDecorations: false,
    workspace: { kind: "local" },
  });
  return chooserEntries(entries);
}

/** Lets the user find the service account .json file on disk. Nothing is read until a file is chosen. */
export function KeyFileBrowser({ open, onOpenChange, onPick }: Props) {
  const [home, setHome] = useState("");
  const [folder, setFolder] = useState("");
  const [typed, setTyped] = useState("");
  const [entries, setEntries] = useState<BrowserEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = useCallback(async (path: string): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      const listed = await listFolder(path);
      setFolder(path);
      setTyped(path);
      setEntries(listed);
      setSelected(null);
      void vertexState.setLastDirectory(path).catch(() => undefined);
      return true;
    } catch (e) {
      setError(`Could not open ${path}: ${describe(e)}`);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      const [last, homePath] = await Promise.all([
        vertexState.getLastDirectory().catch(() => null),
        homeDir().catch(() => ""),
      ]);
      if (!live) return;
      const base = normalizePath(homePath);
      setHome(base);
      for (const candidate of startFolders(last, base)) {
        if (!live) return;
        if (await show(candidate)) return;
      }
    })();
    return () => {
      live = false;
    };
  }, [open, show]);

  const choose = (name: string) => {
    onPick(joinPath(folder, name));
    onOpenChange(false);
  };

  const go = (event: React.FormEvent) => {
    event.preventDefault();
    const target = expandHome(normalizePath(typed), home);
    if (target) void show(target);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose the service account key file</DialogTitle>
          <DialogDescription>
            Pick the .json file you downloaded from Google Cloud. It is read from where it is, and is not copied.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={go} className="flex items-center gap-1.5">
          <Button
            type="button"
            size="icon"
            variant="outline"
            title="Up one folder"
            aria-label="Up one folder"
            disabled={loading || !folder}
            onClick={() => void show(parentPath(folder))}
            className="size-8 shrink-0"
          >
            <HugeiconsIcon icon={ArrowUp01Icon} size={14} strokeWidth={1.75} />
          </Button>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Folder path"
            spellCheck={false}
            autoComplete="off"
            className="h-8 font-mono text-[11.5px] md:text-[11.5px]"
          />
        </form>

        <div className="h-64 overflow-y-auto rounded-md border border-border/60">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner className="size-4" />
            </div>
          ) : entries.length === 0 ? (
            <p className="px-3 py-4 text-[11.5px] text-muted-foreground">
              No folders or .json files here.
            </p>
          ) : (
            <ul className="flex flex-col py-1">
              {entries.map((entry) => {
                const active = selected === entry.name;
                return (
                  <li key={`${entry.kind}:${entry.name}`}>
                    <button
                      type="button"
                      onClick={() => (entry.kind === "dir" ? void show(joinPath(folder, entry.name)) : setSelected(entry.name))}
                      onDoubleClick={() => entry.kind === "file" && choose(entry.name)}
                      aria-pressed={entry.kind === "file" ? active : undefined}
                      className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] transition-colors hover:bg-muted/60 ${
                        active ? "bg-accent text-accent-foreground" : ""
                      }`}
                    >
                      <HugeiconsIcon
                        icon={entry.kind === "dir" ? Folder01Icon : File01Icon}
                        size={14}
                        strokeWidth={1.75}
                        className="shrink-0 text-muted-foreground"
                      />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {error ? (
          <p role="alert" className="text-[11px] leading-relaxed text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!selected} onClick={() => selected && choose(selected)}>
            Use this file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
