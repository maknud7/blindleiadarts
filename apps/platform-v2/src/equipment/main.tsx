import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EquipmentWorkspace } from "./EquipmentWorkspace";
import { V2TestNavigation } from "../shared/V2TestNavigation";
import "../shared/styles.css";
import "./scolia.css";
import "./board-editor.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <V2TestNavigation active="equipment" />
    <EquipmentWorkspace />
  </StrictMode>
);
