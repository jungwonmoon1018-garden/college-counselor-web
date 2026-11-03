import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TranscriptImportCard from "./TranscriptImportCard.jsx";

// The card shows each semester of a semester-graded course (the import used
// to keep only the first) and tells rows already on the profile apart from
// rows over the course limit.
describe("TranscriptImportCard", () => {
  afterEach(cleanup);

  it("lists both semesters and says why rows were left out", async () => {
    const parsed = {
      gpa: null,
      warnings: [],
      courses: { junior: [
        { name: "AP Biology", type: "ap", grade: "A", semester: "fall" },
        { name: "AP Biology", type: "ap", grade: "B", semester: "spring" },
        { name: "물리학I", type: "regular", grade: "E", semester: "spring", gradeScale: "kr_achievement" },
      ] },
    };
    const onImport = vi.fn(() => ({ added: 1, skipped: 2, duplicates: 1, overCap: 1, unplaced: 0 }));
    render(<TranscriptImportCard file={{ name: "record.pdf" }} onParse={async () => parsed} onImport={onImport} />);
    fireEvent.click(screen.getByText(/Read the courses from this transcript/));
    expect(await screen.findByText(/\(fall\)/)).toBeTruthy();
    expect(screen.getAllByText(/\(spring\)/)).toHaveLength(2);
    // A Korean 성취도 E shows as the grade, not "in progress".
    expect(screen.getByText("E")).toBeTruthy();
    fireEvent.click(screen.getByText(/Add 3 courses to my profile/));
    expect(screen.getByText(/1 already on your profile/)).toBeTruthy();
    expect(screen.getByText(/1 left out \(over the profile's course limit\)/)).toBeTruthy();
  });
});
