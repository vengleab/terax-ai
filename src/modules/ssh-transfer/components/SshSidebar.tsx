import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Add01Icon,
  ComputerTerminal02Icon,
  Edit02Icon,
  FolderTransferIcon,
  Key01Icon,
  PlugSocketIcon,
  SecurityLockIcon,
  ServerStack01Icon,
  Wifi01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { errorMessage, isCancelled } from "../lib/errors";
import { useProfilesStore } from "../store/profilesStore";
import { useUiStore } from "../store/uiStore";
import type { SshProfile } from "../types";

type IconProps = Parameters<typeof HugeiconsIcon>[0]["icon"];

type Props = {
  onOpenTransfer: (profileId?: string) => void;
  onOpenTerminal: (profileId: string) => void;
};

function RowAction({
  icon,
  label,
  onClick,
}: {
  icon: IconProps;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          className="size-5 text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon icon={icon} size={12} strokeWidth={1.75} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ServerRow({
  profile,
  connected,
  busy,
  onOpenTransfer,
  onOpenTerminal,
}: {
  profile: SshProfile;
  connected: boolean;
  busy: boolean;
  onOpenTransfer: () => void;
  onOpenTerminal: () => void;
}) {
  const openDialog = useUiStore((s) => s.open);
  const connect = useProfilesStore((s) => s.connect);
  const disconnect = useProfilesStore((s) => s.disconnect);

  const toggle = async () => {
    if (connected) {
      await disconnect(profile.id);
      return;
    }
    try {
      await connect(profile.id);
    } catch (error) {
      if (!isCancelled(error)) toast.error(errorMessage(error));
    }
  };

  return (
    <div className="group flex min-h-9 items-center rounded-md transition-colors hover:bg-accent/60 focus-within:bg-accent/40">
      <button
        type="button"
        onClick={onOpenTransfer}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <HugeiconsIcon
            icon={ServerStack01Icon}
            size={14}
            strokeWidth={1.75}
            style={profile.color ? { color: profile.color } : undefined}
            className={cn(!profile.color && "text-muted-foreground")}
          />
          <span
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-card",
              busy ? "animate-pulse bg-amber-500" : connected ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-4">{profile.name}</span>
          <span className="block truncate text-[11px] leading-4 text-muted-foreground">
            {profile.user}@{profile.host}
            {profile.port !== 22 ? `:${profile.port}` : ""}
          </span>
        </span>
      </button>
      <span className="flex shrink-0 items-center pr-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <RowAction icon={Wifi01Icon} label={connected ? "Disconnect" : "Connect"} onClick={() => void toggle()} />
        <RowAction icon={ComputerTerminal02Icon} label="Open terminal" onClick={onOpenTerminal} />
        <RowAction icon={PlugSocketIcon} label="Tunnels" onClick={() => openDialog({ kind: "tunnels", profileId: profile.id })} />
        <RowAction icon={Edit02Icon} label="Edit server" onClick={() => openDialog({ kind: "profile", profileId: profile.id })} />
      </span>
    </div>
  );
}

export function SshSidebar({ onOpenTransfer, onOpenTerminal }: Props) {
  const profiles = useProfilesStore((s) => s.profiles);
  const loaded = useProfilesStore((s) => s.loaded);
  const loadError = useProfilesStore((s) => s.loadError);
  const connections = useProfilesStore((s) => s.connections);
  const connecting = useProfilesStore((s) => s.connecting);
  const load = useProfilesStore((s) => s.load);
  const importConfig = useProfilesStore((s) => s.importFromSshConfig);
  const openDialog = useUiStore((s) => s.open);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return profiles
      .filter((p) => !needle || `${p.name} ${p.host} ${p.user} ${p.tags.join(" ")}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  }, [profiles, query]);

  const runImport = async () => {
    try {
      const result = await importConfig();
      const added = result.summary.added.length;
      toast(added > 0 ? `Imported ${added} ${added === 1 ? "server" : "servers"}` : "Nothing new to import", {
        description:
          result.warnings[0] ??
          (result.summary.skipped.length > 0 ? `${result.summary.skipped.length} skipped` : undefined),
      });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2 pt-2 pb-1">
        <span className="flex-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">SSH servers</span>
        <RowAction icon={Add01Icon} label="Add server" onClick={() => openDialog({ kind: "profile" })} />
        <RowAction icon={Key01Icon} label="SSH keys" onClick={() => openDialog({ kind: "keys" })} />
        <RowAction icon={PlugSocketIcon} label="Tunnels" onClick={() => openDialog({ kind: "tunnels" })} />
        <RowAction icon={SecurityLockIcon} label="Known hosts" onClick={() => openDialog({ kind: "knownHosts" })} />
      </div>
      {profiles.length > 4 ? (
        <div className="px-2 pb-1">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search servers"
            aria-label="Search servers"
            className="h-7 rounded-md px-2 text-xs"
          />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {loadError ? (
          <div className="m-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">{loadError}</div>
        ) : null}
        {!loaded ? (
          <div className="p-3 text-xs text-muted-foreground">Loading</div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
            <HugeiconsIcon icon={ServerStack01Icon} size={22} strokeWidth={1.5} className="text-muted-foreground/70" />
            <div className="text-xs text-muted-foreground">
              {profiles.length === 0 ? "Add a server to browse and transfer files over SSH." : "No servers match."}
            </div>
            {profiles.length === 0 ? (
              <div className="flex flex-col gap-1.5">
                <Button type="button" size="xs" onClick={() => openDialog({ kind: "profile" })}>
                  Add server
                </Button>
                <Button type="button" size="xs" variant="outline" onClick={() => void runImport()}>
                  Import from ~/.ssh/config
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          visible.map((profile) => (
            <ServerRow
              key={profile.id}
              profile={profile}
              connected={!!connections[profile.id]}
              busy={!!connecting[profile.id]}
              onOpenTransfer={() => onOpenTransfer(profile.id)}
              onOpenTerminal={() => onOpenTerminal(profile.id)}
            />
          ))
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-1 border-t border-border/60 p-2">
        <Button type="button" size="xs" onClick={() => onOpenTransfer()} className="w-full gap-1.5">
          <HugeiconsIcon icon={FolderTransferIcon} size={13} strokeWidth={1.75} />
          Open file transfer
        </Button>
        {profiles.length > 0 ? (
          <Button type="button" size="xs" variant="ghost" onClick={() => void runImport()} className="w-full text-muted-foreground">
            Import from ~/.ssh/config
          </Button>
        ) : null}
      </div>
    </div>
  );
}
