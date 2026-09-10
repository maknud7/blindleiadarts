import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { KioskWorkspace } from "./KioskWorkspace";
import { V2TestNavigation } from "../shared/V2TestNavigation";
import "../shared/styles.css";
import "./scolia-runtime.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <V2TestNavigation active="kiosk" />
    <KioskWorkspace />
  </StrictMode>
);
