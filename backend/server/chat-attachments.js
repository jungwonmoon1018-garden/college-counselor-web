// server/chat-attachments.js — attachments on a chat turn: a block to text,
// blocks inlined into the message, the evidence queue and the strength
// recompute it triggers. Moved out of server.js on 2026-09-20.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (CHAT_EXTRACT_MAX_BYTES, ragStmts).
import { extractPdfOCR, extractText } from "../shared/file-extractors.js";
import { assembleProfileForGeneration } from "./verified-data.js";
import { harvestEvidence } from "../activities/ec-chat-evidence.js";
import * as chatHistory from "../chat/chat-history.js";
import { getActiveNarrative } from "../activities/narrative-store.js";
import { buildDefaultLLMClient, recomputeStudentECStrengthVectors } from "../activities/ec-strength-vectorizer.js";
import { resolvePrestigeAdapter, safeParseJSON } from "./model-calls.js";

let deps;
export function bindChatAttachments(serverDeps) { deps = serverDeps; }

// ═══════════════════════════════════════════════════════════
// POST /api/chat — the counseling chat path (fixed administrator OpenRouter)
// ═══════════════════════════════════════════════════════════
// Flow: Input screening → Policy router → Rules engine (T0) →
//       [Model only if needed] → Output screening → 3-lane answer
//
// Paid model calls use the fixed administrator-configured OpenRouter boundary.
// The frontend tier is mapped by server policy to an allowlisted model; caller
// model overrides and tool definitions are not allowed or forwarded.

export function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

// Replace base64 document/image blocks with their extracted text so a
// text-only provider sees the whole file. Scanned PDFs fall back to bounded
// OCR. Errors become a visible note rather than a silent omission.
// `collector`, when given, receives { index, mime, text } for every block
// whose text was read, so the turn can also file the document as EC
// evidence (see queueChatEvidence) without extracting it twice.
export async function attachmentBlockToText(block, collector = null, index = -1) {
  const kind = block.type === "image" ? "image" : "document";
  const mime = String(block.source?.media_type || "").toLowerCase();
  try {
    if (String(block.source?.data || "").length * 0.75 > deps.CHAT_EXTRACT_MAX_BYTES) {
      return `[Attached ${kind} was too large to read (over ${Math.round(deps.CHAT_EXTRACT_MAX_BYTES / 1024)} KB).]`;
    }
    const buf = Buffer.from(block.source.data, "base64");
    let extraction = await extractText(buf, mime);
    if (extraction?.kind === "pdf" && String(extraction.text || "").trim().length < 40) {
      try { extraction = { ...await extractPdfOCR(buf, { maxPages: 6, scale: 1.5, timeoutMs: 20_000 }), kind: "pdf" }; } catch { /* keep the sparse text */ }
    }
    const text = String(extraction?.text || "").trim();
    if (!text) return `[Attached ${kind}: no readable text was found — if it is a scan or photo, a clearer copy may work.]`;
    if (Array.isArray(collector)) collector.push({ index, mime, text });
    const cut = /truncated/.test(String(extraction?.warning || ""));
    return `[Attached ${kind} — full extracted text, ${text.length} characters${cut ? "; the source was longer than the extraction limit, so the end is not included" : ""}]\n${text}\n[End of attached ${kind}]`;
  } catch (err) {
    return `[Attached ${kind} could not be read: ${String(err?.code || err?.message || "extraction failed").slice(0, 80)}]`;
  }
}

export async function inlineAttachmentBlocks(messages, collector = null) {
  let inlined = 0;
  const list = Array.isArray(messages) ? messages : [];
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    if (!Array.isArray(message?.content)) continue;
    const next = [];
    for (const block of message.content) {
      if ((block?.type === "document" || block?.type === "image") && block.source?.type === "base64" && typeof block.source.data === "string") {
        next.push({ type: "text", text: await attachmentBlockToText(block, collector, index) });
        inlined += 1;
      } else {
        next.push(block);
      }
    }
    message.content = next;
  }
  return inlined;
}

// A file attached in chat is EC evidence too. Read the files of one turn
// into the activity each concerns (a deterministic name match; a file that
// names no activity stays unlinked) and, when anything was linked, refresh
// the strength vectors so the evidence shows at once. Fire-and-forget: a
// chat turn never waits for it, and a failure is logged, not surfaced.
export function queueChatEvidence(studentId, files, messageText, { threadId = null, messageId = null, source = "chat" } = {}) {
  if (!studentId || !Array.isArray(files) || files.length === 0) return;
  setImmediate(async () => {
    try {
      const profile = assembleProfileForGeneration(studentId);
      const result = harvestEvidence(deps.ragStmts.strength, studentId, files, {
        activities: profile?.activities || [],
        messageText,
        seal: chatHistory.sealText,
        threadId,
        messageId,
      });
      if (result.linked.length) {
        console.log(`[EC evidence] ${source}: linked ${result.linked.map((l) => `${l.name} → ${l.ecName}`).join(", ")}`);
        await recomputeStrengthForStudent(studentId);
      }
    } catch (err) {
      console.warn("[EC evidence] chat harvest failed:", err?.message);
    }
  });
}

// One strength recompute for a student from the stored snapshot, narrative
// and attachments — what the sync does, callable after evidence lands.
export async function recomputeStrengthForStudent(studentId) {
  const snap = deps.ragStmts.getLatestSnapshot.get(studentId);
  if (!snap) return null;
  const active = getActiveNarrative(deps.ragStmts.narrative, studentId);
  return recomputeStudentECStrengthVectors(deps.ragStmts.strength, studentId, {
    activities: safeParseJSON(snap.activities_json, []),
    narrative: active?.narrativeText || null,
    narrativeThemes: active?.themes || [],
    narrativeHash: active?.hash || null,
    narrativeId: active?.id || null,
    majorInterest: snap.major_interest || null,
    llmClient: buildDefaultLLMClient(deps.ragStmts.narrativeFitCache),
    prestigeAdapter: resolvePrestigeAdapter(studentId),
    ragStmts: deps.ragStmts,
  });
}
