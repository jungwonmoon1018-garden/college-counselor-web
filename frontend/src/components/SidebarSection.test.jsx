import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import SidebarSection from "./SidebarSection.jsx";

// The test DOM's storage is not a real Storage; the section only needs
// getItem / setItem.
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    clear: () => { map.clear(); },
  };
}

describe("SidebarSection", () => {
  beforeEach(() => { Object.defineProperty(globalThis, "localStorage", { value: memoryStorage(), configurable: true, writable: true }); });
  afterEach(cleanup);

  it("folds its content behind the heading and remembers the fold", () => {
    render(
      <SidebarSection id="ecs" title="ECs" count={3} action={<button type="button">+ New</button>}>
        <p>Robotics</p>
      </SidebarSection>,
    );
    const heading = screen.getByRole("button", { name: "ECs (3)" });
    expect(heading).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Robotics")).toBeVisible();
    expect(screen.getByRole("button", { name: "+ New" })).toBeInTheDocument();

    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Robotics")).not.toBeVisible();
    expect(JSON.parse(localStorage.getItem("cc.sidebar.collapsed"))).toEqual({ ecs: true });

    cleanup();
    render(<SidebarSection id="ecs" title="ECs"><p>Robotics</p></SidebarSection>);
    expect(screen.getByRole("button", { name: "ECs" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "ECs" }));
    expect(screen.getByText("Robotics")).toBeVisible();
    expect(JSON.parse(localStorage.getItem("cc.sidebar.collapsed"))).toEqual({});
  });
});
