import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { KioskErrorBoundary } from "./KioskErrorBoundary";
import { KioskWorkspace } from "./KioskWorkspace";
import { RecentVisitEditor } from "./RecentVisitEditor";
import { initializeTestHandoff } from "./testHandoff";
import "../shared/styles.css";
import "./scolia-runtime.css";
import "./kiosk-tablet.css";
import "./kiosk-interactions.css";
import "./recent-visit-editor.css";

if (initializeTestHandoff()) {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <KioskErrorBoundary>
        <KioskWorkspace />
        <RecentVisitEditor />
      </KioskErrorBoundary>
    </StrictMode>,
  );
}
