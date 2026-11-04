import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import SurveyScreen from "./SurveyScreen.jsx";
import { apExamsWithScores } from "../profile/ap-entry.js";
import { blankTestForm } from "../profile/test-scores.js";

// The survey's course and test steps, with App's state stood in by a small
// harness. The clock is fixed so nothing here depends on today's date.
function Harness({ step, initialTest = blankTestForm("sat"), courses = { junior: [] } }) {
  const [sCourseInput, setSCourseInput] = useState({ name: "", type: "ap", grade: "A", semester: "full_year" });
  const [sTestInput, setSTestInput] = useState(initialTest);
  const noop = () => {};
  const props = {
    // App passes the exam-score list as AP_COURSES; the course picker no
    // longer reads it.
    AP_COURSES: apExamsWithScores(),
    COURSE_GRADES: ["A", "B"],
    EXPIRY_NOTICE: "",
    RIGOR: { ap: "AP (+1.0w, College-level)" },
    STEPS: [{ title: "GPA" }, { title: "Courses" }, { title: "Tests" }],
    YEARS: ["junior"],
    addAP: noop, addCourse: noop, addEC: noop, addTest: noop,
    chip: (s, fn, l) => <button key={l} onClick={fn}>{l}</button>,
    dismissedNotice: "", expiryWarning: false,
    formatApLabel: (v) => `AP ${v}`,
    importTranscript: noop, isFreshman: false, locale: "en-US",
    nxt: noop, prv: noop,
    pill: (t) => <span key={t}>{t}</span>,
    sAPInput: { subject: "", score: "5", year: "" }, sAPScores: [],
    sClassRank: { rank: "", size: "", topPercent: "" },
    sCourseInput, setSCourseInput, sCourseYear: "junior", sCourses: courses,
    sECInput: { name: "", category: "academic", role: "", grades: [] }, sECs: [],
    sGoals: [], sGpaUw: "", sGpaW: "", sImportBusy: false, sImportNote: "",
    sMajorInterest: "", sNoGpaYet: false, sNoTestsYet: false,
    sTestCategory: "sat", sTestInput, setSTestInput, sTests: [],
    scoreHint: {},
    setDismissedNotice: noop, setSAPInput: noop, setSAPScores: noop, setSClassRank: noop,
    setSCourseYear: noop, setSCourses: noop, setSECInput: noop, setSECs: noop, setSGoals: noop,
    setSGpaUw: noop, setSGpaW: noop, setSNoGpaYet: noop, setSNoTestsYet: noop,
    setSTestCategory: noop, setSTests: noop, setStudentRecoveryCode: noop, setSurveyError: noop,
    setSurveyStep: noop, setsMajorInterest: noop,
    sl: {}, st: { title: "Step", sub: "" }, stepRequired: false, studentRecoveryCode: "",
    surveyError: "", surveyStep: step,
    tab: (a, fn, l) => <button key={l} onClick={fn}>{l}</button>,
    testLimit: null, total: 3, user: { name: "Test" }, ylbl: (y) => y,
  };
  return <SurveyScreen {...props} />;
}

describe("SurveyScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 12));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // A course is taught the year before its first exam: AP Cybersecurity and
  // AP Business with Personal Finance are taken in 2026-27, with first
  // scores in July 2027.
  it("offers this year's new AP courses in the course picker while the score list waits for July", () => {
    render(<Harness step={1} />);
    const options = within(screen.getByLabelText("AP course")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("AP Cybersecurity");
    expect(options).toContain("AP Business with Personal Finance");
    expect(apExamsWithScores()).not.toContain("Cybersecurity");
  });

  // A semester-graded course is two rows; the total counted each one.
  it("counts the two semesters of a course once", () => {
    render(<Harness step={1} courses={{ junior: [
      { name: "AP Biology", type: "ap", grade: "A", semester: "fall" },
      { name: "AP Biology", type: "ap", grade: "B", semester: "spring" },
      { name: "Chemistry", type: "regular", grade: "A", semester: "full_year" },
    ] }} />);
    expect(screen.getByText(/Total: 2 courses/).textContent).toMatch(/Total: 2 courses . 1 AP/);
  });

  it("asks for the TOEFL scale and sizes the inputs to it", () => {
    render(<Harness step={2} initialTest={blankTestForm("toefl")} />);
    const scale = screen.getByLabelText("TOEFL score scale");
    expect(within(scale).getAllByRole("option").map((o) => o.value)).toEqual(["", "band"]);
    expect(screen.getByLabelText("TOEFL total").getAttribute("max")).toBe("120");
    fireEvent.change(scale, { target: { value: "band" } });
    expect(screen.getByLabelText("TOEFL (1-6 band) total").getAttribute("max")).toBe("6");
    expect(screen.getByLabelText("TOEFL (1-6 band) Reading").getAttribute("step")).toBe("0.5");
    fireEvent.change(screen.getByLabelText("TOEFL (1-6 band) Reading"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("TOEFL (1-6 band) Listening"), { target: { value: "5.5" } });
    fireEvent.change(screen.getByLabelText("TOEFL (1-6 band) Speaking"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("TOEFL (1-6 band) Writing"), { target: { value: "5.5" } });
    expect(screen.getByLabelText("TOEFL (1-6 band) total").value).toBe("5.5");
  });

  it("fills the enhanced ACT composite from English, Math and Reading", () => {
    render(<Harness step={2} initialTest={blankTestForm("act")} />);
    fireEvent.change(screen.getByLabelText("ACT English"), { target: { value: "35" } });
    fireEvent.change(screen.getByLabelText("ACT Math"), { target: { value: "36" } });
    fireEvent.change(screen.getByLabelText("ACT Reading"), { target: { value: "34" } });
    fireEvent.change(screen.getByLabelText("ACT Science"), { target: { value: "28" } });
    expect(screen.getByLabelText("ACT total").value).toBe("35");
    expect(screen.getByText(/the ACT composite is the average of English, Math and Reading/)).toBeTruthy();
  });

  it("offers PSAT 8/9 with its own range", () => {
    render(<Harness step={2} initialTest={blankTestForm("psat")} />);
    fireEvent.change(screen.getByLabelText("PSAT score scale"), { target: { value: "8/9" } });
    expect(screen.getByLabelText("PSAT 8/9 total").getAttribute("min")).toBe("240");
    expect(screen.getByText(/Valid range for PSAT 8\/9: 240-1440/)).toBeTruthy();
  });
});
