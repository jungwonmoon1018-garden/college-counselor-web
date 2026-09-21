// hooks/useChatFiles.js — what the student has attached to the next message: the
// legacy single file, the list of chat files, and choosing, removing and
// clearing them. Moved out of App() on 2026-09-21 as one contiguous run, so the order of every hook and effect is unchanged.
import { useState, useCallback } from "react";
import { getSchoolFileValidationError, resolveUploadMimeType } from "../chat/chat-files.js";
import { handleChatFilesSelect as handleChatFilesSelectImpl } from "../handlers/chat-send.js";

export function useChatFiles(ctx) {
  const {
    setMessages,
  } = ctx;
  const [pendingFile, setPendingFile] = useState(null); // legacy single-file (PDF/image OCR survey path)
  // Multi-file / folder chat attachments. Each entry is the parsed
  // shape returned by readChatFile: { kind, name, path, size, ... }.
  // Read once on selection, kept in memory until the user sends the
  // next turn or removes them.
  const [chatFiles, setChatFiles] = useState([]); // Array<ChatFile>
  // Whether the collapsed folder-chip's expanded list is showing.
  // Auto-collapses again on send via setChatFiles([]) clearing state.
  const [chatFilesExpanded, setChatFilesExpanded] = useState(false);
  // ─── FILE UPLOAD HANDLER ───
  const handleFileSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const validationError = getSchoolFileValidationError(file);
    if (validationError) { alert(validationError); return; }
    const mimeType = resolveUploadMimeType(file);
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      setPendingFile({ name: file.name, type: mimeType, size: file.size, base64, mediaType: mimeType });
    };
    reader.readAsDataURL(file);
    e.target.value = ""; // reset so same file can be selected again
  }, []);

  const handleChatFilesSelect = useCallback((...args) => handleChatFilesSelectImpl({
      chatFiles, setChatFiles, setMessages,
    }, ...args), [chatFiles]);

  const removeChatFile = useCallback((idx) => {
    setChatFiles(prev => prev.filter((_, i) => i !== idx));
  }, []);
  const clearChatFiles = useCallback(() => setChatFiles([]), []);
  return {
    chatFiles, chatFilesExpanded, clearChatFiles, handleChatFilesSelect, pendingFile, removeChatFile,
    setChatFiles, setChatFilesExpanded, setPendingFile,
  };
}
