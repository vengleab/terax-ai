import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { sshApi } from "../lib/api";
import { PANE_ATTR } from "../lib/dnd";
import { errorMessage } from "../lib/errors";
import { formatBytes } from "../lib/format";
import { getFileClipboard, setFileClipboard } from "../lib/fileClipboard";
import { useHostActions } from "../lib/hostActions";
import { endpointLabel } from "../lib/labels";
import { openLocalInPane, openServerInPane } from "../lib/bench";
import {
  goBack,
  goForward,
  navigate,
  refresh,
  type PaneState,
} from "../lib/paneState";
import { baseName, expandHome, isDirLike, joinPath, parentPath, validateNewName } from "../lib/pathOps";
import {
  applyClick,
  moveCursor,
  pruneSelection,
  selectAll,
  type SelectModifiers,
} from "../lib/selection";
import { toggleSort, viewEntries, type SortKey } from "../lib/sort";
import { buildTransfer } from "../lib/transferPlan";
import { useDirectory } from "../lib/useDirectory";
import { useDndStore } from "../store/dndStore";
import { useProfilesStore } from "../store/profilesStore";
import { useTransferStore } from "../store/transferStore";
import { useUiStore } from "../store/uiStore";
import { persistShowHidden, useWorkbenchStore } from "../store/workbenchStore";
import type { FileEntry, PaneId } from "../types";
import { FileList } from "./FileList";
import { PaneToolbar } from "./PaneToolbar";

type Props = {
  tabId: number;
  pane: PaneId;
  visible: boolean;
  onTransfer: (from: PaneId, mode: "copy" | "move") => void;
  onRowPointerDown: (event: React.PointerEvent, pane: PaneId, path: string) => void;
  consumeSuppressedClick: () => boolean;
};

