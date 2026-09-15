// Helpers and styles both App.jsx and Sidebar.jsx use, moved out of
// App.jsx on 2026-09-16 when the sidebar became its own module.

// ═══════════════════════════════════════════════════════════
// GRADING SCALE — matches the standard A+/A/A-…F table
// Used by the grade dropdown, pill display, and PDF parser.
// ═══════════════════════════════════════════════════════════
export const GRADE_SCALE = [
  { grade:"A+", label:"A+ (97–100%)", min:97, max:100 },
  { grade:"A",  label:"A (93–96%)",   min:93, max:96  },
  { grade:"A-", label:"A− (90–92%)",  min:90, max:92  },
  { grade:"B+", label:"B+ (87–89%)",  min:87, max:89  },
  { grade:"B",  label:"B (83–86%)",   min:83, max:86  },
  { grade:"B-", label:"B− (80–82%)",  min:80, max:82  },
  { grade:"C+", label:"C+ (77–79%)",  min:77, max:79  },
  { grade:"C",  label:"C (73–76%)",   min:73, max:76  },
  { grade:"C-", label:"C− (70–72%)",  min:70, max:72  },
  { grade:"D+", label:"D+ (67–69%)",  min:67, max:69  },
  { grade:"D",  label:"D (63–66%)",   min:63, max:66  },
  { grade:"D-", label:"D− (60–62%)",  min:60, max:62  },
  { grade:"F",  label:"F (0–59%)",    min:0,  max:59  },
];

// ═══════════════════════════════════════════════════════════
// MAIN APP — CREATE ACCOUNT → SURVEY → LOGIN → CHAT
// ═══════════════════════════════════════════════════════════
// ─── Dashboard editors ───
// Inline forms for the profile sidebar: every standardized test (total,
// sections, date, subject), every AP exam score, and the class rank can be
// edited, removed or added without re-running the survey. Forms hold
// strings; the profile stores the numeric entries the backend validates.
export const AP_EXAM_LIST = [
  "African American Studies","Art History","Biology","Calculus AB","Calculus BC",
  "Chemistry","Chinese Language","Comparative Government","Computer Science A",
  "Computer Science Principles","English Language","English Literature",
  "Environmental Science","European History","French Language","German Language",
  "Human Geography","Italian Language","Japanese Language","Latin",
  "Macroeconomics","Microeconomics","Music Theory","Physics 1","Physics 2",
  "Physics C: E&M","Physics C: Mechanics","Precalculus","Psychology",
  "Research","Seminar","Spanish Language","Spanish Literature",
  "Statistics","Studio Art: 2-D","Studio Art: 3-D","Studio Art: Drawing",
  "US Government","US History","World History"
];
