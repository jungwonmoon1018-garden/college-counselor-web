// chat-send.js — the chat screen's handlers: sending a turn (attachments,
// crisis lexicon, orchestrator, persistence), choosing files, opening a
// thread and persisting a turn. App() keeps each hook and its dependency array and calls these with the
// render's bindings as `ctx`. Moved out of App.jsx on 2026-09-20.
import { rateLimiter } from "./chat-client.js";
import { sanitizeFilename, MAX_CHAT_FILES, MAX_CHAT_TOTAL_BYTES, readChatFile } from "./chat-files.js";
import { buildCalendarPreamble, buildMemoryPreamble, orchestrate, rememberExchange } from "./chat-orchestrator.js";
import { looksLikeTranscript } from "./transcript-utils.js";
import { filedChatDocuments, mergeDocuments } from "./chat-documents.js";
import { reconcileCouncilFailureMessages } from "./strategy-council.js";

// ─── SEND MESSAGE ───
export async function send(ctx) {
  const {
    abortRef, activeThreadId, authedFetch, calendarCtx, chatFiles, chatTextareaRef,
    conveneStrategyCouncil, councilDecisionType, councilTurnSequenceRef, data, formatUserFacingError, input,
    inputRef, loading, locale, messages, newThread, pendingFile,
    persistTurn, refreshBudget, refreshThreadList, setAgentStatus, setChatFiles, setChatFilesExpanded,
    setCouncilDecisionType, setData, setInput, setLoading, setMessages, setPendingFile,
    targetSchools, toolSeq,
  } = ctx;
  if ((!input.trim() && !pendingFile && chatFiles.length === 0) || loading) return;
  const councilTypeForTurn = councilDecisionType;
  if (councilTypeForTurn && (pendingFile || chatFiles.length > 0)) {
    setMessages((prev) => [...prev, {
      role: "assistant",
      content: locale === "ko"
        ? "전략 위원회 질문에는 첨부 파일을 사용할 수 없습니다. 파일을 제거하거나 일반 채팅을 사용해 주세요."
        : "Strategy Council cannot accept attachments. Remove them or use ordinary chat.",
    }]);
    return;
  }
  if (councilTypeForTurn && input.trim().length > 2000) {
    setMessages((prev) => [...prev, {
      role: "assistant",
      content: locale === "ko"
        ? "전략 위원회 질문은 2,000자 이하여야 합니다."
        : "Strategy Council questions are limited to 2,000 characters.",
    }]);
    return;
  }

  // Burst guard only (3 requests / 10s). Catches stuck-button
  // double-fires; not a per-minute cost cap.
  if (!rateLimiter.check()) {
    setMessages(prev => [...prev, { role:"assistant", content:"Three messages in 10 seconds — give it a beat. (This is just a burst guard against accidental double-clicks; there's no per-minute cap.)" }]);
    return;
  }
  if (councilTypeForTurn) setCouncilDecisionType(null);
  const councilClientTurnId = councilTypeForTurn
    ? `council-turn-${++councilTurnSequenceRef.current}`
    : null;

  // ─── Chat-file marshalling ───
  // Text files: serialize all of them into a fenced context block
  // prepended to the user message so the LLM literally sees the
  // content. Binary files: promote the FIRST one to the legacy
  // `attachment` slot (preserves the PDF/image OCR / score-report
  // fast-path); any additional binaries are skipped with a note.
  const textChatFiles = chatFiles.filter(f => f.kind === "text");
  const binaryChatFiles = chatFiles.filter(f => f.kind === "binary");
  const baseMsg = input.trim();
  let filePreface = "";
  if (textChatFiles.length > 0) {
    const lines = [
      `[Attached files — read carefully and reference in your answer; ${textChatFiles.length} text file(s)]`,
    ];
    for (const f of textChatFiles) {
      const fence = "```";
      lines.push("");
      lines.push(`═══ FILE: ${f.path} (${Math.round(f.size/1024)} KB) ═══`);
      lines.push(fence);
      lines.push(f.content);
      lines.push(fence);
    }
    lines.push("[End of attached files]");
    filePreface = lines.join("\n") + "\n\n";
  }
  if (binaryChatFiles.length > 1) {
    filePreface += `[Note: ${binaryChatFiles.length - 1} additional binary file(s) skipped — only one PDF/image attachment per turn is supported.]\n\n`;
  }
  // Promote first binary into `pendingFile` slot if the user hasn't
  // already used the legacy single-file picker.
  const promotedBinary = (!pendingFile && binaryChatFiles[0]) ? {
    name: binaryChatFiles[0].name,
    type: binaryChatFiles[0].mediaType,
    size: binaryChatFiles[0].size,
    base64: binaryChatFiles[0].base64,
    mediaType: binaryChatFiles[0].mediaType,
  } : null;

  const attachment = pendingFile || promotedBinary;
  const msg = (filePreface + baseMsg).trim() || (attachment ? `Please analyze this file: ${sanitizeFilename(attachment.name)}` : "");
  const requestData = data; // FIX P2: Do NOT mutate data with file metadata yet — wait for safety screening
  setInput("");
  setPendingFile(null);
  setChatFiles([]);
  setChatFilesExpanded(false);
  // Build the user-message attachment summary so the bubble shows
  // every file the user attached (not just the legacy single one).
  const allAttachmentsForBubble = [
    ...(attachment ? [{ name: sanitizeFilename(attachment.name) }] : []),
    ...textChatFiles.map(f => ({ name: sanitizeFilename(f.path || f.name) })),
  ];
  // The chat bubble shows the bare user question (`baseMsg`) so
  // the visible history stays readable. We also stash the FULL
  // model-facing content (with file preface) on the same message
  // as `modelContent` so the next turn's history-prepending walks
  // can replay the original context to the LLM — fixes the "model
  // forgets files attached in turn 1" bug.
  setMessages(prev => [...prev, {
    role: "user",
    content: baseMsg || (attachment ? `📎 ${sanitizeFilename(attachment.name)}` : ""),
    modelContent: msg,
    attachment: allAttachmentsForBubble.length === 1
      ? allAttachmentsForBubble[0]
      : (allAttachmentsForBubble.length > 1 ? { name: `${allAttachmentsForBubble.length} files`, list: allAttachmentsForBubble.map(a => a.name) } : null),
    ...(councilClientTurnId ? { clientTurnId: councilClientTurnId } : {}),
  }]);
  setLoading(true);
  abortRef.current = new AbortController();

  // Ensure an active thread, but do not persist raw input until moderation
  // and orchestration have accepted the turn.
  // If there's no active thread (fresh chat session), create one now.
  // The thread auto-titles itself from this first user message.
  let threadIdForTurn = activeThreadId;
  const isNewThread = !threadIdForTurn;
  if (!threadIdForTurn && !councilTypeForTurn) {
    threadIdForTurn = await newThread(undefined, true);
  }
  const attachLabel = allAttachmentsForBubble.length === 1
    ? allAttachmentsForBubble[0].name
    : allAttachmentsForBubble.length > 1 ? `${allAttachmentsForBubble.length} files` : null;
  const persistedContent = baseMsg || (attachLabel ? `Attachment: ${attachLabel}` : "");

  // FIX P2: File metadata is saved to documents ONLY after orchestrate succeeds
  // and the file passes safety screening inside orchestrate(). If the upload is
  // rejected or the request is cancelled, no document record is created.

  try {
    // Pass the prior chat history so the model sees turn-1 file
    // attachments / context when the student asks a follow-up
    // question in turn 2+. `messages` is the React state snapshot
    // BEFORE the new user turn we just appended — exactly the
    // shape buildHistoryMsgs wants.
    // Append a fresh-dated calendar/deadline reference block so the agent
    // is aware of today + cycle phase + target-school deadlines. Kept OUT of
    // the stored `modelContent` (above) so replayed history never carries a
    // stale "today"; re-injected fresh every turn.
    const calPreamble = buildCalendarPreamble(calendarCtx, targetSchools);
    const memPreamble = buildMemoryPreamble(requestData);
    // Reference data rides in an explicit sentinel-wrapped appendix so the
    // topic classifiers (frontend router AND the backend policy router)
    // can exclude it — "FAFSA opens Oct 1" inside the calendar block was
    // getting EC questions classified as regulated aid lookups.
    const contextAppendix = [memPreamble, calPreamble].filter(Boolean).join("\n\n");
    const modelMsg = contextAppendix
      ? `${msg}\n\n[Context appendix — reference data for the assistant; not part of the student's question]\n${contextAppendix}\n[End context appendix]`
      : msg;
    const result = councilTypeForTurn
      ? await conveneStrategyCouncil(baseMsg, councilTypeForTurn, abortRef.current.signal)
      : await orchestrate(modelMsg, requestData, setData, setAgentStatus, abortRef.current.signal, attachment || null, messages);
    if (!threadIdForTurn && councilTypeForTurn) {
      threadIdForTurn = await newThread(undefined, true);
    }
    setMessages(prev => [...prev, { role:"assistant", content:result.text }]);
    // An attached transcript can go straight into the profile — offer the
    // deterministic import so grades come from the document, not the model.
    if (!result.blocked && !result.uploadRejected) {
      for (const f of textChatFiles) {
        if (!looksLikeTranscript(f.content)) continue;
        toolSeq.current += 1;
        const id = `tool-transcript-${toolSeq.current}`;
        setMessages(prev => [...prev, { role: "tool", tool: "transcript_import", id, file: { name: f.name, text: f.content } }]);
      }
    }
    refreshBudget();
    if (threadIdForTurn && !result.blocked && !result.uploadRejected) {
      await persistTurn(threadIdForTurn, "user", persistedContent, attachLabel, msg);
    }
    if (threadIdForTurn && result?.text) {
      await persistTurn(threadIdForTurn, "assistant", result.text);
    }
    // ── Counselor memory capture ──
    // Cache the substantive part of this exchange in the encrypted vault,
    // keyed by topic so the newest discussion replaces the previous one.
    // Deterministic quick replies (short) and backend rules answers
    // (threeLane) are cheap to recompute and skipped.
    if (result?.text && !result.blocked && !result.uploadRejected && !result.threeLane && result.text.length >= 200) {
      const memoryKey = councilTypeForTurn ? `council:${councilTypeForTurn}` : (result.routeKey || "general");
      rememberExchange(setData, memoryKey, {
        threadId: threadIdForTurn,
        question: baseMsg,
        answer: result.text,
      });
    }
    // Auto-name a brand-new conversation from its first message (LLM, small
    // tier, crisis-safe server-side). Best-effort; the first-line title stays
    // if it fails. Refresh the sidebar so the generated name shows.
    if (
      isNewThread &&
      threadIdForTurn &&
      result?.text &&
      (result.crisisSafe || !result.blocked)
    ) {
      try {
        const fixedTitle = result.threadTitle || (result.crisisSafe ? "Support resources" : null);
        const response = fixedTitle
          ? await authedFetch(`/api/students/threads/${threadIdForTurn}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: fixedTitle }),
          })
          : await authedFetch(`/api/students/threads/${threadIdForTurn}/autoname`, {
            method: "POST",
          });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (err) {
        console.warn("[CHAT] auto-name failed:", err?.message);
      }
      await refreshThreadList();
    }

    // Every file the student attached this turn is filed under Documents in
    // the sidebar once the turn passed screening (not when rejected or
    // cancelled). The wider picker used to file only the one binary promoted
    // to the legacy slot, so text files and second attachments never
    // appeared there; a re-sent file (same name and size) is not filed twice.
    if (!result.blocked && !result.uploadRejected) {
      const filed = filedChatDocuments([...(pendingFile ? [pendingFile] : []), ...textChatFiles, ...binaryChatFiles]);
      if (filed.length) setData(prev => ({ ...prev, documents: mergeDocuments(prev.documents, filed) }));
    }
  } catch (err) {
    // FIX P2: On cancel/error, no file metadata is saved
    const text = err.name === "AbortError"
      ? "Cancelled. You can send a new question whenever you're ready."
      : err.blocked && err.message
        ? err.message
        : formatUserFacingError(err);
    if (councilTypeForTurn) {
      setInput(baseMsg);
      setMessages((prev) => reconcileCouncilFailureMessages(prev, councilClientTurnId, text));
    } else {
      setMessages(prev => [...prev, { role:"assistant", content: text }]);
      if (threadIdForTurn) await persistTurn(threadIdForTurn, "assistant", text);
    }
  }
  setLoading(false);
  setAgentStatus({ active:null, phase:"" });
  setTimeout(() => (chatTextareaRef.current||inputRef.current)?.focus(), 100);
}

// ─── MULTI-FILE / FOLDER CHAT ATTACHMENTS ───
// Reads each selected file (or every file under a chosen directory)
// through readChatFile, enforces per-file + total-bytes caps, and
// appends to chatFiles. Both file-picker and folder-picker funnel
// through here so the upstream logic stays the same.
export async function handleChatFilesSelect(ctx, e) {
  const {
    chatFiles, setChatFiles, setMessages,
  } = ctx;
  const files = Array.from(e.target.files || []);
  e.target.value = ""; // reset for re-pick of same path
  if (!files.length) return;

  if (chatFiles.length >= MAX_CHAT_FILES) {
    setMessages(prev => [...prev, { role: "assistant", content: `⚠️ Already at ${MAX_CHAT_FILES} attached files. Remove some first.` }]);
    return;
  }

  // Read sequentially so partial failures still produce useful state.
  const reads = [];
  const errors = []; // { name, error } — surfaced to UI so silent
                    // skips (Word extract failed, 401, etc.) aren't
                    // invisible to the student.
  // Same file picked twice (double-clicked picker, re-picked folder)
  // used to produce two identical chips and double the model context.
  const seen = new Set(chatFiles.map(f => `${f.path || f.name}|${f.size || 0}`));
  let totalBytes = chatFiles.reduce((n, f) => n + (f.size || 0), 0);
  let skippedSize = 0;
  let skippedCap = 0;
  let skippedDup = 0;
  for (const f of files) {
    const dupKey = `${(f.webkitRelativePath || "").replace(/\\/g, "/") || f.name}|${f.size || 0}`;
    if (seen.has(dupKey)) { skippedDup++; continue; }
    if (reads.length + chatFiles.length >= MAX_CHAT_FILES) { skippedCap++; continue; }
    if (totalBytes + (f.size || 0) > MAX_CHAT_TOTAL_BYTES) { skippedSize++; continue; }
    const r = await readChatFile(f, f.webkitRelativePath || "");
    if (r.kind === "error") {
      errors.push({ name: r.name || f.name, error: r.error });
      continue;
    }
    seen.add(dupKey);
    reads.push(r);
    totalBytes += (f.size || 0);
  }
  if (reads.length) setChatFiles(prev => [...prev, ...reads]);
  // Surface failures + caps in the chat as an assistant-style note
  // so the student sees WHY a file didn't appear in the chip list.
  if (errors.length || skippedSize || skippedCap || skippedDup) {
    const lines = [];
    if (errors.length) {
      lines.push(`⚠️ ${errors.length} file(s) couldn't be read:`);
      for (const e of errors.slice(0, 6)) lines.push(`  • ${e.name}: ${e.error}`);
      if (errors.length > 6) lines.push(`  • …+${errors.length - 6} more`);
    }
    if (skippedDup) lines.push(`ℹ️ ${skippedDup} duplicate file(s) skipped — already attached.`);
    if (skippedSize) lines.push(`⚠️ ${skippedSize} file(s) skipped — would exceed the ${Math.round(MAX_CHAT_TOTAL_BYTES/1024)} KB per-turn cap.`);
    if (skippedCap) lines.push(`⚠️ ${skippedCap} file(s) skipped — already at the ${MAX_CHAT_FILES}-file limit.`);
    const summary = lines.join("\n");
    console.warn("[chat-files]", summary);
    setMessages(prev => [...prev, { role: "assistant", content: summary }]);
  }
}

// Switch to a thread — pulls its messages from the server.
export async function openThread(ctx, threadId) {
  const {
    authedFetch, refreshThreadList, setActiveThreadId, setMessages,
  } = ctx;
  if (!threadId) return;
  try {
    const r = await authedFetch(`/api/students/threads/${threadId}`);
    if (!r.ok) return;
    const data = await r.json();
    setActiveThreadId(threadId);
    setMessages((data.messages || []).map(m => ({
      role: m.role,
      content: m.content,
      // Restore the model-facing copy (file-attachment context) so
      // follow-up turns in a reopened thread still see uploaded files.
      ...(m.model_content ? { modelContent: m.model_content } : {}),
      attachment: m.attachment_name ? { name: m.attachment_name } : null,
    })));
    // Lazy auto-name: conversations that predate the auto-naming feature
    // (or whose first naming attempt failed) still carry the placeholder
    // title or the raw first-line truncation. Rename them the first time
    // they're opened. Fire-and-forget — the server is crisis-safe and
    // skips silently when no model key is configured. User-set custom
    // titles are untouched because they never equal the derived fallback.
    const title = data.thread?.title || "";
    const firstUser = (data.messages || []).find(m => m.role === "user");
    const derived = String(firstUser?.content || "").split(/\r?\n/)[0].trim().slice(0, 60);
    if (firstUser && title !== "Support resources" && (title === "New conversation" || title === derived)) {
      authedFetch(`/api/students/threads/${threadId}/autoname`, { method: "POST" })
        .then(res => { if (res.ok) refreshThreadList(); })
        .catch(() => {});
    }
  } catch (err) { console.warn("[CHAT] openThread failed:", err?.message); }
}

// Append a turn to the active thread (no-op if no thread).
// Called from `send()` after each user + assistant message.
export async function persistTurn(ctx, threadId, role, content, attachmentName = null, modelContent = null) {
  const {
    authedFetch, refreshThreadList, setSyncNote, setSyncStatus, setThreadList,
  } = ctx;
  if (!threadId) return;
  try {
    const response = await authedFetch(`/api/students/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // modelContent = the model-facing copy (file prefaces included) so a
      // reopened thread replays attachments instead of forgetting them.
      body: JSON.stringify({ role, content, attachmentName, ...(modelContent && modelContent !== content ? { modelContent } : {}) }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // Bump the local list so updated_at reorders the sidebar
    setThreadList(prev => {
      const idx = prev.findIndex(t => t.id === threadId);
      if (idx < 0) { refreshThreadList(); return prev; }
      const next = [...prev];
      next[idx] = { ...next[idx], updated_at: new Date().toISOString(), message_count: (next[idx].message_count || 0) + 1 };
      next.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
      return next;
    });
  } catch (err) {
    console.warn("[CHAT] persistTurn failed:", err?.message);
    // Silent failure here is invisible data loss: the turn shows on screen
    // but vanishes on the next reload. Surface it in the session toast.
    // (setSyncStatus/setSyncNote are stable setState fns declared below —
    // safe to reference from this closure, deliberately not in the deps.)
    setSyncStatus("failed");
    setSyncNote("A message couldn't be saved to chat history — it may be missing after a reload.");
  }
}
