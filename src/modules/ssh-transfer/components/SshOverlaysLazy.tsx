import { lazy, Suspense } from "react";

const Inner = lazy(() => import("./Overlays").then((m) => ({ default: m.SshOverlays })));

export function SshOverlays() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
