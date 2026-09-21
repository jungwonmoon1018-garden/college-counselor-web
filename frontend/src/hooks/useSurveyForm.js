// hooks/useSurveyForm.js — the onboarding survey's state: the step, GPA and class
// rank, courses by year, tests, AP scores, activities, goals. Moved out of App() on 2026-09-21 as one contiguous run, so the order of every hook and effect is unchanged.
import { useState } from "react";
import { blankTestForm } from "../profile/test-scores.js";

export function useSurveyForm() {
  // Survey state
  const [surveyStep, setSurveyStep] = useState(0); // 0=GPA, 1=courses, 2=tests, 3=ECs, 4=goals, 5=parent
  const [surveyError, setSurveyError] = useState("");
  // Step 0: GPA
  const [sGpaUw, setSGpaUw] = useState("");
  const [sGpaW, setSGpaW] = useState("");
  const [sNoGpaYet, setSNoGpaYet] = useState(false);
  // Class rank: a rank in a class of a known size, or the top share.
  const [sClassRank, setSClassRank] = useState({ rank:"", size:"", topPercent:"" });
  // Courses organized by school year
  const [sCourseYear, setSCourseYear] = useState("freshman"); // which year tab is active
  const [sCourses, setSCourses] = useState({ freshman:[], sophomore:[], junior:[], senior:[] });
  const [sCourseInput, setSCourseInput] = useState({ name:"", type:"regular", grade:"A", semester:"full_year" });
  // Transcript import (PDF / image / DOCX → parsed course list for review)
  const [sImportBusy, setSImportBusy] = useState(false);
  const [sImportNote, setSImportNote] = useState("");
  // Tests — expanded categories
  const [sTests, setSTests] = useState([]);
  const [sTestCategory, setSTestCategory] = useState("sat"); // which test type tab
  const [sTestInput, setSTestInput] = useState(() => blankTestForm("sat"));
  const [sNoTestsYet, setSNoTestsYet] = useState(false);
  // AP exam scores (separate from test scores for clarity)
  const [sAPScores, setSAPScores] = useState([]); // [{subject,score,year}]
  const [sAPInput, setSAPInput] = useState({ subject:"", score:"5", year:"2025" });
  // ECs
  const [sECs, setSECs] = useState([]);
  // The default category must be a value the dropdown actually offers. It
  // used to be the legacy "club", which the select could not display (so it
  // showed the first option, "Academic") but which saved through the
  // migration shim as "Other Club/Activity".
  const [sECInput, setSECInput] = useState({
    name: "",
    category: "academic",
    role: "",
    hoursPerWeek: "",
    weeksPerYear: "",
    description: "",
    grades: [],            // ["freshman","sophomore","junior","senior"] — Common App checkboxes
    timing: "school_year", // "school_year" | "school_break" | "both"
  });
  // Goals
  const [sGoals, setSGoals] = useState([]);
  const [sMajorInterest, setsMajorInterest] = useState("");
  return {
    sAPInput, sAPScores, sClassRank, sCourseInput, sCourseYear, sCourses,
    sECInput, sECs, sGoals, sGpaUw, sGpaW, sImportBusy,
    sImportNote, sMajorInterest, sNoGpaYet, sNoTestsYet, sTestCategory, sTestInput,
    sTests, setSAPInput, setSAPScores, setSClassRank, setSCourseInput, setSCourseYear,
    setSCourses, setSECInput, setSECs, setSGoals, setSGpaUw, setSGpaW,
    setSImportBusy, setSImportNote, setSNoGpaYet, setSNoTestsYet, setSTestCategory, setSTestInput,
    setSTests, setSurveyError, setSurveyStep, setsMajorInterest, surveyError, surveyStep,
  };
}
