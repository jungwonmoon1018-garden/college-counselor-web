// SurveyScreen, moved out of App.jsx on 2026-09-16 with the module-level
// helpers only it uses. App passes the state and callbacks it reads as
// one props object (surveyProps in App.jsx); nothing here writes App state
// except through those callbacks.
import { t as tt } from "./i18n.js";
import { GRADE_SCALE } from "./app-shared.js";
import { TEST_ORDER, blankTestForm, formToEntry, formatSections, sectionDefs, testLabel, withSection } from "./test-scores.js";
import CloseButton from "./components/CloseButton.jsx";
import { BG, FONT, GLOBAL_CSS, inputStyle, labelStyle } from "./app-shared.js";

const gradeLabel = (g) => {
  const found = GRADE_SCALE.find(e => e.grade === g);
  if (found) return found.label;
  if (g === "IP") return "In Progress";
  if (g === "W")  return "Withdrawn";
  return g || "—";
};

// ═══════════════════════════════════════════════════════════
// AP COURSE RIGOR DATA (Source: CollegeBoard AP Score Distributions 2026 (preliminary))
// Difficulty tier based on % scoring 5 and mean score — lower pass rate = harder
// ═══════════════════════════════════════════════════════════
// Common App's 30-category Activities taxonomy (verbatim from the official
// "Activity Type" dropdown on the Activities section). The `value` is the
// stable slug stored in the profile + sent over the wire; `label` is what
// the student sees. Order matches the Common App's own dropdown order so
// students can scan-match.
const EC_CATEGORIES = [
  { value: "academic",            label: "Academic" },
  { value: "art",                 label: "Art" },
  { value: "athletics_club",      label: "Athletics: Club" },
  { value: "athletics_varsity",   label: "Athletics: JV/Varsity" },
  { value: "career_oriented",     label: "Career Oriented" },
  { value: "community_service",   label: "Community Service (Volunteer)" },
  { value: "computer_tech",       label: "Computer/Technology" },
  { value: "cultural",            label: "Cultural" },
  { value: "dance",               label: "Dance" },
  { value: "debate_speech",       label: "Debate/Speech" },
  { value: "environmental",       label: "Environmental" },
  { value: "family_responsibilities", label: "Family Responsibilities" },
  { value: "foreign_exchange",    label: "Foreign Exchange" },
  { value: "foreign_language",    label: "Foreign Language" },
  { value: "internship",          label: "Internship" },
  { value: "journalism",          label: "Journalism/Publication" },
  { value: "jrotc",               label: "Junior ROTC" },
  { value: "lgbt",                label: "LGBT" },
  { value: "music_instrumental",  label: "Music: Instrumental" },
  { value: "music_vocal",         label: "Music: Vocal" },
  { value: "religious",           label: "Religious" },
  { value: "research",            label: "Research" },
  { value: "robotics",            label: "Robotics" },
  { value: "school_spirit",       label: "School Spirit" },
  { value: "science_math",        label: "Science/Math" },
  { value: "social_justice",      label: "Social Justice" },
  { value: "student_govt",        label: "Student Government/Politics" },
  { value: "theater_drama",       label: "Theater/Drama" },
  { value: "work_paid",           label: "Work (paid)" },
  { value: "other",               label: "Other Club/Activity" },
];

const EC_CATEGORY_LABEL = Object.fromEntries(EC_CATEGORIES.map(c => [c.value, c.label]));

// Migration shim — old categories ("club", "varsity", "arts", "work")
// stored before the Common App expansion. Re-mapped at display time so
// existing profiles don't show a blank category chip.
const EC_LEGACY_TO_NEW = {
  club:               "other",
  varsity:            "athletics_varsity",
  arts:               "art",
  work:               "work_paid",
};

function ecCategoryLabel(value) {
  if (!value) return "";
  const mapped = EC_LEGACY_TO_NEW[value] || value;
  return EC_CATEGORY_LABEL[mapped] || value.replace(/_/g, " ");
}

