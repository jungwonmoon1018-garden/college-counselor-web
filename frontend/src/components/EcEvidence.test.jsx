import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import EcEvidence, { ChatEvidenceSync, describeHarvest } from "./EcEvidence.jsx";

// The evidence list under an activity lists the files linked to it (a chat
// upload is marked as such), and the sync button reads past chat uploads
// into the activities they name and reports what happened.
function stubFetch(routes) {
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const path = String(url);
    const method = String(options.method || "GET").toUpperCase();
    const hit = routes.find((r) => r.method === method && path.includes(r.path));
    const body = hit ? hit.body : { error: `unexpected ${method} ${path}` };
    return {
      ok: Boolean(hit),
      status: hit ? 200 : 404,
      headers: { get: () => "application/json" },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }));
}

describe("EcEvidence", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("lists the files linked to an activity and says where each came from", async () => {
    stubFetch([{ method: "GET", path: "/api/ec/strength/Robotics%20Club", body: {
      ok: true,
      vector: { ecName: "Robotics Club" },
      attachments: [
        { id: "a1", filename: "frc-award.pdf", origin: "chat", uploaded_at: "2026-09-09 10:00:00", status: "ok" },
        { id: "a2", filename: "letter.docx", origin: "upload", uploaded_at: "2026-08-01 09:00:00", status: "ok" },
      ],
    } }]);
    render(<EcEvidence ecName="Robotics Club" />);
    const block = await screen.findByTestId("ec-evidence");
    expect(block).toHaveTextContent("Evidence: 📎 frc-award.pdf (from chat) · 2026-09-09 📎 letter.docx · 2026-08-01");
  });

  it("says how to link a file when none is linked yet", async () => {
    stubFetch([{ method: "GET", path: "/api/ec/strength/Food%20Bank", body: { ok: true, vector: {}, attachments: [] } }]);
    render(<EcEvidence ecName="Food Bank" />);
    expect(await screen.findByTestId("ec-evidence")).toHaveTextContent("none linked yet — attach a certificate, letter or write-up in chat and name this activity in your message.");
  });

  it("reads chat uploads into activities and reports what was linked, unmatched, already linked and name-only", async () => {
    const onLinked = vi.fn();
    stubFetch([{ method: "POST", path: "/api/ec/evidence/from-chat", body: {
      ok: true,
      linked: [{ name: "frc-award.pdf", ecName: "Robotics Club" }],
      unmatched: [{ name: "essay-draft.txt" }],
      skipped: [{ name: "usaco-gold.txt", reason: "already_stored" }],
      nameOnly: [{ name: "scan.pdf" }],
      recomputed: true,
    } }]);
    render(<ChatEvidenceSync onLinked={onLinked} />);
    fireEvent.click(screen.getByRole("button", { name: "Read chat uploads into activities" }));
    const note = await screen.findByRole("status");
    expect(note).toHaveTextContent("Linked 1 file: frc-award.pdf → Robotics Club.");
    expect(note).toHaveTextContent("1 named no activity (essay-draft.txt) — mention the activity in your message when you attach a file.");
    expect(note).toHaveTextContent("1 already linked.");
    expect(note).toHaveTextContent("1 older upload kept only its name (scan.pdf) — attach it again in chat to link it.");
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
  });

  it("describes an empty read plainly", () => {
    expect(describeHarvest({ linked: [], unmatched: [], skipped: [], nameOnly: [] })).toBe("No new files to link.");
  });
});