export function FilePane({
  tabId,
  pane,
  visible,
  onTransfer,
  onRowPointerDown,
  consumeSuppressedClick,
}: Props) {
  const state = useWorkbenchStore((s) => s.benches[tabId]?.[pane]);
  const active = useWorkbenchStore((s) => s.benches[tabId]?.active === pane);
  const update = useWorkbenchStore((s) => s.update);
  const setActive = useWorkbenchStore((s) => s.setActive);
  const profiles = useProfilesStore((s) => s.profiles);
  const connections = useProfilesStore((s) => s.connections);
  const connecting = useProfilesStore((s) => s.connecting);
  const hover = useDndStore((s) => s.hover);
  const openDialog = useUiStore((s) => s.open);
  const host = useHostActions();

  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<"file" | "dir" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FileEntry[] | null>(null);
  const [pathFocus, setPathFocus] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  const endpoint = state?.endpoint ?? { kind: "local" as const };
  const profileId = endpoint.kind === "remote" ? endpoint.profileId : null;
  const connected = profileId === null || !!connections[profileId];
  const home = profileId ? connections[profileId]?.home : undefined;

  const dir = useDirectory(endpoint, state?.path ?? "", state?.refreshKey ?? 0, !!state && connected);
  const entries = useMemo(
    () => (state ? viewEntries([...dir.entries], state.view) : []),
    [dir.entries, state],
  );
  const order = useMemo(() => entries.map((e) => e.path), [entries]);

  const patch = useCallback(
    (fn: (p: PaneState) => PaneState) => update(tabId, pane, fn),
    [update, tabId, pane],
  );

  const go = useCallback(
    (path: string) => {
      const target = expandHome(path, home ?? "");
      if (target) patch((p) => navigate(p, target));
    },
    [patch, home],
  );

  const selectedEntries = useMemo(() => {
    if (!state) return [];
    const wanted = new Set(state.selection);
    return entries.filter((e) => wanted.has(e.path));
  }, [entries, state]);

  useEffect(() => {
    if (!state || dir.loading || dir.error) return;
    const pruned = pruneSelection(state, order);
    if (pruned !== state) {
      patch((p) => ({
        ...p,
        selection: pruned.selection,
        anchor: pruned.anchor,
        cursor: pruned.cursor,
      }));
    }
  }, [state, order, dir.loading, dir.error, patch]);

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        <Spinner className="mr-2 size-3.5" /> Preparing
      </div>
    );
  }

  const label = (ep: typeof endpoint) => endpointLabel(ep, profiles);

  const openEntry = (entry: FileEntry) => {
    if (isDirLike(entry)) {
      go(entry.path);
      return;
    }
    if (profileId) host.openRemoteFile(profileId, entry.path);
    else host.openLocalFile(entry.path);
  };

  const onRowClick = (entry: FileEntry, modifiers: SelectModifiers) => {
    setActive(tabId, pane);
    if (consumeSuppressedClick()) return;
    patch((p) => ({ ...p, ...applyClick(p, order, entry.path, modifiers) }));
  };

  const onRowContext = (entry: FileEntry) => {
    setActive(tabId, pane);
    if (state.selection.includes(entry.path)) return;
    patch((p) => ({ ...p, selection: [entry.path], anchor: entry.path, cursor: entry.path }));
  };

  const copySelection = (mode: "copy" | "move") => {
    if (state.selection.length === 0) return;
    setFileClipboard({ endpoint, parent: state.path, paths: [...state.selection], mode });
    toast(mode === "move" ? "Ready to move" : "Copied", {
      description: `${state.selection.length === 1 ? baseName(state.selection[0]) : `${state.selection.length} items`}. Paste in a folder.`,
    });
  };

  const paste = () => {
    const clip = getFileClipboard();
    if (!clip) return;
    const built = buildTransfer({
      src: { endpoint: clip.endpoint, path: clip.parent },
      dst: { endpoint, path: state.path },
      paths: clip.paths,
      mode: clip.mode,
      label,
    });
    if (!built.ok) {
      toast.error(built.reason);
      return;
    }
    useTransferStore.getState().start(built.request, built);
    if (clip.mode === "move") setFileClipboard(null);
  };

  const createEntry = async (name: string) => {
    const kind = creating;
    setCreating(null);
    if (!kind) return;
    const problem = validateNewName(name);
    if (problem) {
      if (name.trim()) toast.error(problem);
      return;
    }
    const path = joinPath(state.path, name.trim());
    try {
      if (kind === "dir") await sshApi.fsMkdir(endpoint, path);
      else await sshApi.fsCreateFile(endpoint, path);
      patch(refresh);
      patch((p) => ({ ...p, selection: [path], anchor: path, cursor: path }));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const renameEntry = async (entry: FileEntry, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === entry.name) return;
    const problem = validateNewName(trimmed);
    if (problem) {
      toast.error(problem);
      return;
    }
    try {
      await sshApi.fsRename(endpoint, entry.path, joinPath(parentPath(entry.path), trimmed));
      patch(refresh);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const deleteEntries = async (targets: FileEntry[]) => {
    setPendingDelete(null);
    try {
      const failed = await sshApi.fsRemove(
        endpoint,
        targets.map((t) => t.path),
      );
      if (failed.length > 0) {
        toast.error(`${failed.length} could not be deleted`, { description: failed[0].message });
      }
    } catch (error) {
      toast.error(errorMessage(error));
    }
    patch(refresh);
  };

  const openChmod = (entry: FileEntry) =>
    openDialog({
      kind: "chmod",
      endpoint,
      path: entry.path,
      name: entry.name,
      mode: entry.mode,
      onDone: () => patch(refresh),
    });

  const copyPath = (entry: FileEntry) => {
    void navigator.clipboard.writeText(entry.path).then(() => toast("Path copied"));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (renaming || creating) return;
    const mod = event.metaKey || event.ctrlKey;
    const cursorEntry = entries.find((e) => e.path === state.cursor) ?? selectedEntries[0];
    const apply = (next: ReturnType<typeof moveCursor>) => {
      event.preventDefault();
      patch((p) => ({ ...p, ...next }));
    };
    switch (event.key) {
      case "ArrowDown":
        return apply(moveCursor(state, order, 1, event.shiftKey));
      case "ArrowUp":
        if (event.altKey) {
          event.preventDefault();
          return go(parentPath(state.path));
        }
        return apply(moveCursor(state, order, -1, event.shiftKey));
      case "Home":
        return apply(moveCursor(state, order, "start", event.shiftKey));
      case "End":
        return apply(moveCursor(state, order, "end", event.shiftKey));
      case "ArrowLeft":
        if (event.altKey) {
          event.preventDefault();
          patch(goBack);
        }
        return;
      case "ArrowRight":
        if (event.altKey) {
          event.preventDefault();
          patch(goForward);
        }
        return;
      case "Enter":
        if (cursorEntry) {
          event.preventDefault();
          openEntry(cursorEntry);
        }
        return;
      case "Backspace":
        event.preventDefault();
        return go(parentPath(state.path));
      case "F2":
        if (cursorEntry) {
          event.preventDefault();
          setRenaming(cursorEntry.path);
        }
        return;
      case "F5":
        event.preventDefault();
        patch(refresh);
        return;
      case "Delete":
        if (selectedEntries.length > 0) {
          event.preventDefault();
          setPendingDelete(selectedEntries);
        }
        return;
      case "Escape":
        if (state.selection.length > 0) patch((p) => ({ ...p, selection: [], anchor: null }));
        return;
      default:
    }
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === "a") apply(selectAll(order));
    else if (key === "c") {
      event.preventDefault();
      copySelection("copy");
    } else if (key === "x") {
      event.preventDefault();
      copySelection("move");
    } else if (key === "v") {
      event.preventDefault();
      paste();
    } else if (key === "l") {
      event.preventDefault();
      setPathFocus((n) => n + 1);
    }
  };

  const dropHere = hover?.pane === pane && hover.dir === null;
  const hoverDir = hover?.pane === pane ? hover.dir : null;
  const showMode = true;
  const single = selectedEntries.length === 1 ? selectedEntries[0] : null;
  const selectedBytes = selectedEntries.reduce((sum, e) => sum + (isDirLike(e) ? 0 : e.size), 0);

  let body: React.ReactNode;
  if (!connected && profileId) {
    const busy = !!connecting[profileId];
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-sm text-muted-foreground">
          {busy ? "Connecting..." : `Not connected to ${label(endpoint)}`}
        </div>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => void openServerInPane(tabId, pane, profileId)}
        >
          {busy ? <Spinner className="size-3.5" /> : null}
          Connect
        </Button>
      </div>
    );
  } else if (dir.error) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="max-w-xs text-sm text-destructive">{dir.error.message}</div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => dir.reload()}>
            Try again
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => patch(goBack)} disabled={state.back.length === 0}>
            Go back
          </Button>
        </div>
      </div>
    );
  } else {
    body = (
      <FileList
        pane={pane}
        entries={entries}
        selection={state.selection}
        cursor={state.cursor}
        sort={state.view.sort}
        renaming={renaming}
        creating={creating}
        hoverDir={hoverDir}
        showMode={showMode}
        onSort={(key: SortKey) => patch((p) => ({ ...p, view: { ...p.view, sort: toggleSort(p.view.sort, key) } }))}
        onRowClick={onRowClick}
        onRowOpen={openEntry}
        onRowPointerDown={(e, entry) => {
          setActive(tabId, pane);
          onRowPointerDown(e, pane, entry.path);
        }}
        onRowContext={onRowContext}
        onRename={renameEntry}
        onCancelRename={() => setRenaming(null)}
        onCreate={createEntry}
        onCancelCreate={() => setCreating(null)}
      />
    );
  }

  const showEmpty = connected && !dir.error && !dir.loading && entries.length === 0 && !creating;

  return (
    <div
      ref={root}
      {...{ [PANE_ATTR]: pane }}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col outline-none",
        dropHere && "ring-2 ring-inset ring-primary/60",
      )}
      onPointerDownCapture={() => setActive(tabId, pane)}
    >
      <PaneToolbar
        endpoint={endpoint}
        path={state.path}
        canBack={state.back.length > 0}
        canForward={state.forward.length > 0}
        showHidden={state.view.showHidden}
        filter={state.view.filter}
        pathFocusToken={pathFocus}
        disabled={!connected}
        onPickLocal={() => void openLocalInPane(tabId, pane)}
        onPickServer={(id) => void openServerInPane(tabId, pane, id)}
        onBack={() => patch(goBack)}
        onForward={() => patch(goForward)}
        onUp={() => go(parentPath(state.path))}
        onRefresh={() => patch(refresh)}
        onGo={go}
        onNewFolder={() => setCreating("dir")}
        onNewFile={() => setCreating("file")}
        onToggleHidden={() => {
          persistShowHidden(!state.view.showHidden);
          patch((p) => ({ ...p, view: { ...p.view, showHidden: !p.view.showHidden } }));
        }}
        onFilter={(value) => patch((p) => ({ ...p, view: { ...p.view, filter: value } }))}
      />

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="listbox"
            aria-multiselectable="true"
            aria-label={`${label(endpoint)} files`}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onFocus={() => setActive(tabId, pane)}
            className="relative flex min-h-0 flex-1 flex-col outline-none"
            {...(visible ? {} : { "aria-hidden": true })}
          >
            {body}
            {dir.loading && entries.length === 0 && connected && !dir.error ? (
              <div className="pointer-events-none absolute inset-x-0 top-8 flex justify-center">
                <Spinner className="size-4 text-muted-foreground" />
              </div>
            ) : null}
            {showEmpty ? (
              <div className="pointer-events-none absolute inset-x-0 top-10 text-center text-xs text-muted-foreground">
                {state.view.filter ? "No matches" : "This folder is empty"}
              </div>
            ) : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-52">
          {single ? (
            <ContextMenuItem onSelect={() => openEntry(single)}>
              {isDirLike(single) ? "Open" : profileId ? "Edit in Terax" : "Open in editor"}
            </ContextMenuItem>
          ) : null}
          {selectedEntries.length > 0 ? (
            <>
              <ContextMenuItem onSelect={() => onTransfer(pane, "copy")}>Copy to other pane</ContextMenuItem>
              <ContextMenuItem onSelect={() => onTransfer(pane, "move")}>Move to other pane</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => copySelection("copy")}>Copy</ContextMenuItem>
              <ContextMenuItem onSelect={() => copySelection("move")}>Cut</ContextMenuItem>
            </>
          ) : null}
          <ContextMenuItem disabled={!getFileClipboard()} onSelect={paste}>
            Paste here
          </ContextMenuItem>
          {single ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => setRenaming(single.path)}>Rename</ContextMenuItem>
              <ContextMenuItem onSelect={() => openChmod(single)}>Permissions...</ContextMenuItem>
              <ContextMenuItem onSelect={() => copyPath(single)}>Copy path</ContextMenuItem>
            </>
          ) : null}
          {selectedEntries.length > 0 ? (
            <ContextMenuItem variant="destructive" onSelect={() => setPendingDelete(selectedEntries)}>
              Delete
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setCreating("dir")}>New folder</ContextMenuItem>
          <ContextMenuItem onSelect={() => setCreating("file")}>New file</ContextMenuItem>
          <ContextMenuItem onSelect={() => patch(refresh)}>Refresh</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <div className={cn("flex h-6 shrink-0 items-center justify-between border-t border-border/60 px-2 text-[11px] text-muted-foreground", active && "text-foreground/70")}>
        <span>
          {entries.length} {entries.length === 1 ? "item" : "items"}
        </span>
        {state.selection.length > 0 ? (
          <span>
            {state.selection.length} selected{selectedBytes > 0 ? ` (${formatBytes(selectedBytes)})` : ""}
          </span>
        ) : null}
      </div>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {pendingDelete?.length === 1 ? pendingDelete[0].name : `${pendingDelete?.length ?? 0} items`}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {profileId ? "These are deleted from the server immediately." : "These are deleted from this computer immediately."}{" "}
              Folders are deleted with everything inside. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingDelete && pendingDelete.length > 1 ? (
            <ul className="max-h-32 overflow-y-auto rounded-md bg-muted/50 px-3 py-2 text-xs">
              {pendingDelete.slice(0, 8).map((e) => (
                <li key={e.path} className="truncate">
                  {e.name}
                </li>
              ))}
              {pendingDelete.length > 8 ? <li className="text-muted-foreground">and {pendingDelete.length - 8} more</li> : null}
            </ul>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => pendingDelete && void deleteEntries(pendingDelete)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
