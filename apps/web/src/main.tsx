import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { followInstallPrompt } from "./install.ts";
import { followAppearance } from "./player/appearance.ts";
import "./theme.css";

followAppearance();
followInstallPrompt();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
