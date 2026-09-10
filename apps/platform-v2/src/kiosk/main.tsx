import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { KioskWorkspace } from "./KioskWorkspace";
import "../shared/styles.css";
import "./scolia-runtime.css";

createRoot(document.getElementById("root")!).render(<StrictMode><KioskWorkspace /></StrictMode>);
