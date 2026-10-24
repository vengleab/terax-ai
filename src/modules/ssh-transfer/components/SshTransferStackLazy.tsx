import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
import type { SshTransferStack as StackType } from "./SshTransferStack";

const Inner = lazy(() => import("./SshTransferStack").then((m) => ({ default: m.SshTransferStack })));

export function SshTransferStack(props: ComponentProps<typeof StackType>) {
  return (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  );
}
