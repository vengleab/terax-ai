import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  ComputerIcon,
  FileAddIcon,
  FolderAddIcon,
  Refresh01Icon,
  Search01Icon,
  ServerStack01Icon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { breadcrumbs } from "../lib/pathOps";
import { useProfilesStore } from "../store/profilesStore";
import { useUiStore } from "../store/uiStore";
import type { EndpointRef } from "../types";
import { LOCAL_LABEL } from "../lib/labels";

type IconProps = Parameters<typeof HugeiconsIcon>[0]["icon"];

function IconButton({
  icon,
  label,
  onClick,
  disabled,
  active,
}: {
  icon: IconProps;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className={cn(active && "bg-muted text-foreground")}
        >
          <HugeiconsIcon icon={icon} size={13} strokeWidth={1.75} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

type SourceProps = {
  endpoint: EndpointRef;
  onPickLocal: () => void;
  onPickServer: (profileId: string) => void;
};

function SourceMenu({ endpoint, onPickLocal, onPickServer }: SourceProps) {
  const profiles = useProfilesStore((s) => s.profiles);
  const connections = useProfilesStore((s) => s.connections);
  const openDialog = useUiStore((s) => s.open);
  const current =
    endpoint.kind === "local"
      ? LOCAL_LABEL
      : (profiles.find((p) => p.id === endpoint.profileId)?.name ?? "Server");
  const connected = endpoint.kind === "remote" && !!connections[endpoint.profileId];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="xs" className="max-w-40 shrink-0 gap-1.5">
          <HugeiconsIcon
            icon={endpoint.kind === "local" ? ComputerIcon : ServerStack01Icon}
            size={12}
            strokeWidth={1.75}
            className={cn(endpoint.kind === "remote" && (connected ? "text-emerald-500" : "text-muted-foreground"))}
          />
          <span className="truncate">{current}</span>
          <HugeiconsIcon icon={ArrowDown01Icon} size={10} strokeWidth={2} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuLabel className="text-[11px]">Show files from</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onPickLocal}>
          <HugeiconsIcon icon={ComputerIcon} size={13} strokeWidth={1.75} />
          {LOCAL_LABEL}
        </DropdownMenuItem>
        {profiles.length > 0 ? <DropdownMenuSeparator /> : null}
        {profiles.map((profile) => (
          <DropdownMenuItem key={profile.id} onSelect={() => onPickServer(profile.id)}>
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                connections[profile.id] ? "bg-emerald-500" : "bg-muted-foreground/40",
              )}
            />
            <span className="truncate">{profile.name}</span>
            <span className="ml-auto truncate pl-2 text-[11px] text-muted-foreground">
              {profile.user}@{profile.host}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openDialog({ kind: "profile" })}>Add a server...</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type PathBarProps = {
  path: string;
  onGo: (path: string) => void;
  focusToken: number;
};

function PathBar({ path, onGo, focusToken }: PathBarProps) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const crumbs = breadcrumbs(path);

  useEffect(() => {
    if (focusToken > 0) setEditing(true);
  }, [focusToken]);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  if (editing) {
    return (
      <Input
        ref={input}
        defaultValue={path}
        spellCheck={false}
        aria-label="Folder path"
        className="h-6 flex-1 rounded-md px-2 text-xs"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            setEditing(false);
            onGo(e.currentTarget.value);
          } else if (e.key === "Escape") setEditing(false);
        }}
        onBlur={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="flex h-6 min-w-0 flex-1 items-center overflow-hidden rounded-md bg-input/40 px-1 text-xs">
      <div className="flex min-w-0 shrink flex-row-reverse items-center overflow-hidden">
        <div className="flex shrink-0 items-center">
          {crumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex items-center">
              {index > 0 ? (
                <HugeiconsIcon icon={ArrowRight01Icon} size={10} strokeWidth={2} className="text-muted-foreground/60" />
              ) : null}
              <button
                type="button"
                onClick={() => onGo(crumb.path)}
                className="rounded-sm px-1 text-muted-foreground transition-colors last:text-foreground hover:bg-muted hover:text-foreground"
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
      </div>
      <button
        type="button"
        aria-label="Type a path"
        title="Click to type a path"
        onClick={() => setEditing(true)}
        className="h-full min-w-4 flex-1 cursor-text"
      />
    </div>
  );
}

type Props = {
  endpoint: EndpointRef;
  path: string;
  canBack: boolean;
  canForward: boolean;
  showHidden: boolean;
  filter: string;
  pathFocusToken: number;
  disabled: boolean;
  onPickLocal: () => void;
  onPickServer: (profileId: string) => void;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onGo: (path: string) => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onToggleHidden: () => void;
  onFilter: (value: string) => void;
};

export function PaneToolbar(props: Props) {
  const [filterOpen, setFilterOpen] = useState(props.filter.length > 0);
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-border/60 px-2 py-1.5">
      <div className="flex items-center gap-1">
        <SourceMenu
          endpoint={props.endpoint}
          onPickLocal={props.onPickLocal}
          onPickServer={props.onPickServer}
        />
        <PathBar path={props.path} onGo={props.onGo} focusToken={props.pathFocusToken} />
      </div>
      <div className="flex items-center gap-0.5">
        <IconButton icon={ArrowLeft01Icon} label="Back" onClick={props.onBack} disabled={props.disabled || !props.canBack} />
        <IconButton icon={ArrowRight01Icon} label="Forward" onClick={props.onForward} disabled={props.disabled || !props.canForward} />
        <IconButton icon={ArrowUp01Icon} label="Up one folder" onClick={props.onUp} disabled={props.disabled} />
        <IconButton icon={Refresh01Icon} label="Refresh" onClick={props.onRefresh} disabled={props.disabled} />
        <span className="mx-1 h-4 w-px bg-border/70" />
        <IconButton icon={FolderAddIcon} label="New folder" onClick={props.onNewFolder} disabled={props.disabled} />
        <IconButton icon={FileAddIcon} label="New file" onClick={props.onNewFile} disabled={props.disabled} />
        <span className="mx-1 h-4 w-px bg-border/70" />
        <IconButton
          icon={props.showHidden ? ViewIcon : ViewOffIcon}
          label={props.showHidden ? "Hide hidden files" : "Show hidden files"}
          onClick={props.onToggleHidden}
          active={props.showHidden}
        />
        <IconButton
          icon={Search01Icon}
          label="Filter this folder"
          onClick={() => {
            if (filterOpen) props.onFilter("");
            setFilterOpen(!filterOpen);
          }}
          active={filterOpen}
        />
        {filterOpen ? (
          <Input
            autoFocus
            value={props.filter}
            onChange={(e) => props.onFilter(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                props.onFilter("");
                setFilterOpen(false);
              }
            }}
            placeholder="Filter"
            aria-label="Filter files"
            className="ml-1 h-6 min-w-0 flex-1 rounded-md px-2 text-xs"
          />
        ) : null}
      </div>
    </div>
  );
}
