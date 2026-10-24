import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
import type { SshSidebar as SshSidebarType } from "./SshSidebar";

const Inner = lazy(() => import("./SshSidebar").then((m) => ({ default: m.SshSidebar })));

export function SshSidebar(props: ComponentProps<typeof SshSidebarType>) {
  return (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  );
}
