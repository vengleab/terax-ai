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
import { fileIconUrl, folderIconUrl } from "@/modules/explorer/lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "@/modules/explorer/lib/menuItemClass";
import {
  ArrowRight01Icon,
  ArrowUp01Icon,
  FileAddIcon,
  FolderAddIcon,
  Refresh01Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { sshApi } from "../lib/api";
import { errorMessage, isCancelled, toApiError } from "../lib/errors";
import { joinPath, parentPath, validateNewName } from "../lib/pathOps";
import {
  dropSubtree,
  flattenTree,
  foldersToRefresh,
  type TreeRow,
  type TreeState,
} from "../lib/remoteTree";
import { DEFAULT_VIEW } from "../lib/sort";
import { useProfilesStore } from "../store/profilesStore";
import type { EndpointRef } from "../types";
import { NameInput } from "./NameInput";

const ROW_HEIGHT = 24;

type Creating = { parent: string; kind: "file" | "dir" };

type DisplayRow =
  | TreeRow
  | { kind: "creating"; id: string; depth: number; createKind: "file" | "dir" };

type Props = {
  profileId: string;
  leafId: number;
  remoteCwd: string | null;
  onOpenFile: (profileId: string, path: string) => void;
  onChangeDirectory: (leafId: number, path: string) => void;
};

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="size-6 text-muted-foreground hover:text-foreground"
    >
      {children}
    </Button>
  );
}

