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
    expect(block).toHaveTextContent("Evidence: 📎 frc-award.pdf (from chat) · 2026-09-09remove 📎 letter.docx · 2026-08-01remove");
  });

  it("removes a file after the student confirms, and leaves it when they do not", async () => {
    stubFetch([
      { method: "GET", path: "/api/ec/strength/Robotics%20Club", body: {
        ok: true,
        vector: { ecName: "Robotics Club" },
        attachments: [
          { id: "a1", filename: "frc-award.pdf", origin: "chat", uploaded_at: "2026-09-09 10:00:00", status: "ok" },
          { id: "a2", filename: "tax-return.pdf", origin: "upload", uploaded_at: "2026-08-01 09:00:00", status: "ok" },
        ],
      } },
      { method: "DELETE", path: "/api/ec/attachments/a2", body: { deleted: true, id: "a2", origin: "upload", fileRemoved: true } },
    ]);
    const onRemoved = vi.fn();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<EcEvidence ecName="Robotics Club" onRemoved={onRemoved} />);
    const button = await screen.findByRole("button", { name: "Remove tax-return.pdf" });

    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.filter(([, o]) => String(o?.method).toUpperCase() === "DELETE")).toHaveLength(0);
    expect(screen.getByTestId("ec-evidence")).toHaveTextContent("tax-return.pdf");

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove tax-return.pdf" }));
    await waitFor(() => expect(screen.getByTestId("ec-evidence")).not.toHaveTextContent("tax-return.pdf"));
    const deletes = fetch.mock.calls.filter(([, o]) => String(o?.method).toUpperCase() === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0][0])).toContain("/api/ec/attachments/a2");
    expect(screen.getByTestId("ec-evidence")).toHaveTextContent("frc-award.pdf");
    expect(onRemoved).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }));
  });

  it("says so when a removal fails and keeps the file listed", async () => {
    stubFetch([{ method: "GET", path: "/api/ec/strength/Debate", body: {
      ok: true, vector: {}, attachments: [{ id: "gone", filename: "old.pdf", origin: "upload" }],
    } }]);
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<EcEvidence ecName="Debate" />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove old.pdf" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("unexpected DELETE");
    expect(screen.getByTestId("ec-evidence")).toHaveTextContent("old.pdf");
  });

  it("says how to link a file when none is linked yet", async () => {
    stubFetch([{ method: "GET", path: "/api/ec/strength/Food%20Bank", body: { ok: true, vector: {}, attachments: [] } }]);
    render(<EcEvidence ecName="Food Bank" />);
    expect(await screen.findByTestId("ec-evidence")).toHaveTextContent("none linked yet — attach a certificate, letter or write-up in chat and name this activity in your message.");
  });

  // A failed read used to say "none linked yet", so a student could
  // re-upload a certificate already on file (ui-12).
  it("says the read failed, with a retry, instead of saying no file is linked", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      const body = calls === 1 ? { error: "Bad gateway" } : { ok: true, vector: {}, attachments: [{ id: "a1", filename: "award.pdf", origin: "upload" }] };
      return { ok: calls > 1, status: calls === 1 ? 502 : 200, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) };
    }));
    render(<EcEvidence ecName="Robotics Club" locale="ko" />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("서버에 문제가 있어 불러오지 못했습니다.");
    expect(screen.queryByText(/아직 연결된 자료가 없습니다/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByTestId("ec-evidence")).toHaveTextContent("award.pdf");
  });

  it("a network failure is an error too, and an unknown activity (404) is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    render(<EcEvidence ecName="Robotics Club" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach the server.");
    cleanup();
    stubFetch([]);
    render(<EcEvidence ecName="Unknown" />);
    expect(await screen.findByTestId("ec-evidence")).toHaveTextContent("none linked yet");
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

  it("says a file the student removed stayed removed rather than calling it linked", () => {
    expect(describeHarvest({ linked: [], unmatched: [], skipped: [{ name: "old-cert.pdf", reason: "removed" }, { name: "usaco.txt", reason: "already_stored" }], nameOnly: [] }))
      .toBe("No new files to link. 1 already linked. 1 you removed earlier stayed removed (old-cert.pdf).");
  });
});
