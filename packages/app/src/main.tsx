import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./themes/clean.css";
import "./themes/obsidian.css";
import "./app.css";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
