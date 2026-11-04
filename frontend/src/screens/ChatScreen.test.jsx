import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatScreen from "./ChatScreen.jsx";

function props(overrides = {}) {
  return {
    agentStatus: { active: null, phase: "" },
    budgetStatus: null,
    cancelPendingRequest: vi.fn(),
    chatEnd: { current: null },
    chatFiles: [],
    chatFilesExpanded: false,
    chatTextareaRef: { current: null },
    clearChatFiles: vi.fn(),
    councilDecisionType: null,
    deadlineRefreshKey: 0,
    dismissTool: vi.fn(),
    fileInputRef: { current: null },
    folderInputRef: { current: null },
    handleChatFilesSelect: vi.fn(),
    handleExportData: vi.fn(),
    importParsedTranscript: vi.fn(),
    input: "",
    inputRef: { current: null },
    loading: false,
    locale: "en-US",
    messages: [],
    narrativeVersion: 0,
    openTool: vi.fn(),
    parseTranscriptText: vi.fn(),
    pendingFile: null,
    removeChatFile: vi.fn(),
    send: vi.fn(),
    setChatFilesExpanded: vi.fn(),
    setCouncilDecisionType: vi.fn(),
    setInput: vi.fn(),
    setNarrativeVersion: vi.fn(),
    setPendingFile: vi.fn(),
    setSNarrativeSaved: vi.fn(),
    setSidebarOpen: vi.fn(),
    sidebarOpen: false,
    targetSchools: [],
    user: { name: "Jiyeon" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
});
afterEach(() => { vi.unstubAllGlobals(); });

// chat-9: Cancel was hidden while the Strategy Council ran, so a stalled
// run held the composer for minutes with no way out.
describe("ChatScreen while a turn runs", () => {
  it("offers Cancel during a Strategy Council run", () => {
    const p = props({ loading: true, agentStatus: { active: "strategy_council", phase: "Strategy Council is reviewing your decision..." } });
    render(<ChatScreen {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(p.cancelPendingRequest).toHaveBeenCalledTimes(1);
  });

  it("offers it during an ordinary turn, in Korean too", () => {
    render(<ChatScreen {...props({ loading: true, locale: "ko", agentStatus: { active: "college", phase: "..." } })} />);
    expect(screen.getByRole("button", { name: "취소" })).toBeInTheDocument();
  });

  it("shows a thread notice as a note, not a reply", () => {
    render(<ChatScreen {...props({ messages: [{ role: "notice", transient: true, content: "Earlier messages are not shown." }] })} />);
    expect(screen.getByRole("note")).toHaveTextContent("Earlier messages are not shown.");
  });
});