export function SshExplorer({ profileId, leafId, remoteCwd, onOpenFile, onChangeDirectory }: Props) {
  const endpoint = useMemo<EndpointRef>(() => ({ kind: "remote", profileId }), [profileId]);
  const profile = useProfilesStore((s) => s.profiles.find((p) => p.id === profileId));
  const connection = useProfilesStore((s) => s.connections[profileId]);
  const connecting = useProfilesStore((s) => !!s.connecting[profileId]);
  const profilesLoaded = useProfilesStore((s) => s.loaded);
  const loadProfiles = useProfilesStore((s) => s.load);
  const connect = useProfilesStore((s) => s.connect);
  const markDisconnected = useProfilesStore((s) => s.markDisconnected);

  const [attempt, setAttempt] = useState(0);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [manualRoot, setManualRoot] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(true);
  const [nodes, setNodes] = useState<TreeState>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ path: string; name: string; isDir: boolean } | null>(null);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const generation = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ready = !!connection;
  const home = connection?.home ?? null;
  const defaultDir = profile?.defaultRemoteDir?.startsWith("/") ? profile.defaultRemoteDir : null;
  const root = ready ? (manualRoot ?? remoteCwd ?? defaultDir ?? home) : null;

  useEffect(() => {
    void remoteCwd;
    void profileId;
    setManualRoot(null);
  }, [remoteCwd, profileId]);

  useEffect(() => {
    void attempt;
    if (!profilesLoaded) {
      void loadProfiles();
      return;
    }
    if (useProfilesStore.getState().connections[profileId]) return;
    let live = true;
    setConnectError(null);
    connect(profileId).catch((error: unknown) => {
      if (live) setConnectError(isCancelled(error) ? "Connection cancelled." : errorMessage(error));
    });
    return () => {
      live = false;
    };
  }, [attempt, profilesLoaded, profileId, connect, loadProfiles]);

  const loadDir = useCallback(
    async (dir: string) => {
      const gen = generation.current;
      setNodes((s) => (s[dir]?.status === "loaded" ? s : { ...s, [dir]: { status: "loading" } }));
      try {
        const entries = await sshApi.fsList(endpoint, dir);
        if (gen !== generation.current) return;
        setNodes((s) => ({ ...s, [dir]: { status: "loaded", entries } }));
      } catch (caught) {
        if (gen !== generation.current) return;
        const error = toApiError(caught);
        if (error.code === "connect") markDisconnected(profileId);
        setNodes((s) => ({ ...s, [dir]: { status: "error", message: error.message } }));
      }
    },
    [endpoint, markDisconnected, profileId],
  );

  useEffect(() => {
    void profileId;
    generation.current += 1;
    setNodes({});
    setExpanded(new Set());
    setSelected(null);
    setRenaming(null);
    setCreating(null);
    if (root) void loadDir(root);
  }, [root, profileId, loadDir]);

  const refresh = useCallback(async () => {
    if (!root) return;
    const dirs = foldersToRefresh(root, nodesRef.current, expandedRef.current);
    await Promise.all(dirs.map((dir) => loadDir(dir)));
  }, [root, loadDir]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const expand = useCallback(
    (path: string) => {
      setExpanded((s) => new Set(s).add(path));
      if (nodesRef.current[path]?.status !== "loaded") void loadDir(path);
    },
    [loadDir],
  );

  const collapse = useCallback((path: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      next.delete(path);
      return next;
    });
  }, []);

  const view = useMemo(() => ({ ...DEFAULT_VIEW, showHidden }), [showHidden]);

  const rows = useMemo<DisplayRow[]>(() => {
    if (!root) return [];
    const base: DisplayRow[] = flattenTree(root, nodes, expanded, view);
    if (!creating) return base;
    const at = creating.parent === root ? -1 : base.findIndex((r) => r.kind === "entry" && r.path === creating.parent);
    if (creating.parent !== root && at < 0) return base;
    const depth = creating.parent === root ? 0 : (base[at] as { depth: number }).depth + 1;
    const insert: DisplayRow = { kind: "creating", id: "\0creating", depth, createKind: creating.kind };
    const next = [...base];
    next.splice(at + 1, 0, insert);
    return next;
  }, [root, nodes, expanded, view, creating]);

  const entryRows = useMemo(
    () => rows.filter((r): r is Extract<TreeRow, { kind: "entry" }> => r.kind === "entry"),
    [rows],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const startCreate = useCallback(
    (parent: string, kind: "file" | "dir") => {
      if (parent !== root) expand(parent);
      setRenaming(null);
      setCreating({ parent, kind });
    },
    [root, expand],
  );

  const afterChange = useCallback(
    async (dir: string) => {
      await loadDir(dir);
    },
    [loadDir],
  );

  const commitCreate = useCallback(
    async (name: string) => {
      const target = creating;
      setCreating(null);
      if (!target) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      const problem = validateNewName(trimmed);
      if (problem) {
        toast.error(problem);
        return;
      }
      const path = joinPath(target.parent, trimmed);
      try {
        if (target.kind === "dir") await sshApi.fsMkdir(endpoint, path);
        else await sshApi.fsCreateFile(endpoint, path);
        await afterChange(target.parent);
        setSelected(path);
        if (target.kind === "file") onOpenFile(profileId, path);
      } catch (error) {
        toast.error(`Could not create ${trimmed}`, { description: errorMessage(error) });
      }
    },
    [creating, endpoint, afterChange, onOpenFile, profileId],
  );

  const commitRename = useCallback(
    async (path: string, isDir: boolean, name: string) => {
      setRenaming(null);
      const trimmed = name.trim();
      if (!trimmed || trimmed === path.slice(path.lastIndexOf("/") + 1)) return;
      const problem = validateNewName(trimmed);
      if (problem) {
        toast.error(problem);
        return;
      }
      const parent = parentPath(path);
      try {
        await sshApi.fsRename(endpoint, path, joinPath(parent, trimmed));
        if (isDir) {
          const out = dropSubtree(nodesRef.current, expandedRef.current, path);
          setNodes(out.nodes);
          setExpanded(out.expanded);
        }
        await afterChange(parent);
        setSelected(joinPath(parent, trimmed));
      } catch (error) {
        toast.error("Could not rename", { description: errorMessage(error) });
      }
    },
    [endpoint, afterChange],
  );

  const confirmDelete = useCallback(async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    try {
      await sshApi.fsRemove(endpoint, [target.path]);
      if (target.isDir) {
        const out = dropSubtree(nodesRef.current, expandedRef.current, target.path);
        setNodes(out.nodes);
        setExpanded(out.expanded);
      }
      setSelected(null);
      await afterChange(parentPath(target.path));
    } catch (error) {
      toast.error(`Could not delete ${target.name}`, { description: errorMessage(error) });
    }
  }, [pendingDelete, endpoint, afterChange]);

  const open = useCallback(
    (row: Extract<TreeRow, { kind: "entry" }>) => {
      if (row.isDir) {
        if (row.expanded) collapse(row.path);
        else expand(row.path);
      } else {
        onOpenFile(profileId, row.path);
      }
    },
    [collapse, expand, onOpenFile, profileId],
  );

  const copyPath = useCallback((path: string) => {
    void navigator.clipboard
      .writeText(path)
      .then(() => toast.success("Path copied"))
      .catch(() => toast.error("Could not copy the path"));
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (renaming || creating || entryRows.length === 0) return;
    const index = entryRows.findIndex((r) => r.path === selected);
    const current = index >= 0 ? entryRows[index] : null;
    const move = (to: number) => {
      const target = entryRows[Math.max(0, Math.min(entryRows.length - 1, to))];
      setSelected(target.path);
      const at = rows.findIndex((r) => r.kind === "entry" && r.path === target.path);
      if (at >= 0) virtualizer.scrollToIndex(at);
    };
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        return move(index + 1);
      case "ArrowUp":
        event.preventDefault();
        return move(index < 0 ? 0 : index - 1);
      case "ArrowRight":
        if (current?.isDir && !current.expanded) {
          event.preventDefault();
          expand(current.path);
        }
        return;
      case "ArrowLeft":
        if (current?.isDir && current.expanded) {
          event.preventDefault();
          collapse(current.path);
        }
        return;
      case "Enter":
        if (current) {
          event.preventDefault();
          open(current);
        }
        return;
      case "F2":
        if (current) {
          event.preventDefault();
          setRenaming(current.path);
        }
        return;
      case "Delete":
        if (current) {
          event.preventDefault();
          setPendingDelete({ path: current.path, name: current.entry.name, isDir: current.isDir });
        }
        return;
      default:
    }
  };

  const serverName = profile?.name ?? "Server";

  if (!ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        {connectError ? (
          <>
            <p className="text-xs text-destructive">{connectError}</p>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </Button>
          </>
        ) : (
          <>
            <Spinner className="size-4" />
            <p className="text-xs text-muted-foreground">
              {connecting ? `Connecting to ${serverName}…` : `Preparing ${serverName}…`}
            </p>
          </>
        )}
      </div>
    );
  }

  const rootError = root ? nodes[root] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-0.5 px-2 pt-1.5 pb-1">
        <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
        <span className="ml-1 min-w-0 truncate text-[11px] font-medium" title={serverName}>
          {serverName}
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          <IconButton label="New file" disabled={!root} onClick={() => root && startCreate(root, "file")}>
            <HugeiconsIcon icon={FileAddIcon} size={13} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="New folder" disabled={!root} onClick={() => root && startCreate(root, "dir")}>
            <HugeiconsIcon icon={FolderAddIcon} size={13} strokeWidth={1.75} />
          </IconButton>
          <IconButton label={showHidden ? "Hide dotfiles" : "Show dotfiles"} onClick={() => setShowHidden((v) => !v)}>
            <HugeiconsIcon icon={showHidden ? ViewIcon : ViewOffSlashIcon} size={13} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Refresh" disabled={!root} onClick={() => void refresh()}>
            <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={1.75} />
          </IconButton>
        </span>
      </div>

      <div className="flex items-center gap-1 px-2 pb-1">
        <IconButton
          label="Go to the parent folder"
          disabled={!root || root === "/"}
          onClick={() => root && setManualRoot(parentPath(root))}
        >
          <HugeiconsIcon icon={ArrowUp01Icon} size={13} strokeWidth={1.75} />
        </IconButton>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={root ?? ""} dir="rtl">
          <bdi>{root ?? ""}</bdi>
        </span>
      </div>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 outline-none"
            role="tree"
            tabIndex={0}
            onKeyDown={onKeyDown}
            aria-label={`${serverName} files`}
          >
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                return (
                  <div
                    key={row.kind === "entry" ? row.path : row.id}
                    className="absolute top-0 left-0 w-full"
                    style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                  >
                    {row.kind === "status" ? (
                      <div
                        className={cn(
                          "flex h-6 items-center truncate text-[11px]",
                          row.tone === "error" ? "text-destructive" : "text-muted-foreground",
                        )}
                        style={{ paddingLeft: 24 + row.depth * 12 }}
                      >
                        {row.text}
                      </div>
                    ) : row.kind === "creating" ? (
                      <div className="flex h-6 items-center gap-1.5 pr-1" style={{ paddingLeft: 6 + row.depth * 12 + 16 }}>
                        <img
                          src={row.createKind === "dir" ? folderIconUrl("", false) : fileIconUrl("untitled")}
                          alt=""
                          className="size-4 shrink-0"
                          draggable={false}
                        />
                        <NameInput
                          initial=""
                          placeholder={row.createKind === "dir" ? "folder name" : "file name"}
                          onCommit={(name) => void commitCreate(name)}
                          onCancel={() => setCreating(null)}
                        />
                      </div>
                    ) : (
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <div
                            role="treeitem"
                            aria-selected={selected === row.path}
                            aria-expanded={row.isDir ? row.expanded : undefined}
                            tabIndex={-1}
                            onKeyDown={undefined}
                            className={cn(
                              "flex h-6 cursor-default items-center gap-1.5 rounded-md pr-1 text-[12.5px] select-none",
                              selected === row.path ? "bg-accent text-foreground" : "text-foreground/85 hover:bg-accent/60",
                            )}
                            style={{ paddingLeft: 6 + row.depth * 12 }}
                            onClick={() => {
                              setSelected(row.path);
                              if (row.isDir) open(row);
                            }}
                            onDoubleClick={() => {
                              if (!row.isDir) open(row);
                            }}
                            onContextMenu={() => setSelected(row.path)}
                          >
                            <span className="flex size-4 shrink-0 items-center justify-center">
                              {row.isDir ? (
                                <HugeiconsIcon
                                  icon={ArrowRight01Icon}
                                  size={11}
                                  strokeWidth={2}
                                  className={cn("text-muted-foreground transition-transform", row.expanded && "rotate-90")}
                                />
                              ) : null}
                            </span>
                            <img
                              src={row.isDir ? folderIconUrl(row.entry.name, row.expanded) : fileIconUrl(row.entry.name)}
                              alt=""
                              className="size-4 shrink-0"
                              draggable={false}
                            />
                            {renaming === row.path ? (
                              <NameInput
                                initial={row.entry.name}
                                onCommit={(name) => void commitRename(row.path, row.isDir, name)}
                                onCancel={() => setRenaming(null)}
                              />
                            ) : (
                              <span className="min-w-0 flex-1 truncate">{row.entry.name}</span>
                            )}
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent className={COMPACT_CONTENT}>
                          {!row.isDir ? (
                            <ContextMenuItem className={COMPACT_ITEM} onSelect={() => open(row)}>
                              Open
                            </ContextMenuItem>
                          ) : null}
                          <ContextMenuItem
                            className={COMPACT_ITEM}
                            onSelect={() => onChangeDirectory(leafId, row.isDir ? row.path : parentPath(row.path))}
                          >
                            cd here in terminal
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            className={COMPACT_ITEM}
                            onSelect={() => startCreate(row.isDir ? row.path : parentPath(row.path), "file")}
                          >
                            New file
                          </ContextMenuItem>
                          <ContextMenuItem
                            className={COMPACT_ITEM}
                            onSelect={() => startCreate(row.isDir ? row.path : parentPath(row.path), "dir")}
                          >
                            New folder
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem className={COMPACT_ITEM} onSelect={() => setRenaming(row.path)}>
                            Rename
                          </ContextMenuItem>
                          <ContextMenuItem
                            className={COMPACT_ITEM}
                            onSelect={() => setPendingDelete({ path: row.path, name: row.entry.name, isDir: row.isDir })}
                          >
                            Delete
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem className={COMPACT_ITEM} onSelect={() => copyPath(row.path)}>
                            Copy path
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    )}
                  </div>
                );
              })}
            </div>
            {rootError?.status === "error" ? (
              <div className="px-2 pt-2">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void refresh()}>
                  Try again
                </Button>
              </div>
            ) : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className={COMPACT_CONTENT}>
          <ContextMenuItem className={COMPACT_ITEM} disabled={!root} onSelect={() => root && startCreate(root, "file")}>
            New file
          </ContextMenuItem>
          <ContextMenuItem className={COMPACT_ITEM} disabled={!root} onSelect={() => root && startCreate(root, "dir")}>
            New folder
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem className={COMPACT_ITEM} onSelect={() => void refresh()}>
            Refresh
          </ContextMenuItem>
          <ContextMenuItem className={COMPACT_ITEM} disabled={!root} onSelect={() => root && copyPath(root)}>
            Copy path
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={!!pendingDelete} onOpenChange={(openState) => !openState && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This is deleted from {serverName} immediately.
              {pendingDelete?.isDir ? " The folder is deleted with everything inside." : ""} This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
