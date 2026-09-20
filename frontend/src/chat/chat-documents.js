// Filing the files a student attaches in chat into the sidebar's Documents
// list. The wider picker (text files, several binaries) used to file only
// the one binary promoted to the legacy attachment slot, so a resume, a
// second PDF or an essay draft never showed up under Documents. Every
// attached file is filed once the turn has passed screening, and a file
// re-sent later (same name and size) is not filed twice.

export function documentCategory(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("score")) return "Score Report";
  if (n.includes("report")) return "Report Card";
  if (n.includes("transcript")) return "Transcript";
  if (n.includes("resume") || n.includes("résumé") || /\bcv\b/.test(n)) return "Resume";
  if (n.includes("essay") || n.includes("statement")) return "Essay";
  if (n.includes("letter") || n.includes("recommend")) return "Letter";
  if (n.includes("certificate") || n.includes("award")) return "Certificate";
  return "Document";
}

export function documentType(file) {
  const mediaType = String(file?.mediaType || file?.type || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  if (mediaType.includes("pdf") || name.endsWith(".pdf")) return "pdf";
  if (mediaType.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic)$/.test(name)) return "image";
  if (mediaType.includes("word") || name.endsWith(".docx")) return "docx";
  return "text";
}

// The display name: the file's own name without any folder path, with
// control characters dropped, kept to a sane length.
export function displayFileName(name) {
  return String(name || "file").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]+/g, "").trim().slice(0, 120) || "file";
}

export function filedChatDocuments(files, now = new Date()) {
  const uploadedAt = now.toISOString();
  const out = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || !file.name) continue;
    out.push({
      name: displayFileName(file.name),
      type: documentType(file),
      category: documentCategory(file.name),
      size: Number.isFinite(file.size) ? file.size : undefined,
      uploadedAt,
      source: "chat",
    });
  }
  return out;
}

// Existing entries win; a filed document whose name matches an existing
// one (and whose size matches when both are known) is a re-send.
export function mergeDocuments(existing, filed) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  const same = (a, b) => String(a.name).toLowerCase() === String(b.name).toLowerCase()
    && (a.size == null || b.size == null || a.size === b.size);
  for (const doc of filed) {
    if (list.some((d) => same(d, doc))) continue;
    list.push(doc);
  }
  return list;
}
