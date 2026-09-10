import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { KioskWorkspace } from "./KioskWorkspace";
import { initializeTestHandoff } from "./testHandoff";
import "../shared/styles.css";
import "./scolia-runtime.css";
import "./kiosk-tablet.css";

if (initializeTestHandoff()) {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <KioskWorkspace />
    </StrictMode>,
  );
}
