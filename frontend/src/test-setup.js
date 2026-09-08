import "@testing-library/jest-dom/vitest";

// jsdom has no layout, so it does not implement scrollIntoView; the chat
// screen calls it on mount to keep the newest message in view.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
