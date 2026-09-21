// hooks/useChatTools.js — the inline tool cards in the chat log: opening one (or
// scrolling to the one already open) and dismissing it. Moved out of App() on 2026-09-21 as one contiguous run, so the order of every hook and effect is unchanged.
import { useRef, useEffect, useCallback } from "react";

export function useChatTools(ctx) {
  const {
    messages, setMessages,
  } = ctx;
  // ─── Inline chat tools ───
  // The four student tools (narrative, candidate ranker, spike finder,
  // course plan) render INLINE in the conversation as ephemeral cards.
  // They carry role:"tool" so buildHistoryMsgs() skips them (never sent to
  // the model) and persistTurn() never stores them (no backend round-trip).
  // Switching threads clears them, which is the intended ephemeral behavior.
  const toolSeq = useRef(0);
  // The open tool cards, for openTool: a second click on a tool's button
  // used to append a second card, and each card fetched (Spike Finder's
  // fetch is a model re-rank), so three clicks meant three panels and
  // three re-ranks. An open card is brought into view instead.
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const openTool = useCallback((toolName) => {
    const existing = (messagesRef.current || []).find((m) => m?.role === "tool" && m.tool === toolName && m.id);
    if (existing) {
      setTimeout(() => { try { document.getElementById(existing.id)?.scrollIntoView?.({ behavior: "smooth", block: "start" }); } catch { /* ignore */ } }, 0);
      return;
    }
    toolSeq.current += 1;
    const id = `tool-${toolName}-${toolSeq.current}`;
    setMessages(prev => [...prev, { role: "tool", tool: toolName, id }]);
  }, []);
  const dismissTool = useCallback((id) => {
    setMessages(prev => prev.filter(m => !(m.role === "tool" && m.id === id)));
  }, []);
  return {
    dismissTool, openTool, toolSeq,
  };
}
