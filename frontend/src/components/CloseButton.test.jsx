import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import CloseButton from "./CloseButton.jsx";

describe("CloseButton", () => {
  it("is a named button that closes on click and brightens on hover", async () => {
    const onClick = vi.fn();
    render(<CloseButton label="Close" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Close" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveTextContent("×");
    expect(button.style.color).toBe("rgb(138, 138, 154)");
    const user = userEvent.setup();
    await user.hover(button);
    expect(button.style.color).toBe("rgb(232, 230, 227)");
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
