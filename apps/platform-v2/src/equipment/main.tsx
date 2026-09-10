import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EquipmentWorkspace } from "./EquipmentWorkspace";
import "../shared/styles.css";
import "./scolia.css";
import "./board-editor.css";

createRoot(document.getElementById("root")!).render(<StrictMode><EquipmentWorkspace /></StrictMode>);
