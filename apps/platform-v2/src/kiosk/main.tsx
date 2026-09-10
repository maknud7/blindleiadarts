import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { KioskApp } from "./KioskApp";
import "../shared/styles.css";

createRoot(document.getElementById("root")!).render(<StrictMode><KioskApp /></StrictMode>);