export default function SurveyScreen(props) {
  const {
    AP_COURSES,
    COURSE_GRADES,
    EXPIRY_NOTICE,
    RIGOR,
    STEPS,
    YEARS,
    addAP,
    addCourse,
    addEC,
    addTest,
    chip,
    dismissedNotice,
    expiryWarning,
    formatApLabel,
    importTranscript,
    isFreshman,
    locale,
    nxt,
    pill,
    prv,
    sAPInput,
    sAPScores,
    sClassRank,
    sCourseInput,
    sCourseYear,
    sCourses,
    sECInput,
    sECs,
    sGoals,
    sGpaUw,
    sGpaW,
    sImportBusy,
    sImportNote,
    sMajorInterest,
    sNoGpaYet,
    sNoTestsYet,
    sTestCategory,
    sTestInput,
    sTests,
    scoreHint,
    setDismissedNotice,
    setSAPInput,
    setSAPScores,
    setSClassRank,
    setSCourseInput,
    setSCourseYear,
    setSCourses,
    setSECInput,
    setSECs,
    setSGoals,
    setSGpaUw,
    setSGpaW,
    setSNoGpaYet,
    setSNoTestsYet,
    setSTestCategory,
    setSTestInput,
    setSTests,
    setStudentRecoveryCode,
    setSurveyError,
    setSurveyStep,
    setsMajorInterest,
    sl,
    st,
    stepRequired,
    studentRecoveryCode,
    surveyError,
    surveyStep,
    tab,
    testLimit,
    total,
    user,
    ylbl,
  } = props;
  return (
    <main style={{minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",background:BG,fontFamily:FONT,padding:16}}>
      {/* Inactivity auto-lock warning — the survey is where a silent sign-out
          hurts most (a half-completed transcript entry vanishes). */}
      {expiryWarning && dismissedNotice !== EXPIRY_NOTICE && (
        <div role="status" aria-live="polite" style={{position:"fixed",top:12,left:"50%",transform:"translateX(-50%)",zIndex:9999,padding:"8px 14px",borderRadius:10,fontSize:12,fontWeight:600,boxShadow:"0 4px 16px rgba(0,0,0,0.3)",background:"rgba(246,173,85,0.22)",border:"1px solid rgba(246,173,85,0.55)",color:"#fbd38d",display:"flex",alignItems:"center",gap:10}}>
          <span>{EXPIRY_NOTICE}</span>
          <CloseButton label={tt(locale, "chat.modal.close")} onClick={() => setDismissedNotice(EXPIRY_NOTICE)} size={22} style={{marginRight:-6}} />
        </div>
      )}
      <div className="cc-survey-card" style={{width:"min(680px, 100%)",maxHeight:"calc(100dvh - 32px)",padding:"clamp(20px, 4vw, 36px)",borderRadius:8,background:"#151a23",border:"1px solid rgba(255,255,255,0.16)",overflowY:"auto"}}>
        {studentRecoveryCode && (
          <div role="status" style={{marginBottom:18,padding:14,borderRadius:8,border:"1px solid rgba(246,173,85,0.55)",background:"rgba(246,173,85,0.10)",color:"#ffe0a3",fontSize:13,lineHeight:1.5}}>
            <strong>Save your one-time account recovery code offline.</strong>
            <code style={{display:"block",marginTop:8,overflowWrap:"anywhere",userSelect:"all"}}>{studentRecoveryCode}</code>
            <button type="button" onClick={()=>setStudentRecoveryCode("")} style={{marginTop:10,padding:"8px 12px",borderRadius:6,border:"1px solid rgba(246,173,85,0.45)",background:"transparent",color:"#ffe0a3",cursor:"pointer"}}>I saved it</button>
          </div>
        )}
        <div style={{display:"flex",gap:4,marginBottom:22}}>{STEPS.map((_,i)=>(<div key={i} style={{flex:1,height:3,borderRadius:2,background:i<=surveyStep?"#378ADD":"rgba(255,255,255,0.06)",transition:"background 0.3s"}} />))}</div>
        <div style={{fontSize:11,color:"#555",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4,display:"flex",justifyContent:"space-between"}}>
          <span>Step {surveyStep+1}/{total} {"\u00b7"} {user?.name}</span>
          {stepRequired?<span style={{color:"#E24B4A",fontSize:10}}>Required</span>:<span style={{color:"#68d391",fontSize:10}}>{isFreshman && surveyStep <= 2 ? "Optional for freshmen" : "Optional"}</span>}
        </div>
        <h2 style={{fontSize:22,fontWeight:700,color:"#e8e6e3",margin:"0 0 4px"}}>{st.title}</h2>
        <p style={{fontSize:13,color:"#6a6a7a",margin:"0 0 20px"}}>{st.sub}</p>

        {/* STEP 0: GPA */}
        {surveyStep===0 && (<div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div>
            <label style={labelStyle}>Unweighted GPA (4.0 scale) {stepRequired?"*":""}</label>
            <input type="number" step="0.01" min="0" max="4" value={sGpaUw} onChange={e=>{setSGpaUw(e.target.value); if (e.target.value) setSNoGpaYet(false);}} placeholder={isFreshman?"Not yet available":"e.g. 3.75"} disabled={sNoGpaYet} style={{...inputStyle,opacity:sNoGpaYet?0.6:1,cursor:sNoGpaYet?"not-allowed":"text"}} />
            <div style={{ display:"flex",alignItems:"center",gap:8,marginTop:8 }}>
              <input type="checkbox" id="noGpaYet" checked={sNoGpaYet} onChange={e=>{setSNoGpaYet(e.target.checked); if (e.target.checked) { setSGpaUw(""); setSGpaW(""); }}} style={{ accentColor:"#378ADD" }} />
              <label htmlFor="noGpaYet" style={{ fontSize:12,color:"#8a8a9a",cursor:"pointer" }}>I don't have a GPA yet</label>
            </div>
            {isFreshman && <div style={{fontSize:10,color:"#68d391",marginTop:4}}>Freshmen can continue without GPA, transcript, or test data.</div>}
          </div>
          <div><label style={labelStyle}>Weighted GPA (optional)</label><input type="number" step="0.01" min="0" max="5.5" value={sGpaW} onChange={e=>{setSGpaW(e.target.value); if (e.target.value) setSNoGpaYet(false);}} placeholder="e.g. 4.2" disabled={sNoGpaYet} style={{...inputStyle,opacity:sNoGpaYet?0.6:1,cursor:sNoGpaYet?"not-allowed":"text"}} /></div>
          <div>
            <label style={labelStyle}>Class rank (optional)</label>
            <div style={{display:"flex",gap:8}}>
              <input aria-label="Class rank" type="number" min="1" value={sClassRank.rank} onChange={e=>setSClassRank(p=>({...p,rank:e.target.value}))} placeholder="Rank (e.g. 12)" style={inputStyle} />
              <input aria-label="Class size" type="number" min="1" value={sClassRank.size} onChange={e=>setSClassRank(p=>({...p,size:e.target.value}))} placeholder="Class size (e.g. 400)" style={inputStyle} />
              <input aria-label="Top percent" type="number" min="0.1" max="100" step="0.1" value={sClassRank.topPercent} onChange={e=>setSClassRank(p=>({...p,topPercent:e.target.value}))} placeholder="or top %" style={inputStyle} />
            </div>
            <div style={{fontSize:10,color:"#555",marginTop:4}}>Colleges compare this with the share of their enrolled class that ranked in the top tenth or quarter (Common Data Set C10). Leave blank if your school does not rank.</div>
          </div>
          <div style={{fontSize:11,color:"#555",padding:12,borderRadius:8,background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.04)"}}>Course rigor (CollegeBoard): AP/IB/Dual Enrollment +1.0 weighted. Honors +0.5. Standard weights used by most colleges.</div>

          {/* Grading scale reference */}
          <div style={{padding:12,borderRadius:10,background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.04)"}}>
            <div style={{...labelStyle,marginBottom:2}}>Grading Scale</div>
            <div style={{fontSize:11,color:"#8a8a9a",marginBottom:8}}>Used to interpret letter-grade entries below.</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
              {GRADE_SCALE.map(e=>(
                <div key={e.grade} style={{fontSize:10,padding:"3px 8px",borderRadius:6,background:"rgba(255,255,255,0.05)",color:"#8a8a9a",whiteSpace:"nowrap"}}>
                  {e.grade}&nbsp;<span style={{color:"#6a6a7a"}}>{e.min===e.max?`${e.min}%`:e.max===100?`${e.min}%+`:`${e.min}–${e.max}%`}</span>
                </div>
              ))}
            </div>
          </div>
        </div>)}

        {/* STEP 1: TRANSCRIPT per year */}
        {surveyStep===1 && (<div>
          <div style={{display:"flex",gap:2,marginBottom:14,borderBottom:"1px solid rgba(255,255,255,0.05)"}}>{YEARS.map(y=>tab(sCourseYear===y,()=>setSCourseYear(y),ylbl(y),sCourses[y]?.length))}</div>
          {/* Transcript file import — extracts + parses courses for review */}
          <div style={{marginBottom:12}}>
            <input type="file" id="transcriptImportInput" accept=".pdf,.png,.jpg,.jpeg,.webp,.docx" style={{display:"none"}}
              onChange={e=>{ const f=e.target.files?.[0]; e.target.value=""; if (f) importTranscript(f); }} />
            <button
              onClick={()=>document.getElementById("transcriptImportInput")?.click()}
              disabled={sImportBusy}
              style={{width:"100%",padding:"10px 14px",borderRadius:10,border:"1px dashed rgba(99,179,237,0.4)",background:sImportBusy?"rgba(255,255,255,0.03)":"rgba(55,138,221,0.08)",color:sImportBusy?"#666":"#63b3ed",fontSize:12,fontWeight:600,cursor:sImportBusy?"default":"pointer"}}
            >{sImportBusy ? "Reading transcript…" : "📄 Import courses from a transcript (PDF, image, or DOCX)"}</button>
            {sImportNote && <div style={{marginTop:6,fontSize:11,color:"#68d391",lineHeight:1.5}}>{sImportNote}</div>}
            {!sImportNote && <div style={{marginTop:6,fontSize:10,color:"#6a6a7a"}}>Parsed courses land in the year tabs above for you to review — nothing is saved until you finish the survey.</div>}
          </div>
          {(sCourses[sCourseYear]||[]).length>0 && (<div style={{marginBottom:12,display:"flex",flexWrap:"wrap"}}>{sCourses[sCourseYear].map((c,i)=>{
            const bg=c.type==="ap"?"rgba(246,173,85,0.15)":c.type==="ib"?"rgba(127,119,221,0.15)":c.type==="honors"?"rgba(99,179,237,0.15)":c.type==="dual_enrollment"?"rgba(29,158,117,0.15)":c.type==="elective"?"rgba(218,165,109,0.12)":"";
            // Double-click loads the course into the input form below
            // and removes it from the list, so the student can adjust
            // any field (name / type / grade / semester) and re-Add.
            const editCourse = () => {
              setSCourseInput({
                name: c.name || "",
                type: c.type || "regular",
                grade: c.grade || "A",
                semester: c.semester || "full_year",
              });
              setSCourses(p=>({...p,[sCourseYear]:p[sCourseYear].filter((_,j)=>j!==i)}));
            };
            const label = `${c.type==="ap"?formatApLabel(c.name):c.type==="ib"?"IB "+c.name:c.name} \u2014 ${gradeLabel(c.grade)}`;
            return (
              <div
                key={i}
                onDoubleClick={editCourse}
                title="Double-click to edit"
                style={{display:"inline-flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:8,background:bg||"rgba(55,138,221,0.08)",border:`1px solid ${bg?"rgba(255,255,255,0.08)":"rgba(55,138,221,0.15)"}`,fontSize:11,color:bg?"#e8e6e3":"#63b3ed",margin:"0 5px 5px 0",cursor:"pointer",userSelect:"none"}}
              >
                {label}
                <button
                  onClick={(e)=>{ e.stopPropagation(); setSCourses(p=>({...p,[sCourseYear]:p[sCourseYear].filter((_,j)=>j!==i)})); }}
                  title="Remove"
                  style={{background:"none",border:"none",color:bg?"#aaa":"#6a8ab5",cursor:"pointer",fontSize:12,padding:0}}
                >{"\u2715"}</button>
              </div>
            );
          })}</div>)}
          <div style={{display:"flex",gap:8,marginBottom:8}}>
            <div style={{flex:2}}><input value={sCourseInput.name} onChange={e=>setSCourseInput(p=>({...p,name:e.target.value}))} placeholder={sCourseInput.type==="ap"?"Choose an AP course below":"Course name"} onKeyDown={e=>e.key==="Enter"&&addCourse()} readOnly={sCourseInput.type==="ap"} style={{...inputStyle,opacity:sCourseInput.type==="ap"?0.72:1,cursor:sCourseInput.type==="ap"?"pointer":"text"}} /></div>
            <div style={{flex:1}}><select value={sCourseInput.type} onChange={e=>setSCourseInput(p=>({...p,type:e.target.value,name:(e.target.value==="ap" || p.type==="ap") ? "" : p.name}))} style={sl}><option value="regular">Regular</option><option value="elective">Elective</option><option value="honors">Honors</option><option value="ap">AP</option><option value="ib">IB</option><option value="dual_enrollment">Dual Enroll</option></select></div>
          </div>
          {sCourseInput.type && <div style={{fontSize:10,color:"#6a8ab5",marginBottom:8}}>{RIGOR[sCourseInput.type]}</div>}
          {sCourseInput.type==="ap" && (<div style={{marginBottom:8}}><select value={sCourseInput.name} onChange={e=>setSCourseInput(p=>({...p,name:e.target.value}))} style={sl}><option value="">Select AP course (CollegeBoard)</option>{AP_COURSES.map(c=>(<option key={c} value={c}>{`AP ${c}`}</option>))}</select></div>)}
          <div style={{display:"flex",gap:8}}>
            <div style={{flex:1}}><select value={sCourseInput.grade} onChange={e=>setSCourseInput(p=>({...p,grade:e.target.value}))} style={sl}>{COURSE_GRADES.map(g=>(<option key={g} value={g}>{gradeLabel(g)}</option>))}<option value="IP">In Progress</option></select></div>
            <div style={{flex:1}}><select value={sCourseInput.semester||"full_year"} onChange={e=>setSCourseInput(p=>({...p,semester:e.target.value}))} style={sl}><option value="fall">Fall</option><option value="spring">Spring</option><option value="full_year">Full Year</option></select></div>
            <button onClick={addCourse} style={{padding:"0 20px",borderRadius:12,border:"none",background:sCourseInput.name.trim()?"linear-gradient(135deg,#378ADD,#667eea)":"rgba(255,255,255,0.03)",color:sCourseInput.name.trim()?"#fff":"#444",fontSize:14,fontWeight:600,cursor:sCourseInput.name.trim()?"pointer":"default"}}>Add</button>
          </div>
          {Object.values(sCourses).flat().length>0 && (<div style={{marginTop:14,padding:10,borderRadius:8,background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.04)",fontSize:11,color:"#6a6a7a"}}>Total: {Object.values(sCourses).flat().length} courses {"\u00b7"} {Object.values(sCourses).flat().filter(c=>c.type==="ap").length} AP {"\u00b7"} {Object.values(sCourses).flat().filter(c=>c.type==="honors").length} Honors {"\u00b7"} {Object.values(sCourses).flat().filter(c=>c.type==="ib").length} IB</div>)}
        </div>)}

        {/* STEP 2: TESTS & AP EXAMS */}
        {surveyStep===2 && (<div>
          <div style={{display:"flex",gap:2,marginBottom:14,borderBottom:"1px solid rgba(255,255,255,0.05)"}}>{tab(sTestCategory!=="ap_exam",()=>setSTestCategory("sat"),"Standardized tests",sTests.length)}{tab(sTestCategory==="ap_exam",()=>setSTestCategory("ap_exam"),"AP exam scores",sAPScores.length)}</div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
            <input type="checkbox" id="noTestsYet" checked={sNoTestsYet} onChange={e=>setSNoTestsYet(e.target.checked)} style={{ accentColor:"#378ADD" }} />
            <label htmlFor="noTestsYet" style={{ fontSize:12,color:"#8a8a9a",cursor:"pointer" }}>I haven't taken standardized tests yet</label>
          </div>

          {sTestCategory!=="ap_exam" ? (<div>
            {sTests.length>0 && <div style={{marginBottom:12,display:"flex",flexWrap:"wrap"}}>{sTests.map((t,i)=>{ const sections = formatSections(formToEntry(t), { short: true }); return pill(`${testLabel(t.test)}${t.subject?` (${t.subject})`:""}: ${t.totalScore}${sections?` (${sections})`:""}${t.date?` \u00b7 ${t.date}`:""}`,()=>setSTests(p=>p.filter((_,j)=>j!==i))); })}</div>}
            <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
              {TEST_ORDER.map(([k,l])=>chip(sTestInput.test===k,()=>setSTestInput(p=>({...blankTestForm(k),subject:k==="sat_subject"?p.subject:""})),l))}
            </div>
            {sTestInput.test==="sat_subject" && <div style={{marginBottom:8}}><input value={sTestInput.subject||""} onChange={e=>setSTestInput(p=>({...p,subject:e.target.value}))} placeholder="Subject (e.g. Math Level 2)" style={inputStyle} /></div>}
            {sectionDefs(sTestInput.test).length > 0 && (
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                {/* Section scores are optional; once every section that counts toward
                    the total is filled in, the total follows from them. */}
                {sectionDefs(sTestInput.test).map(d => (
                  <input key={d.key} aria-label={`${testLabel(sTestInput.test)} ${d.label}`} type="number" min={d.min} max={d.max} step={d.step} value={sTestInput.sections?.[d.key] ?? ""} onChange={e=>setSTestInput(p=>withSection(p, d.key, e.target.value))} placeholder={`${d.label} (${d.min}-${d.max})`} style={inputStyle} />
                ))}
              </div>
            )}
            <div style={{display:"flex",gap:8}}>
              <div style={{flex:1}}><input type="number" min={testLimit?.min} max={testLimit?.max} step={testLimit?.step ?? "any"} value={sTestInput.totalScore} onChange={e=>setSTestInput(p=>({...p,totalScore:e.target.value}))} placeholder={sTestInput.test==="sat"?"Total (400-1600)":(scoreHint[sTestInput.test]||"Score")} style={inputStyle} /></div>
              <div style={{flex:1}}><input type="month" value={sTestInput.date||""} onChange={e=>setSTestInput(p=>({...p,date:e.target.value}))} style={inputStyle} /></div>
              <button onClick={addTest} style={{padding:"0 20px",borderRadius:12,border:"none",background:sTestInput.totalScore?"linear-gradient(135deg,#378ADD,#667eea)":"rgba(255,255,255,0.03)",color:sTestInput.totalScore?"#fff":"#444",fontSize:14,fontWeight:600,cursor:sTestInput.totalScore?"pointer":"default"}}>Add</button>
            </div>
            <div style={{fontSize:10,color:"#555",marginTop:6}}>Valid range for {sTestInput.test.toUpperCase()}: {testLimit?.label || scoreHint[sTestInput.test] || "See official source"}.</div>
          </div>) : (<div>
            {sAPScores.length>0 && <div style={{marginBottom:12,display:"flex",flexWrap:"wrap"}}>{sAPScores.map((a,i)=>pill(`${formatApLabel(a.subject)}: ${a.score} (${a.year})`,()=>setSAPScores(p=>p.filter((_,j)=>j!==i)),"rgba(246,173,85,0.12)"))}</div>}
            <div style={{display:"flex",gap:8,marginBottom:8}}>
              <div style={{flex:2}}><select value={sAPInput.subject} onChange={e=>setSAPInput(p=>({...p,subject:e.target.value}))} style={sl}><option value="">Select AP exam (CollegeBoard)</option>{AP_COURSES.map(c=>(<option key={c} value={c}>{`AP ${c}`}</option>))}</select></div>
              <div style={{flex:1}}><select value={sAPInput.score} onChange={e=>setSAPInput(p=>({...p,score:e.target.value}))} style={sl}>{["5","4","3","2","1"].map(s=>(<option key={s} value={s}>{s}</option>))}</select></div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <div style={{flex:1}}><input type="number" min="2020" max="2030" value={sAPInput.year} onChange={e=>setSAPInput(p=>({...p,year:e.target.value}))} placeholder="Year" style={inputStyle} /></div>
              <button onClick={addAP} style={{padding:"0 20px",borderRadius:12,border:"none",background:sAPInput.subject?"linear-gradient(135deg,#378ADD,#667eea)":"rgba(255,255,255,0.03)",color:sAPInput.subject?"#fff":"#444",fontSize:14,fontWeight:600,cursor:sAPInput.subject?"pointer":"default"}}>Add</button>
            </div>
            <div style={{fontSize:10,color:"#555",marginTop:6}}>AP scores 1-5 (CollegeBoard). Score of 3+ generally qualifies for college credit.</div>
          </div>)}
        </div>)}

        {/* STEP 3: ECs (optional) */}
        {surveyStep===3 && (<div>
          <div style={{fontSize:12,color:"#68d391",marginBottom:12,padding:"8px 12px",borderRadius:8,background:"rgba(104,211,145,0.06)",border:"1px solid rgba(104,211,145,0.12)"}}>This step is optional {"\u2014"} you can skip and add activities later.</div>
          {sECs.length>0 && (
            <div style={{marginBottom:12,display:"flex",flexDirection:"column",gap:8}}>
              {sECs.map((ec,i) => {
                // Double-click loads the EC into the input form below
                // (name / category / role / hours / weeks / grades /
                // timing / description) and removes the card. The
                // student edits any field and re-clicks "Add EC" to
                // re-insert. The card border tints amber while
                // editing so it's obvious which item is being edited
                // (we surface that via title until a save).
                const editEC = () => {
                  setSECInput({
                    name: ec.name || "",
                    category: ec.category || "club",
                    role: ec.role || "",
                    hoursPerWeek: ec.hoursPerWeek != null ? String(ec.hoursPerWeek) : "",
                    weeksPerYear: ec.weeksPerYear != null ? String(ec.weeksPerYear) : "",
                    description: ec.description || "",
                    grades: Array.isArray(ec.grades) ? [...ec.grades] : [],
                    timing: ec.timing || "school_year",
                  });
                  setSECs(p => p.filter((_, j) => j !== i));
                  // Scroll the editor into view so the student sees
                  // where the values landed.
                  setTimeout(() => {
                    const el = document.querySelector('input[placeholder="Activity name"]');
                    if (el && typeof el.scrollIntoView === "function") {
                      el.scrollIntoView({ behavior: "smooth", block: "center" });
                      try { el.focus(); } catch {}
                    }
                  }, 0);
                };
                return (
                <div
                  key={i}
                  onDoubleClick={editEC}
                  title="Double-click to edit"
                  style={{padding:"10px 12px",borderRadius:10,background:"rgba(55,138,221,0.06)",border:"1px solid rgba(55,138,221,0.12)",position:"relative",cursor:"pointer",userSelect:"none"}}
                >
                  <button onClick={(e)=>{ e.stopPropagation(); setSECs(p=>p.filter((_,j)=>j!==i)); }} title="Remove" style={{position:"absolute",top:8,right:8,background:"none",border:"none",color:"#6a8ab5",cursor:"pointer",fontSize:12,padding:0,opacity:0.6}}>{"\u2715"}</button>
                  <div style={{fontSize:13,fontWeight:600,color:"#cfe5ff",marginBottom:2,paddingRight:20}}>{ec.name}</div>
                  <div style={{fontSize:11,color:"#8ab2dd",marginBottom:ec.description?6:0}}>
                    {ec.role}
                    {ec.hoursPerWeek ? <span style={{color:"#6a8ab5"}}> {"\u00b7"} {ec.hoursPerWeek} hrs/wk</span> : null}
                    {ec.weeksPerYear ? <span style={{color:"#6a8ab5"}}> {"\u00b7"} {ec.weeksPerYear} wks/yr</span> : null}
                    {ec.category ? <span style={{color:"#6a8ab5"}}> {"\u00b7"} {ecCategoryLabel(ec.category)}</span> : null}
                  </div>
                  {(Array.isArray(ec.grades) && ec.grades.length > 0) || ec.timing ? (
                    <div style={{fontSize:10,color:"#6a8ab5",marginBottom:ec.description?6:0,display:"flex",gap:6,flexWrap:"wrap"}}>
                      {Array.isArray(ec.grades) && ec.grades.length > 0 && (
                        <span style={{padding:"2px 7px",borderRadius:10,background:"rgba(55,138,221,0.10)"}}>
                          {ec.grades.map(g => ({freshman:"9",sophomore:"10",junior:"11",senior:"12"}[g])).filter(Boolean).join("/")}
                          {ec.grades.length === 1 ? "th" : ""} grade
                        </span>
                      )}
                      {ec.timing && (
                        <span style={{padding:"2px 7px",borderRadius:10,background:"rgba(104,211,145,0.10)",color:"#9ce5b6"}}>
                          {ec.timing === "school_year" ? "School year" : ec.timing === "school_break" ? "School breaks" : "Year-round"}
                        </span>
                      )}
                    </div>
                  ) : null}
                  {ec.description && <div style={{fontSize:11,color:"#a8a8b8",fontStyle:"italic",lineHeight:1.45,paddingTop:4,borderTop:"1px solid rgba(255,255,255,0.04)"}}>{ec.description}</div>}
                </div>
                );
              })}
            </div>
          )}
          <div style={{display:"flex",gap:8,marginBottom:8}}>
            <div style={{flex:2}}><input value={sECInput.name} onChange={e=>setSECInput(p=>({...p,name:e.target.value}))} placeholder="Activity name" style={inputStyle} /></div>
            <div style={{flex:1}}><select value={sECInput.category} onChange={e=>setSECInput(p=>({...p,category:e.target.value}))} style={sl}>
              {EC_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select></div>
          </div>
          <div style={{display:"flex",gap:8,marginBottom:8}}>
            <div style={{flex:2}}><input value={sECInput.role} onChange={e=>setSECInput(p=>({...p,role:e.target.value}))} placeholder="Your role" style={inputStyle} /></div>
            <div style={{flex:1}}><input type="number" min="0" max="60" value={sECInput.hoursPerWeek} onChange={e=>setSECInput(p=>({...p,hoursPerWeek:e.target.value}))} placeholder="Hrs/wk" style={inputStyle} /></div>
            <div style={{flex:1}}><input type="number" min="0" max="52" value={sECInput.weeksPerYear} onChange={e=>setSECInput(p=>({...p,weeksPerYear:e.target.value}))} placeholder="Wks/yr" style={inputStyle} /></div>
          </div>

          {/* Participation grade levels — multi-select chips (Common App
              lets students check 9 / 10 / 11 / 12 for each activity). */}
          <div style={{marginBottom:8}}>
            <div style={{fontSize:10,color:"#6a6a7a",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:6}}>Participated in grade</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {[
                { val:"freshman",  label:"9th"  },
                { val:"sophomore", label:"10th" },
                { val:"junior",    label:"11th" },
                { val:"senior",    label:"12th" },
              ].map(g => {
                const on = sECInput.grades.includes(g.val);
                return (
                  <button key={g.val} type="button"
                    onClick={() => setSECInput(p => ({
                      ...p,
                      grades: on ? p.grades.filter(x => x !== g.val) : [...p.grades, g.val],
                    }))}
                    style={{
                      padding:"6px 12px",borderRadius:18,
                      border:`1px solid ${on?"rgba(55,138,221,0.45)":"rgba(255,255,255,0.08)"}`,
                      background:on?"rgba(55,138,221,0.14)":"rgba(255,255,255,0.02)",
                      color:on?"#cfe5ff":"#8a8a9a",
                      fontSize:11,fontWeight:on?600:400,cursor:"pointer",transition:"all 0.15s",
                    }}
                  >{g.label}</button>
                );
              })}
            </div>
          </div>

          {/* Timing of participation — when in the calendar this happens.
              Matches the Common App's "School Year / School Break / All
              year" toggle. Useful for the EC strategist to distinguish a
              summer-only research program from a year-round club. */}
          <div style={{marginBottom:8}}>
            <div style={{fontSize:10,color:"#6a6a7a",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:6}}>When</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {[
                { val:"school_year",  label:"School year" },
                { val:"school_break", label:"School breaks" },
                { val:"both",         label:"Year-round" },
              ].map(t => {
                const on = sECInput.timing === t.val;
                return (
                  <button key={t.val} type="button"
                    onClick={() => setSECInput(p => ({ ...p, timing: t.val }))}
                    style={{
                      padding:"6px 12px",borderRadius:8,
                      border:`1px solid ${on?"rgba(104,211,145,0.40)":"rgba(255,255,255,0.08)"}`,
                      background:on?"rgba(104,211,145,0.12)":"rgba(255,255,255,0.02)",
                      color:on?"#9ce5b6":"#8a8a9a",
                      fontSize:11,fontWeight:on?600:400,cursor:"pointer",transition:"all 0.15s",
                    }}
                  >{t.label}</button>
                );
              })}
            </div>
          </div>
          {/* Description (Common App-style, 150-char hard cap). This is the
              field where the student actually *shines* \u2014 concrete impact,
              numbers, distinct contribution. Show a live counter so the
              discipline of fitting in 150 chars is visible. */}
          <div style={{marginBottom:8}}>
            <textarea
              value={sECInput.description}
              onChange={e => setSECInput(p => ({ ...p, description: e.target.value.slice(0, 150) }))}
              onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) addEC(); }}
              placeholder="Describe the impact you had. Mirrors the Common App: concrete, specific, with numbers when possible. Max 150 chars."
              rows={3}
              style={{
                width:"100%",boxSizing:"border-box",
                padding:"10px 12px",borderRadius:12,
                border:"1px solid rgba(255,255,255,0.08)",
                background:"rgba(255,255,255,0.03)",
                color:"#e8e6e3",fontSize:13,outline:"none",
                resize:"vertical",minHeight:64,
                fontFamily:"inherit",lineHeight:1.45,
              }}
            />
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:4,fontSize:10,color:"#6a6a7a"}}>
              <span>Common App-style: lead with action verbs, name a result, quantify if you can.</span>
              <span style={{color:sECInput.description.length > 130 ? "#f6ad55" : sECInput.description.length >= 150 ? "#fc8181" : "#6a6a7a",fontVariantNumeric:"tabular-nums"}}>{sECInput.description.length}/150</span>
            </div>
          </div>
          <div style={{display:"flex",justifyContent:"flex-end"}}>
            <button onClick={addEC}
              disabled={!sECInput.name.trim() || !sECInput.role.trim()}
              style={{padding:"10px 22px",borderRadius:12,border:"none",
                background:(sECInput.name.trim()&&sECInput.role.trim())?"linear-gradient(135deg,#378ADD,#667eea)":"rgba(255,255,255,0.03)",
                color:(sECInput.name.trim()&&sECInput.role.trim())?"#fff":"#444",
                fontSize:14,fontWeight:600,
                cursor:(sECInput.name.trim()&&sECInput.role.trim())?"pointer":"default"}}>
              Add activity
            </button>
          </div>
        </div>)}

        {/* STEP 4: GOALS */}
        {surveyStep===4 && (<div style={{display:"flex",flexDirection:"column",gap:16}}>
          <div><label style={labelStyle}>College types *</label><div style={{display:"flex",flexWrap:"wrap",gap:8}}>{["Ivy League / T20","Large state school","Small liberal arts","STEM-focused","Art / Design","Community college","International"].map(g=>chip(sGoals.includes(g),()=>setSGoals(p=>p.includes(g)?p.filter(x=>x!==g):[...p,g]),g))}</div></div>
          <div><label style={labelStyle}>Intended major</label><input value={sMajorInterest} onChange={e=>setsMajorInterest(e.target.value)} placeholder="e.g. Computer Science, Pre-Med..." style={inputStyle} /></div>
          <div><label style={labelStyle}>What matters most?</label><div style={{display:"flex",flexWrap:"wrap",gap:8}}>{["Strong academics","Campus life","Financial aid","Location","Research","Diversity","Athletics","Small classes"].map(g=>chip(sGoals.includes(g),()=>setSGoals(p=>p.includes(g)?p.filter(x=>x!==g):[...p,g]),g))}</div></div>
        </div>)}


        {surveyError && <div style={{marginTop:14,fontSize:13,color:"#f56565",background:"rgba(245,101,101,0.08)",padding:"10px 14px",borderRadius:10}}>{surveyError}</div>}

        <div style={{display:"flex",gap:10,marginTop:22,alignItems:"center"}}>
          {surveyStep>0 && <button onClick={prv} style={{padding:"12px 20px",borderRadius:12,border:"1px solid rgba(255,255,255,0.08)",background:"transparent",color:"#8a8a9a",fontSize:14,cursor:"pointer"}}>Back</button>}
          <div style={{flex:1}} />
          {!stepRequired && surveyStep<total-1 && <button onClick={()=>{setSurveyError("");setSurveyStep(surveyStep+1)}} style={{padding:"12px 16px",borderRadius:12,border:"none",background:"transparent",color:"#6a6a7a",fontSize:13,cursor:"pointer"}}>Skip</button>}
          <button onClick={nxt} style={{padding:"12px 28px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#378ADD,#667eea)",color:"#fff",fontSize:14,fontWeight:600,cursor:"pointer"}}>{surveyStep===total-1?"Finish setup":"Continue"}</button>
        </div>
        <p style={{fontSize:10,color:"#333",textAlign:"center",marginTop:14}}>You can update this later by chatting with your counselor.</p>
      </div>
      <style>{GLOBAL_CSS}</style>
    </main>
  );
}
