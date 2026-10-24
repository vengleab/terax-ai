import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
import type { SshExplorer as SshExplorerType } from "./SshExplorer";

const Inner = lazy(() => import("./SshExplorer").then((m) => ({ default: m.SshExplorer })));

export function SshExplorer(props: ComponentProps<typeof SshExplorerType>) {
  return (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  );
}
