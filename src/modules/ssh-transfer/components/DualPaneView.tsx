import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ArrowRight01Icon,
  ArrowLeft01Icon,
  FolderTransferIcon,
  Key01Icon,
  PlugSocketIcon,
  SecurityLockIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { endpointLabel } from "../lib/labels";
import { buildTransfer } from "../lib/transferPlan";
import { useDualPaneDnd, type PaneDrop } from "../lib/useDualPaneDnd";
import { useOsFileDrop } from "../lib/useOsFileDrop";
import { useProfilesStore } from "../store/profilesStore";
import { useTransferStore } from "../store/transferStore";
import { useUiStore } from "../store/uiStore";
import { otherPane, useWorkbenchStore } from "../store/workbenchStore";
import type { PaneId, TransferMode } from "../types";
import { FilePane } from "./FilePane";
import { TransferQueue } from "./TransferQueue";

type IconProps = Parameters<typeof HugeiconsIcon>[0]["icon"];

function BarButton({
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
        <Button type="button" variant="ghost" size="xs" aria-label={label} onClick={onClick} className="gap-1.5">
          <HugeiconsIcon icon={icon} size={13} strokeWidth={1.75} />
          <span className="hidden @2xl:inline">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

type Props = { tabId: number; visible: boolean };

export function DualPaneView({ tabId, visible }: Props) {
  const openDialog = useUiStore((s) => s.open);
  const finishedTick = useTransferStore((s) => s.finishedTick);
  const ready = useWorkbenchStore((s) => !!s.benches[tabId]);

  const start = useCallback(
    (from: PaneId, to: PaneId, paths: string[], mode: TransferMode, dstDir: string | null) => {
      const bench = useWorkbenchStore.getState().benches[tabId];
      if (!bench) return;
      const profiles = useProfilesStore.getState().profiles;
      const built = buildTransfer({
        src: bench[from],
        dst: bench[to],
        paths,
        mode,
        dstDir: dstDir ?? undefined,
        label: (endpoint) => endpointLabel(endpoint, profiles),
      });
      if (!built.ok) {
        toast.error(built.reason);
        return;
      }
      useTransferStore.getState().start(built.request, built);
    },
    [tabId],
  );

  const transferSelection = useCallback(
    (from: PaneId, mode: TransferMode) => {
      const bench = useWorkbenchStore.getState().benches[tabId];
      if (!bench) return;
      if (bench[from].selection.length === 0) {
        toast(`Select files in the ${from} pane first`);
        return;
      }
      start(from, otherPane(from), bench[from].selection, mode, null);
    },
    [tabId, start],
  );

  const onDrop = useCallback(
    (drop: PaneDrop) => {
      if (drop.from === drop.to && drop.dir === null) return;
      const insidePane = drop.from === drop.to;
      start(drop.from, drop.to, drop.paths, insidePane || drop.move ? "move" : "copy", drop.dir);
    },
    [start],
  );

  const dnd = useDualPaneDnd({
    getSelection: (pane) => useWorkbenchStore.getState().benches[tabId]?.[pane].selection ?? [],
    onDrop,
  });

  useOsFileDrop({
    active: visible,
    onDrop: (target, paths) => {
      const bench = useWorkbenchStore.getState().benches[tabId];
      if (!bench) return;
      const profiles = useProfilesStore.getState().profiles;
      const dst = bench[target.pane];
      const built = buildTransfer({
        src: { endpoint: { kind: "local" }, path: "" },
        dst,
        paths,
        mode: "copy",
        dstDir: target.dir ?? undefined,
        label: (endpoint) => endpointLabel(endpoint, profiles),
      });
      if (!built.ok) {
        toast.error(built.reason);
        return;
      }
      useTransferStore.getState().start(built.request, built);
    },
  });

  useEffect(() => {
    if (finishedTick > 0) useWorkbenchStore.getState().refreshMatching(null);
  }, [finishedTick]);

  if (!ready) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Preparing file panes</div>;
  }

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border/60 px-2">
        <BarButton icon={ArrowRight01Icon} label="Copy to right" onClick={() => transferSelection("left", "copy")} />
        <BarButton icon={ArrowLeft01Icon} label="Copy to left" onClick={() => transferSelection("right", "copy")} />
        <span className="mx-1 h-4 w-px bg-border/70" />
        <BarButton icon={FolderTransferIcon} label="Move to right" onClick={() => transferSelection("left", "move")} />
        <BarButton icon={FolderTransferIcon} label="Move to left" onClick={() => transferSelection("right", "move")} />
        <span className="flex-1" />
        <BarButton icon={ServerStack01Icon} label="Servers" onClick={() => openDialog({ kind: "profile" })} />
        <BarButton icon={Key01Icon} label="Keys" onClick={() => openDialog({ kind: "keys" })} />
        <BarButton icon={PlugSocketIcon} label="Tunnels" onClick={() => openDialog({ kind: "tunnels" })} />
        <BarButton icon={SecurityLockIcon} label="Known hosts" onClick={() => openDialog({ kind: "knownHosts" })} />
      </div>
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <ResizablePanel id={`sshx-left-${tabId}`} defaultSize="50%" minSize="20%">
            <FilePane
              tabId={tabId}
              pane="left"
              visible={visible}
              onTransfer={transferSelection}
              onRowPointerDown={dnd.onRowPointerDown}
              consumeSuppressedClick={dnd.consumeSuppressedClick}
            />
          </ResizablePanel>
          <ResizableHandle className="w-px bg-border/70" />
          <ResizablePanel id={`sshx-right-${tabId}`} defaultSize="50%" minSize="20%">
            <FilePane
              tabId={tabId}
              pane="right"
              visible={visible}
              onTransfer={transferSelection}
              onRowPointerDown={dnd.onRowPointerDown}
              consumeSuppressedClick={dnd.consumeSuppressedClick}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <TransferQueue />
    </div>
  );
}
