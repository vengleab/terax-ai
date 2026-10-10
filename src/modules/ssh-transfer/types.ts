export type AuthMethod =
  | { kind: "agent" }
  | { kind: "keyFile"; path: string }
  | { kind: "password" };

export type ProfileSource = "manual" | "sshConfig";

export type SshProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: AuthMethod;
  jumpHost: string | null;
  keepaliveSecs: number;
  color: string | null;
  tags: string[];
  favorite: boolean;
  defaultRemoteDir: string | null;
  defaultLocalDir: string | null;
  source: ProfileSource;
};

export type EndpointRef =
  | { kind: "local" }
  | { kind: "remote"; profileId: string };

export type EntryKind = "file" | "dir" | "symlink" | "other";

export type FileEntry = {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  mtime: number | null;
  mode: number | null;
  linkTargetIsDir: boolean | null;
};

export type FileStat = {
  kind: EntryKind;
  size: number;
  mtime: number | null;
  mode: number | null;
};

export type ConnectionInfo = {
  profileId: string;
  host: string;
  port: number;
  user: string;
  home: string;
};

export type ConnectRequest = {
  profileId: string;
  password?: string;
  keyPassphrase?: string;
  jumpPassword?: string;
  jumpKeyPassphrase?: string;
};

export type ErrorCode =
  | "invalid"
  | "not_found"
  | "exists"
  | "permission_denied"
  | "io"
  | "connect"
  | "auth"
  | "password_required"
  | "host_key_unknown"
  | "host_key_changed"
  | "passphrase_required"
  | "passphrase_invalid"
  | "protocol"
  | "cancelled"
  | "unsupported";

export type KnownKey = { line: number; algorithm: string; fingerprint: string };

export type PresentedKey = {
  algorithm: string;
  fingerprint: string;
  publicKey: string;
};

export type HostKeyErrorData = {
  host: string;
  port: number;
  presented: PresentedKey;
  otherKeys?: KnownKey[];
  recorded?: KnownKey[];
  revoked?: boolean;
};

export type HopErrorData = { host: string; port: number };

export type KeyAlgorithm = "ed25519" | "ecdsa-p256" | "ecdsa-p384" | "rsa";

export type KeyInfo = {
  name: string;
  path: string;
  algorithm: string;
  fingerprint: string;
  comment: string;
  encrypted: boolean;
  hasPublicFile: boolean;
  publicKey: string | null;
};

export type GenerateKeySpec = {
  name: string;
  algorithm: KeyAlgorithm;
  comment: string;
  passphrase?: string;
};

export type KnownHostRow = {
  line: number;
  hosts: string[];
  hashed: boolean;
  algorithm: string;
  fingerprint: string;
  comment: string | null;
  marker: "revoked" | "certAuthority" | null;
};

export type ImportSummary = { added: string[]; skipped: string[] };
export type ConfigImport = { summary: ImportSummary; warnings: string[] };

export type ForwardKind =
  | {
      kind: "local";
      listenHost: string;
      listenPort: number;
      destHost: string;
      destPort: number;
    }
  | {
      kind: "remote";
      bindHost: string;
      bindPort: number;
      destHost: string;
      destPort: number;
    }
  | { kind: "dynamic"; listenHost: string; listenPort: number };

export type ForwardSpec = {
  id: string;
  profileId: string;
  name: string;
  autostart: boolean;
  expose: boolean;
} & ForwardKind;

export type TunnelStatus = {
  id: string;
  boundPort: number;
  activeConnections: number;
  totalConnections: number;
  bytesIn: number;
  bytesOut: number;
};

export type TransferMode = "copy" | "move";
export type ConflictPolicy = "ask" | "overwrite" | "skip" | "rename" | "update";
export type ConflictDecision = "overwrite" | "skip" | "rename" | "cancel";

export type TransferRequest = {
  src: EndpointRef;
  dst: EndpointRef;
  sources: string[];
  dstDir: string;
  mode?: TransferMode;
  conflict?: ConflictPolicy;
  resume?: boolean;
  concurrency?: number;
};

export type SkippedItem = { path: string; reason: string };
export type ItemError = { path: string; message: string };

export type ConflictInfo = {
  srcPath: string;
  dstPath: string;
  srcSize: number;
  dstSize: number;
  srcMtime: number | null;
  dstMtime: number | null;
};

export type TransferSummary = {
  filesDone: number;
  bytesDone: number;
  filesSkipped: number;
  moved: number;
  errors: ItemError[];
  skipped: SkippedItem[];
  cancelled: boolean;
};

export type WireEvent =
  | { kind: "planned"; files: number; bytes: number; skipped: SkippedItem[] }
  | {
      kind: "progress";
      bytesDone: number;
      bytesTotal: number;
      filesDone: number;
      filesTotal: number;
      bytesPerSec: number;
      current: string[];
    }
  | { kind: "conflict"; conflictId: number; info: ConflictInfo }
  | { kind: "finished"; summary: TransferSummary }
  | { kind: "failed"; error: { code: ErrorCode; message: string } };

export type EditInfo = { id: string; remotePath: string; localPath: string };

export type SyncOutcome =
  | { kind: "uploaded"; size: number }
  | { kind: "unchanged" }
  | {
      kind: "conflict";
      remoteMtime: number | null;
      remoteSize: number;
      baselineMtime: number | null;
      baselineSize: number;
    };

export type EditSyncEvent = {
  id: string;
  outcome?: SyncOutcome;
  error?: { code: ErrorCode; message: string };
};

export type PaneId = "left" | "right";

export type SshTransferTab = {
  id: number;
  kind: "ssh-transfer";
  title: string;
  spaceId: string;
  cold?: boolean;
};
