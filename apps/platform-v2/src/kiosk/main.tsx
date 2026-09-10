import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PlatformNav } from "../shared/PlatformNav";
import { KioskWorkspace } from "./KioskWorkspace";
import { initializeTestHandoff } from "./testHandoff";
import "../shared/styles.css";
import "./scolia-runtime.css";

if (initializeTestHandoff()) {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <PlatformNav active="kiosk" />
      <KioskWorkspace />
    </StrictMode>,
  );
}
