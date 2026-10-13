import { Suspense } from "react";
import WorkspaceShell from "@/components/workspace-shell";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <WorkspaceShell />
    </Suspense>
  );
}
