import { cn } from "@/lib/utils";
import { fileIconUrl, folderIconUrl } from "@/modules/explorer/lib/iconResolver";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Link01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useEffect, useRef } from "react";
import { formatBytes, formatMode, formatMtime } from "../lib/format";
import { isDirLike } from "../lib/pathOps";
import type { SelectModifiers } from "../lib/selection";
import type { SortKey, SortSpec } from "../lib/sort";
import type { FileEntry, PaneId } from "../types";
import { DIR_ATTR, PATH_ATTR } from "../lib/dnd";
import { NameInput } from "./NameInput";

const ROW_HEIGHT = 24;

type RowProps = {
  entry: FileEntry;
  selected: boolean;
  focused: boolean;
  dropTarget: boolean;
  renaming: boolean;
  showMode: boolean;
  onClick: (entry: FileEntry, modifiers: SelectModifiers) => void;
  onOpen: (entry: FileEntry) => void;
  onPointerDown: (event: React.PointerEvent, entry: FileEntry) => void;
  onContext: (entry: FileEntry) => void;
  onRename: (entry: FileEntry, name: string) => void;
  onCancelRename: () => void;
};

function EntryIcon({ entry }: { entry: FileEntry }) {
  const dir = isDirLike(entry);
  const url = dir ? folderIconUrl(entry.name, false) : fileIconUrl(entry.name);
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      {url ? <img src={url} alt="" className="size-4" draggable={false} /> : null}
      {entry.kind === "symlink" ? (
        <HugeiconsIcon
          icon={Link01Icon}
          size={8}
          strokeWidth={2.5}
          className="absolute -right-0.5 -bottom-0.5 rounded-full bg-background text-muted-foreground"
        />
      ) : null}
    </span>
  );
}

const Row = memo(function Row({
  entry,
  selected,
  focused,
  dropTarget,
  renaming,
  showMode,
  onClick,
  onOpen,
  onPointerDown,
  onContext,
  onRename,
  onCancelRename,
}: RowProps) {
  const dir = isDirLike(entry);
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      {...{ [PATH_ATTR]: entry.path, ...(dir ? { [DIR_ATTR]: "1" } : {}) }}
      className={cn(
        "flex h-6 w-full cursor-default items-center gap-2 rounded-sm px-1.5 text-[13px] select-none",
        selected ? "bg-accent text-foreground" : "text-foreground/85 hover:bg-accent/60",
        focused && !selected && "ring-1 ring-inset ring-border",
        dropTarget && "bg-primary/10 ring-1 ring-inset ring-primary/60",
      )}
      onClick={(e) => onClick(entry, { shift: e.shiftKey, mod: e.metaKey || e.ctrlKey })}
      onDoubleClick={() => onOpen(entry)}
      onPointerDown={(e) => onPointerDown(e, entry)}
      onContextMenu={() => onContext(entry)}
      onKeyDown={undefined}
    >
      <EntryIcon entry={entry} />
      {renaming ? (
        <NameInput
          initial={entry.name}
          onCommit={(name) => onRename(entry, name)}
          onCancel={onCancelRename}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      )}
      <span className="hidden w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground @sm:block">
        {dir ? "" : formatBytes(entry.size)}
      </span>
      <span className="hidden w-28 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground @md:block">
        {formatMtime(entry.mtime)}
      </span>
      {showMode ? (
        <span className="hidden w-[72px] shrink-0 font-mono text-[10.5px] text-muted-foreground @xl:block">
          {formatMode(entry.mode)}
        </span>
      ) : null}
    </div>
  );
});

type HeaderProps = {
  sort: SortSpec;
  showMode: boolean;
  onSort: (key: SortKey) => void;
};

function SortButton({
  label,
  keyName,
  sort,
  onSort,
  className,
}: {
  label: string;
  keyName: SortKey;
  sort: SortSpec;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === keyName;
  return (
    <button
      type="button"
      onClick={() => onSort(keyName)}
      className={cn(
        "flex items-center gap-0.5 rounded-sm px-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground",
        active && "text-foreground",
        className,
      )}
    >
      {label}
      {active ? (
        <HugeiconsIcon
          icon={sort.dir === "asc" ? ArrowUp01Icon : ArrowDown01Icon}
          size={10}
          strokeWidth={2.25}
        />
      ) : null}
    </button>
  );
}

function ListHeader({ sort, showMode, onSort }: HeaderProps) {
  return (
    <div className="flex h-6 shrink-0 items-center gap-2 border-b border-border/60 px-1.5">
      <span className="size-4 shrink-0" />
      <SortButton label="Name" keyName="name" sort={sort} onSort={onSort} className="flex-1 justify-start" />
      <SortButton label="Size" keyName="size" sort={sort} onSort={onSort} className="hidden w-16 justify-end @sm:flex" />
      <SortButton label="Modified" keyName="mtime" sort={sort} onSort={onSort} className="hidden w-28 justify-end @md:flex" />
      {showMode ? (
        <span className="hidden w-[72px] shrink-0 px-1 text-[11px] font-medium text-muted-foreground @xl:block">
          Mode
        </span>
      ) : null}
    </div>
  );
}

type Props = {
  pane: PaneId;
  entries: FileEntry[];
  selection: string[];
  cursor: string | null;
  sort: SortSpec;
  renaming: string | null;
  creating: "file" | "dir" | null;
  hoverDir: string | null;
  showMode: boolean;
  onSort: (key: SortKey) => void;
  onRowClick: (entry: FileEntry, modifiers: SelectModifiers) => void;
  onRowOpen: (entry: FileEntry) => void;
  onRowPointerDown: (event: React.PointerEvent, entry: FileEntry) => void;
  onRowContext: (entry: FileEntry) => void;
  onRename: (entry: FileEntry, name: string) => void;
  onCancelRename: () => void;
  onCreate: (name: string) => void;
  onCancelCreate: () => void;
};

export function FileList({
  entries,
  selection,
  cursor,
  sort,
  renaming,
  creating,
  hoverDir,
  showMode,
  onSort,
  onRowClick,
  onRowOpen,
  onRowPointerDown,
  onRowContext,
  onRename,
  onCancelRename,
  onCreate,
  onCancelCreate,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  useEffect(() => {
    if (!cursor) return;
    const index = entries.findIndex((e) => e.path === cursor);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [cursor, entries, virtualizer]);

  const selected = new Set(selection);

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <ListHeader sort={sort} showMode={showMode} onSort={onSort} />
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-0.5 py-0.5">
        {creating ? (
          <div className="flex h-6 items-center gap-2 px-1.5">
            <img
              src={creating === "dir" ? folderIconUrl("", false) : fileIconUrl("untitled")}
              alt=""
              className="size-4 shrink-0 opacity-70"
            />
            <NameInput
              initial=""
              placeholder={creating === "dir" ? "New folder" : "New file"}
              onCommit={onCreate}
              onCancel={onCancelCreate}
            />
          </div>
        ) : null}
        <div role="presentation" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = entries[item.index];
            if (!entry) return null;
            return (
              <div
                key={entry.path}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <Row
                  entry={entry}
                  selected={selected.has(entry.path)}
                  focused={cursor === entry.path}
                  dropTarget={hoverDir === entry.path}
                  renaming={renaming === entry.path}
                  showMode={showMode}
                  onClick={onRowClick}
                  onOpen={onRowOpen}
                  onPointerDown={onRowPointerDown}
                  onContext={onRowContext}
                  onRename={onRename}
                  onCancelRename={onCancelRename}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
