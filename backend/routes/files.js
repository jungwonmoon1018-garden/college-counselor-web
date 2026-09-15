// routes/files.js — the /api/files routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (CHAT_EXTRACT_MAX_BYTES, requireStudentAuth, studentLimiter).
import { ExtractionError, SUPPORTED_MIME_TYPES, extractPdfOCR, extractText, isSupportedMime } from "../file-extractors.js";

export function registerFilesRoutes(app, deps) {
  // 6 MB ceiling
  app.post("/api/files/extract-text", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const { base64, mimeType, filename } = req.body || {};
      if (typeof base64 !== "string" || !base64) {
        return res.status(400).json({ error: "base64 required" });
      }
      // Defense-in-depth size check (base64 length × 0.75 ≈ raw bytes).
      if (base64.length * 0.75 > deps.CHAT_EXTRACT_MAX_BYTES) {
        return res.status(413).json({ error: `File exceeds ${deps.CHAT_EXTRACT_MAX_BYTES} bytes` });
      }
      // Resolve effective mime from name when caller didn't supply one
      // (browser sometimes leaves File.type empty for .docx).
      let mime = String(mimeType || "").toLowerCase();
      if (!mime || !isSupportedMime(mime)) {
        const ext = String(filename || "").split(".").pop()?.toLowerCase() || "";
        if (ext === "docx") mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        else if (ext === "pdf") mime = "application/pdf";
        else if (ext === "txt" || ext === "md") mime = "text/plain";
      }
      if (!isSupportedMime(mime)) {
        return res.status(415).json({
          error: `Unsupported mime type: ${mime || "(unknown)"}`,
          supported: Object.keys(SUPPORTED_MIME_TYPES),
        });
      }
      let buf;
      try { buf = Buffer.from(base64, "base64"); }
      catch { return res.status(400).json({ error: "Invalid base64" }); }
      if (buf.length > deps.CHAT_EXTRACT_MAX_BYTES) {
        return res.status(413).json({ error: `Decoded file exceeds ${deps.CHAT_EXTRACT_MAX_BYTES} bytes` });
      }
      try {
        let result = await extractText(buf, mime);
        let ocr = false;
        // Scanned PDFs have no text layer — pdf-parse returns almost nothing.
        // Fall back to per-page OCR (bounded, like the transcript importer)
        // so a photographed transcript is readable instead of "truncated".
        if (result?.kind === "pdf" && String(result.text || "").trim().length < 40) {
          try {
            result = { ...await extractPdfOCR(buf, { maxPages: 6, scale: 1.5, timeoutMs: 20_000 }), kind: "pdf" };
            ocr = true;
          } catch (ocrErr) {
            console.warn("[FILE-EXTRACT] OCR fallback failed:", ocrErr?.code || "", ocrErr?.message);
          }
        }
        const text = String(result?.text || "");
        // Truncate so a single Word doc can't blow past the LLM
        // context budget. 60k chars ≈ 15k tokens — plenty for an
        // essay or resume.
        const MAX_CHARS = 60_000;
        const truncated = text.length > MAX_CHARS;
        return res.json({
          text: truncated ? text.slice(0, MAX_CHARS) : text,
          truncated,
          ocr,
          warning: result?.warning || null,
          bytes: buf.length,
          mime,
        });
      } catch (e) {
        if (!(e instanceof ExtractionError)) console.error("[FILE-EXTRACT] parser error:", e?.message || e);
        const status = e instanceof ExtractionError && e.code === "archive_limits_exceeded"
          ? 413
          : (e instanceof ExtractionError && e.code === "content_type_mismatch" ? 415 : 422);
        return res.status(status).json({
          error: status === 413 ? "Uploaded archive exceeds safe processing limits." : "Uploaded file could not be safely processed.",
          code: e?.code || "extraction_failed",
        });
      }
    } catch (err) {
      console.error("[FILE-EXTRACT] error:", err.message);
      return res.status(500).json({ error: "Extraction endpoint failed" });
    }
  });
}
