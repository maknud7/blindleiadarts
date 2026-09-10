import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EquipmentApp } from "./EquipmentApp";
import "../shared/styles.css";

createRoot(document.getElementById("root")!).render(<StrictMode><EquipmentApp /></StrictMode>);
