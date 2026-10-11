import { IS_WINDOWS } from "@/lib/platform";
import { quoteShellArg } from "@/lib/shellQuote";
import { cn } from "@/lib/utils";
import type { PaletteItem } from "@/modules/command-palette/types";
import type { Tab } from "@/modules/tabs";
import {
  leafHasForegroundProcess,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import { FolderTransferIcon } from "@hugeicons/core-free-icons";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { SshExplorer } from "../components/SshExplorerLazy";
import { SshOverlays } from "../components/SshOverlaysLazy";
import { SshTransferStack } from "../components/SshTransferStackLazy";
import { SSH_SIDEBAR_VIEW, SSH_TAB_KIND, SSH_TAB_TITLE } from "../constants";
import type { SshTransferTab } from "../types";
import type { SshHostActions } from "./hostActions";
import { requestServerForTab } from "./requested";
import {
  parseRemoteCwdTitle,
  readTitleEvent,
  TERMINAL_TITLE_EVENT,
} from "./remoteCwd";
import { useSshTerminals } from "./sshTerminals";

const ENDED_GRACE_MS = 15_000;
const ENDED_POLL_MS = 3_000;

type Params = {
  tabs: Tab[];
  activeId: number;
  spaceId: string;
  sidebarView: string;
  allocId: () => number;
  replaceTabs: (next: Tab[], activeId: number) => void;
  setActiveId: (id: number) => void;
  openFileTab: (path: string, pin?: boolean) => number | null | undefined;
  newAgentTab: (
    cwd: string | undefined,
    title: string,
  ) => { tabId: number; leafId: number };
  getCwd: () => string | undefined;
};

export type SshTransferApi = {
  openTransfer: (profileId?: string) => void;
  openTerminal: (profileId: string) => void;
  actions: SshHostActions;
  surface: ReactNode;
  /** The server's file tree, when the active terminal is an SSH session opened from the SSH panel. */
  explorer: ReactNode;
  overlays: ReactNode;
  paletteItems: PaletteItem[];
};

function failure(message: string, error: unknown) {
  const text = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
  toast.error(message, { description: text });
}

/**
 * Wires SSH File Transfer into the app shell. It loads nothing until the sidebar view or a
 * transfer tab is first shown, and keeps the app's own code free of any SSH knowledge.
 */
export function useSshTransfer(params: Params): SshTransferApi {
  const latest = useRef(params);
  latest.current = params;

  const [activated, setActivated] = useState(false);
  const hasTab = params.tabs.some((t) => t.kind === SSH_TAB_KIND);
  if (!activated && (hasTab || params.sidebarView === SSH_SIDEBAR_VIEW)) {
    setActivated(true);
  }

  const openTransfer = useCallback((profileId?: string) => {
    const { tabs, spaceId, allocId, replaceTabs, setActiveId } = latest.current;
    const existing = tabs.find((t) => t.kind === SSH_TAB_KIND && t.spaceId === spaceId);
    if (existing) {
      setActiveId(existing.id);
      if (profileId) {
        void import("./bench").then((m) => m.openServerInPane(existing.id, "right", profileId));
      }
      return;
    }
    const id = allocId();
    if (profileId) requestServerForTab(id, profileId);
    const tab: SshTransferTab = { id, kind: SSH_TAB_KIND, title: SSH_TAB_TITLE, spaceId };
    replaceTabs([...tabs, tab as unknown as Tab], id);
  }, []);

  const openTerminal = useCallback((profileId: string) => {
    void (async () => {
      try {
        const [{ sshApi }, { buildSshCommand, REMOTE_CWD_COMMAND }] = await Promise.all([
          import("./api"),
          import("./sshCommand"),
        ]);
        const [args, profiles] = await Promise.all([
          sshApi.terminalArgs(profileId),
          sshApi.profilesList(),
        ]);
        const name = profiles.find((p) => p.id === profileId)?.name ?? "ssh";
        const { newAgentTab, getCwd } = latest.current;
        const { tabId, leafId } = newAgentTab(getCwd(), name);
        useSshTerminals.getState().register({ tabId, leafId, profileId });
        await whenSessionReady(leafId);
        const remote = IS_WINDOWS ? undefined : REMOTE_CWD_COMMAND;
        writeToSession(leafId, `${buildSshCommand(args, undefined, remote)}\r`);
      } catch (error) {
        failure("Could not open an SSH terminal", error);
      }
    })();
  }, []);

  const openRemoteFile = useCallback((profileId: string, remotePath: string) => {
    void (async () => {
      try {
        const [{ sshApi }, registry] = await Promise.all([import("./api"), import("./editRegistry")]);
        const { tabs, openFileTab } = latest.current;
        const known = registry.findEditByRemote(profileId, remotePath);
        if (known) {
          const open = tabs.some((t) => t.kind === "editor" && t.path === known.localPath);
          if (open) {
            openFileTab(known.localPath, true);
            return;
          }
          registry.forgetEdit(known.id);
          await sshApi.editClose(known.id).catch(() => undefined);
        }
        const info = await sshApi.editOpen(profileId, remotePath);
        registry.rememberEdit(profileId, info);
        openFileTab(info.localPath, true);
      } catch (error) {
        failure("Could not open the remote file", error);
      }
    })();
  }, []);

  const changeRemoteDirectory = useCallback((leafId: number, path: string) => {
    writeToSession(leafId, `cd ${quoteShellArg(path, false)}\r`);
  }, []);

  useEffect(() => {
    const onTitle = (event: Event) => {
      const detail = readTitleEvent(event);
      const cwd = detail && parseRemoteCwdTitle(detail.title);
      if (detail && cwd) useSshTerminals.getState().setRemoteCwd(detail.leafId, cwd);
    };
    window.addEventListener(TERMINAL_TITLE_EVENT, onTitle);
    return () => window.removeEventListener(TERMINAL_TITLE_EVENT, onTitle);
  }, []);

  useEffect(() => {
    useSshTerminals.getState().prune(new Set(params.tabs.map((t) => t.id)));
  }, [params.tabs]);

  const sshTerminals = useSshTerminals((s) => s.terminals);
  const activeTab = params.tabs.find((t) => t.id === params.activeId);
  const tagged = activeTab?.kind === "terminal" ? sshTerminals[activeTab.id] : undefined;
  const taggedTabId = tagged?.tabId;
  const taggedLeafId = tagged?.leafId;
  const taggedStartedAt = tagged?.startedAt;

  useEffect(() => {
    if (taggedTabId === undefined || taggedLeafId === undefined || taggedStartedAt === undefined) return;
    let live = true;
    let seenRunning = false;
    let misses = 0;
    const timer = setInterval(() => {
      void leafHasForegroundProcess(taggedLeafId).then((running) => {
        if (!live) return;
        if (running) {
          seenRunning = true;
          misses = 0;
          return;
        }
        if (!seenRunning && Date.now() - taggedStartedAt < ENDED_GRACE_MS) return;
        misses += 1;
        if (misses >= 2) useSshTerminals.getState().forget(taggedTabId);
      });
    }, ENDED_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [taggedTabId, taggedLeafId, taggedStartedAt]);

  const explorer =
    tagged && params.sidebarView === "explorer" ? (
      <SshExplorer
        key={tagged.tabId}
        profileId={tagged.profileId}
        leafId={tagged.leafId}
        remoteCwd={tagged.remoteCwd}
        onOpenFile={openRemoteFile}
        onChangeDirectory={changeRemoteDirectory}
      />
    ) : null;

  const actions = useMemo<SshHostActions>(
    () => ({
      openLocalFile: (path) => void latest.current.openFileTab(path, true),
      openRemoteFile,
      openTerminal,
    }),
    [openRemoteFile, openTerminal],
  );

  const activeKind = params.tabs.find((t) => t.id === params.activeId)?.kind;
  const surface = hasTab ? (
    <div
      className={cn("absolute inset-0", activeKind !== SSH_TAB_KIND && "invisible pointer-events-none")}
      aria-hidden={activeKind !== SSH_TAB_KIND}
    >
      <SshTransferStack tabs={params.tabs} activeId={params.activeId} actions={actions} />
    </div>
  ) : null;

  const openDialog = useCallback((request: import("../store/uiStore").DialogRequest) => {
    void import("../store/uiStore").then((m) => m.useUiStore.getState().open(request));
  }, []);

  const paletteItems = useMemo<PaletteItem[]>(
    () => [
      {
        id: "ssh.open-transfer",
        title: "SSH: Open file transfer",
        group: "Tabs",
        icon: FolderTransferIcon,
        keywords: ["sftp", "scp", "server", "upload", "download", "remote", "files"],
        run: () => openTransfer(),
      },
      {
        id: "ssh.add-server",
        title: "SSH: Add server",
        group: "Tabs",
        keywords: ["ssh", "host", "connection", "profile"],
        run: () => openDialog({ kind: "profile" }),
      },
      {
        id: "ssh.keys",
        title: "SSH: Manage keys",
        group: "Tabs",
        keywords: ["ssh", "key", "generate", "identity", "authorized"],
        run: () => openDialog({ kind: "keys" }),
      },
      {
        id: "ssh.tunnels",
        title: "SSH: Port forwarding",
        group: "Tabs",
        keywords: ["ssh", "tunnel", "forward", "socks", "port"],
        run: () => openDialog({ kind: "tunnels" }),
      },
      {
        id: "ssh.known-hosts",
        title: "SSH: Known hosts",
        group: "Tabs",
        keywords: ["ssh", "host key", "fingerprint", "trust"],
        run: () => openDialog({ kind: "knownHosts" }),
      },
    ],
    [openTransfer, openDialog],
  );

  return {
    openTransfer,
    openTerminal,
    actions,
    surface,
    explorer,
    overlays: activated ? <SshOverlays /> : null,
    paletteItems,
  };
}
