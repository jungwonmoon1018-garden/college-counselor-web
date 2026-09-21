// hooks/useChatThreads.js — the chat threads: the sidebar list, the active thread,
// search, and creating, opening, persisting, renaming and deleting a thread.
// Moved out of App() on 2026-09-21 as one contiguous run, so the order of every hook and effect is unchanged.
import { useState, useCallback } from "react";
import { serverDateToISO } from "../profile/dates.js";
import { openThread as openThreadImpl, persistTurn as persistTurnImpl } from "../handlers/chat-send.js";

export function useChatThreads(ctx) {
  const {
    authedFetch, setMessages, setSyncNote, setSyncStatus,
  } = ctx;
  // ─── Chat thread history ───
  // threadList = sidebar entries (id, title, updated_at, message_count).
  // activeThreadId = which thread the open `messages` belong to.
  const [threadList, setThreadList] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [threadSearchQ, setThreadSearchQ] = useState("");
  const [threadSearchResults, setThreadSearchResults] = useState([]);
  // Inline double-click editing in the sidebar: chat-thread rename + profile
  // fields (GPA, test scores, courses). `editingField` is a key like
  // "gpa" | "test:2" | "course:0"; drafts hold the in-progress values.
  const [renamingThreadId, setRenamingThreadId] = useState(null);
  const [threadDraft, setThreadDraft] = useState("");
  // Fetch the student's threads (called after auth lands).
  const refreshThreadList = useCallback(async () => {
    try {
      const r = await authedFetch("/api/students/threads");
      if (r.ok) {
        const data = await r.json();
        // Normalize SQLite timestamps to ISO so Safari can parse them and so
        // the updated_at sort compares consistently with client-stamped ISO.
        setThreadList((data.threads || []).map(t => ({ ...t, updated_at: serverDateToISO(t.updated_at) })));
      }
    } catch (err) { console.warn("[CHAT] refreshThreadList failed:", err?.message); }
  }, [authedFetch]);

  // Create a new thread server-side and switch to it. Clears current
  // in-memory messages so the new thread starts blank.
  const newThread = useCallback(async (initialTitle, preserveMessages = false) => {
    try {
      const r = await authedFetch("/api/students/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: initialTitle }),
      });
      if (!r.ok) return null;
      const data = await r.json();
      setActiveThreadId(data.id);
      if (!preserveMessages) setMessages([]);
      refreshThreadList();
      return data.id;
    } catch { return null; }
  }, [authedFetch, refreshThreadList]);

  const openThread = useCallback((...args) => openThreadImpl({
      authedFetch, refreshThreadList, setActiveThreadId, setMessages,
    }, ...args), [authedFetch, refreshThreadList]);

  const persistTurn = useCallback((...args) => persistTurnImpl({
      authedFetch, refreshThreadList, setSyncNote, setSyncStatus, setThreadList,
    }, ...args), [authedFetch, refreshThreadList]);

  // Delete a thread (soft archive by default).
  const deleteThread = useCallback(async (threadId, hard = false) => {
    const token = window.__CC_SESSION_TOKEN__;
    if (!token) return;
    try {
      await fetch(`/api/students/threads/${threadId}${hard ? "?hard=1" : ""}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (activeThreadId === threadId) {
        setActiveThreadId(null);
        setMessages([]);
      }
      refreshThreadList();
    } catch (err) { console.warn("[CHAT] deleteThread failed:", err?.message); }
  }, [activeThreadId, refreshThreadList]);

  // Search across all threads (substring on message content).
  const searchThreads = useCallback(async (q) => {
    setThreadSearchQ(q);
    if (!q || q.length < 2) { setThreadSearchResults([]); return; }
    const token = window.__CC_SESSION_TOKEN__;
    if (!token) return;
    try {
      const r = await fetch(`/api/students/threads-search?q=${encodeURIComponent(q)}`,
        { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const data = await r.json();
        setThreadSearchResults(data.results || []);
      }
    } catch (err) { console.warn("[CHAT] search failed:", err?.message); }
  }, []);
  // ─── Inline sidebar editing ───
  // Rename a chat thread (double-click its title). Persists via PATCH; the
  // backend only accepts a non-empty title.
  const renameThreadTitle = useCallback(async (threadId, title) => {
    const t = String(title || "").trim();
    setRenamingThreadId(null);
    if (!threadId || !t) return;
    setThreadList(prev => prev.map(x => x.id === threadId ? { ...x, title: t } : x));
    try {
      await authedFetch(`/api/students/threads/${encodeURIComponent(threadId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t }),
      });
    } catch (err) { console.warn("[CHAT] rename failed:", err?.message); refreshThreadList(); }
  }, [authedFetch, refreshThreadList]);
  return {
    activeThreadId, deleteThread, newThread, openThread, persistTurn, refreshThreadList,
    renameThreadTitle, renamingThreadId, searchThreads, setRenamingThreadId, setThreadSearchQ, setThreadSearchResults,
    threadList, threadSearchQ, threadSearchResults,
  };
}
