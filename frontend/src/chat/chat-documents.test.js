import { describe, expect, it } from "vitest";
import { documentCategory, documentType, filedChatDocuments, mergeDocuments } from "./chat-documents.js";

describe("chat documents", () => {
  it("files every attached file, text or binary, with a type and a category", () => {
    const now = new Date("2026-09-16T02:00:00Z");
    const filed = filedChatDocuments([
      { kind: "text", name: "activities/resume.md", path: "activities/resume.md", size: 2048, mediaType: "text/markdown", content: "…" },
      { kind: "binary", name: "Score report SAT.pdf", size: 90000, mediaType: "application/pdf" },
      { kind: "binary", name: "award.PNG", size: 4000, mediaType: "image/png" },
      { name: "Common App essay.docx", size: 12000, mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      null,
    ], now);
    expect(filed).toEqual([
      { name: "resume.md", type: "text", category: "Resume", size: 2048, uploadedAt: "2026-09-16T02:00:00.000Z", source: "chat" },
      { name: "Score report SAT.pdf", type: "pdf", category: "Score Report", size: 90000, uploadedAt: "2026-09-16T02:00:00.000Z", source: "chat" },
      { name: "award.PNG", type: "image", category: "Certificate", size: 4000, uploadedAt: "2026-09-16T02:00:00.000Z", source: "chat" },
      { name: "Common App essay.docx", type: "docx", category: "Essay", size: 12000, uploadedAt: "2026-09-16T02:00:00.000Z", source: "chat" },
    ]);
    expect(documentType({ name: "transcript.pdf" })).toBe("pdf");
    expect(documentCategory("Fall 2025 transcript.pdf")).toBe("Transcript");
    expect(documentCategory("notes.txt")).toBe("Document");
  });

  it("does not file a re-sent file twice, and keeps the earlier entries", () => {
    const existing = [
      { name: "transcript.pdf", type: "pdf", category: "Transcript", uploadedAt: "2026-09-01T00:00:00.000Z", source: "survey_transcript" },
      { name: "resume.md", type: "text", category: "Resume", size: 2048, uploadedAt: "2026-09-10T00:00:00.000Z", source: "chat" },
    ];
    const filed = filedChatDocuments([
      { name: "Transcript.pdf", size: 50000, mediaType: "application/pdf" },
      { name: "resume.md", size: 2048, mediaType: "text/markdown" },
      { name: "resume.md", size: 3000, mediaType: "text/markdown" },
    ]);
    const merged = mergeDocuments(existing, filed);
    expect(merged.map((d) => `${d.name}:${d.size ?? "-"}`)).toEqual(["transcript.pdf:-", "resume.md:2048", "resume.md:3000"]);
    expect(mergeDocuments(undefined, filed.slice(0, 1))).toHaveLength(1);
  });
});
