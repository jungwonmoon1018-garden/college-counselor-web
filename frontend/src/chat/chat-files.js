// chat-files.js — what a student may attach (types, counts, sizes) and how an
// attachment is read before it is sent. Moved out of App.jsx on 2026-09-20.
// FIX 2a: Sanitize filenames to prevent prompt injection
export function sanitizeFilename(name) {
  return (name || "file").replace(/[^a-zA-Z0-9\s._-]/g, "").slice(0, 50) || "uploaded_file";
}

const SUPPORTED_SCHOOL_FILE_TYPES = ["application/pdf","image/png","image/jpeg","image/webp"];

export const MAX_SCHOOL_FILE_SIZE_BYTES = 4 * 1024 * 1024;

// Chat accepts school documents only. Every format goes through the local
// extraction endpoint before any extracted text can enter an AI request.
const CHAT_DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "txt", "md", "png", "jpg", "jpeg", "webp"]);

const CHAT_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

export const MAX_CHAT_FILES = 5;

const MAX_CHAT_FILE_BYTES = 4 * 1024 * 1024;

export const MAX_CHAT_TOTAL_BYTES = 4 * 1024 * 1024;   // 4 MB total per turn

function chatFileExt(name) {
  return String(name || "").split(".").pop()?.toLowerCase() || "";
}

function isSupportedChatDocument(file) {
  if (!file) return false;
  return CHAT_DOCUMENT_EXTENSIONS.has(chatFileExt(file.name))
    && (!file.type || CHAT_DOCUMENT_MIME_TYPES.has(String(file.type).toLowerCase()));
}

export async function readChatFile(file, relPath = "") {
  const name = file?.name || "file";
  // Folder uploads carry webkitRelativePath ("essays/draft2.docx") — keep it
  // so two same-named files from different subfolders stay distinguishable.
  const path = String(relPath || "").replace(/\\/g, "/") || name;
  try {
    if (file.size > MAX_CHAT_FILE_BYTES) {
      return { kind: "error", name, error: `Too large (${Math.round(file.size/1024)} KB, max ${Math.round(MAX_CHAT_FILE_BYTES/1024)} KB)` };
    }
    if (!isSupportedChatDocument(file)) {
      return { kind: "error", name, error: "Unsupported file type. Use PDF, DOCX, TXT, MD, PNG, JPEG, or WebP school documents." };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const headers = { "Content-Type": "application/json" };
    if (window.__CC_SESSION_TOKEN__) headers.Authorization = `Bearer ${window.__CC_SESSION_TOKEN__}`;
    const response = await fetch("/api/files/extract-text", {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({ base64: btoa(binary), mimeType: file.type || "", filename: name }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { kind: "error", name, error: body.error || `Extraction failed (HTTP ${response.status})` };
    const content = String(body.text || "").trim();
    if (!content) return { kind: "error", name, error: "No readable text was found in this document." };
    return {
      kind: "text",
      name,
      path,
      size: file.size,
      content: content + (body.truncated ? "\n[Document text was truncated by the local extractor.]" : ""),
      extractedFrom: chatFileExt(name),
    };
  } catch (err) {
    return { kind: "error", name, error: err?.message || "Document extraction failed" };
  }
}

// SQLite's datetime('now') arrives as "YYYY-MM-DD HH:MM:SS" (UTC, no timezone
// marker). Safari's Date parser rejects the space-separated form, which made
// every sidebar thread row show "Invalid Date" on iOS/macOS. Normalize to ISO.
export function resolveUploadMimeType(file) {
  const direct = String(file?.type || "").toLowerCase();
  if (SUPPORTED_SCHOOL_FILE_TYPES.includes(direct)) return direct;
  const ext = String(file?.name || "").split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return direct;
}

export function getSchoolFileValidationError(file) {
  if (!file) return "No file selected.";
  if (file.size > MAX_SCHOOL_FILE_SIZE_BYTES) return "File too large. Maximum 4MB.";
  const mimeType = resolveUploadMimeType(file);
  if (!SUPPORTED_SCHOOL_FILE_TYPES.includes(mimeType)) {
    return "Only PDF and image files (PNG, JPG, WebP) are supported.";
  }
  return "";
}

function getDocumentTypeFromMimeType(mimeType) {
  return mimeType === "application/pdf" ? "pdf" : "image";
}
