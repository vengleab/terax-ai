import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";
import { initBench } from "../lib/bench";
import { HostActionsContext, type SshHostActions } from "../lib/hostActions";
import { takeRequestedServer } from "../lib/requested";
import { useProfilesStore } from "../store/profilesStore";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { SshTransferTab } from "../types";
import { DualPaneView } from "./DualPaneView";

type TabLike = { id: number; kind: string; cold?: boolean };

type Props = {
  tabs: TabLike[];
  activeId: number;
  actions: SshHostActions;
};

export function SshTransferStack({ tabs, activeId, actions }: Props) {
  const mine = tabs.filter(
    (t): t is SshTransferTab => t.kind === "ssh-transfer" && !t.cold,
  );
  const loaded = useProfilesStore((s) => s.loaded);
  const load = useProfilesStore((s) => s.load);
  const started = useRef(new Set<number>());

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    if (!loaded) return;
    for (const tab of mine) {
      if (started.current.has(tab.id)) continue;
      started.current.add(tab.id);
      void initBench(tab.id, takeRequestedServer(tab.id));
    }
    const live = new Set(mine.map((t) => t.id));
    for (const id of [...started.current]) {
      if (!live.has(id)) {
        started.current.delete(id);
        useWorkbenchStore.getState().remove(id);
      }
    }
  }, [loaded, mine]);

  if (mine.length === 0) return null;
  return (
    <HostActionsContext.Provider value={actions}>
      <div className="relative h-full w-full">
        {mine.map((tab) => {
          const visible = tab.id === activeId;
          return (
            <div
              key={tab.id}
              className={cn("absolute inset-0", !visible && "invisible pointer-events-none")}
              aria-hidden={!visible}
            >
              <DualPaneView tabId={tab.id} visible={visible} />
            </div>
          );
        })}
      </div>
    </HostActionsContext.Provider>
  );
}
