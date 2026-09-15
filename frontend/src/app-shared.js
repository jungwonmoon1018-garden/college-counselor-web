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

// ═══════════════════════════════════════════════════════════
// SHARED STYLES
// ═══════════════════════════════════════════════════════════
export const FONT = "'Segoe UI',system-ui,sans-serif";

export const BG = "#0a0e17";

export const inputStyle = { width:"100%",padding:"12px 14px",minHeight:44,borderRadius:8,border:"1px solid rgba(255,255,255,0.22)",background:"rgba(255,255,255,0.04)",color:"#f1f5f9",fontSize:15,boxSizing:"border-box",transition:"border-color 0.2s" };

export const labelStyle = { fontSize:12,fontWeight:600,color:"#b4bfcc",display:"block",marginBottom:6,letterSpacing:0 };

export const GLOBAL_CSS = `html,body,#root{height:100%;margin:0} body{min-width:320px}
@keyframes pulse2{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes spin{to{transform:rotate(360deg)}}
input::placeholder,textarea::placeholder{color:#8b96a5} *{box-sizing:border-box}
button,input,select,textarea{font-family:inherit} button{min-height:40px}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible,[role="button"]:focus-visible{outline:3px solid #69b8ff!important;outline-offset:2px!important}
/* Match every <select> in the app to the dark system theme.
   color-scheme tells Chrome/Firefox/Safari to render the OPEN popup
   list using the dark scheme — the simplest cross-browser dark-mode
   for native selects. We also override the OS chevron with a tinted
   SVG that matches the rest of the UI (#6a8ab5). */
select{color-scheme:dark;appearance:none;-webkit-appearance:none;-moz-appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'><path d='M1 1L6 6L11 1' stroke='%236a8ab5' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");background-repeat:no-repeat;background-position:right 12px center;background-size:10px 6px;padding-right:32px!important}
select:focus{border-color:rgba(55,138,221,0.40)!important}
select option{background:#0d1117;color:#e8e6e3}
select option:hover, select option:focus, select option:checked{background:rgba(55,138,221,0.20)}
::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.06);border-radius:3px}
@media(max-width:768px){
.cc-create-card{width:100%!important;max-width:440px!important;padding:24px!important}
.cc-survey-card{width:100%!important;max-width:580px!important;padding:20px!important}
.cc-sidebar-overlay{position:fixed!important;top:0!important;left:0!important;height:100dvh!important;width:min(90vw,320px)!important;z-index:1000!important;background:rgba(10,14,23,0.98)!important;box-shadow:18px 0 40px rgba(0,0,0,0.35)!important;border-right:1px solid rgba(255,255,255,0.16)!important;transition:transform 0.25s ease,opacity 0.25s ease!important}
.cc-sidebar-overlay.is-open{transform:translateX(0)!important;opacity:1!important;pointer-events:auto!important}
.cc-sidebar-overlay.is-closed{transform:translateX(-105%)!important;opacity:0!important;pointer-events:none!important}
.cc-chat-main{width:100%!important}
.cc-quick-actions{overflow-x:auto!important;flex-wrap:nowrap!important;padding-bottom:4px!important}
.cc-quick-actions button{flex:0 0 auto!important}
}`;

export const btnPrimary = { padding:"12px 16px",minHeight:44,borderRadius:8,border:"none",background:"#2f86cf",color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer",width:"100%",transition:"opacity 0.2s" };

export const cardStyle = { width:"min(440px, calc(100vw - 32px))",padding:"clamp(24px, 5vw, 40px)",borderRadius:8,background:"#151a23",border:"1px solid rgba(255,255,255,0.16)" };

export const dots = ["#E24B4A","#378ADD","#BA7517","#D4537E","#7F77DD","#1D9E75"];

export const S = { LOADING:0, CREATE:1, LOGIN:2, SURVEY:3, CHAT:4 };

export function getEmailDomain(email) {
  return email?.split("@")[1] || "";
}
