import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import MethodologyPanel from "./components/MethodologyPanel.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <MethodologyPanel />
  </StrictMode>
);
