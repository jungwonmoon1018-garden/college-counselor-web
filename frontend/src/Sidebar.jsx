// The sidebar of the chat screen, moved out of App.jsx on 2026-09-16 with
// the helpers, styles and in-place editors only it uses. App passes the
// state and callbacks it reads as one props object (sidebarProps in
// App.jsx); nothing here writes App state except through those callbacks.
import { TEST_ORDER, TEST_SCORE_LIMITS, blankTestForm, entryToForm, formToEntry, formatClassRank, formatSections, normalizeClassRank, sectionDefs, testLabel, validateTestEntry, withSection } from "./test-scores.js";
import { t as tt } from "./i18n.js";
import { formatServerDate } from "./dates.js";
import { useState } from "react";
import SidebarSection from "./components/SidebarSection.jsx";
import CalibratedFitCard from "./components/CalibratedFitCard.jsx";
import EcEvidence, { ChatEvidenceSync } from "./components/EcEvidence.jsx";
import PrestigeCard from "./components/PrestigeCard.jsx";
import { AP_EXAM_LIST, GRADE_SCALE } from "./app-shared.js";

// ═══════════════════════════════════════════════════════════
// GPA CALCULATOR — unweighted (4.0 scale) + weighted (rigor bonus).
// Rigor bonuses match the course-form RIGOR table: AP/IB/dual +1.0,
// honors +0.5, regular/elective +0. Non-graded rows (IP/W/Pass) are
// excluded. Letter grades map to standard GPA points; numeric grades
// are treated as percentages (banded) or as an already-4.0 value.
// ═══════════════════════════════════════════════════════════
const GPA_POINTS = { "A+":4.0,"A":4.0,"A-":3.7,"B+":3.3,"B":3.0,"B-":2.7,"C+":2.3,"C":2.0,"C-":1.7,"D+":1.3,"D":1.0,"D-":0.7,"F":0.0 };

const GPA_WEIGHT_BONUS = { honors:0.5, ap:1.0, ib:1.0, dual_enrollment:1.0 };

function gpaPointsForGrade(grade) {
  if (grade == null || grade === "") return null;
  const s = String(grade).trim().toUpperCase();
  if (s in GPA_POINTS) return GPA_POINTS[s];
  if (["IP","W","P","NP","CR","NC","AUDIT"].includes(s)) return null; // not counted
  const num = parseFloat(s);
  if (Number.isFinite(num)) {
    if (num <= 5) return Math.min(4, num);                 // already a GPA-style value
    const band = GRADE_SCALE.find(e => num >= e.min && num <= e.max);
    if (band) return GPA_POINTS[band.grade] ?? null;        // percentage → band → points
  }
  return null;
}

function computeGpaFromCourses(courses) {
  let sumU = 0, sumW = 0, n = 0;
  for (const c of (courses || [])) {
    const pts = gpaPointsForGrade(c?.grade);
    if (pts == null) continue;
    const bonus = GPA_WEIGHT_BONUS[String(c?.type || "").toLowerCase()] || 0;
    sumU += pts;
    sumW += pts + bonus;
    n += 1;
  }
  if (!n) return null;
  return {
    unweighted: Math.round((sumU / n) * 100) / 100,
    weighted: Math.round((sumW / n) * 100) / 100,
    count: n,
  };
}

function formatAcademicYearLabel(year) {
  const labels = { freshman:"Freshman", sophomore:"Sophomore", junior:"Junior", senior:"Senior" };
  return labels[year] || year || "Unknown";
}

// ─── Round 1-5 sidebar styles ───────────────────────────────────
// Tool buttons sit under "Tools" in the chat sidebar. Locale buttons
// sit under "Language". Kept module-level so they don't re-allocate
// on every chat re-render.
const sidebarToolBtn = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(255,255,255,0.02)",
  color: "#cbd5e0",
  fontSize: 12,
  cursor: "pointer",
  textAlign: "left",
};

const localeBtn = {
  flex: 1,
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "transparent",
  color: "#8a8a9a",
  fontSize: 11,
  cursor: "pointer",
};

const localeBtnActive = {
  background: "rgba(55,138,221,0.15)",
  color: "#63b3ed",
  borderColor: "rgba(55,138,221,0.3)",
};

const EDITOR_INPUT = { padding:"5px 8px", borderRadius:6, border:"1px solid rgba(127,119,221,0.4)", background:"rgba(255,255,255,0.06)", color:"#fff", fontSize:12, outline:"none", width:"100%", boxSizing:"border-box", minWidth:0 };

const EDITOR_SELECT = { ...EDITOR_INPUT, colorScheme:"dark" };

const EDITOR_BUTTON = { padding:"4px 9px", borderRadius:6, border:"none", background:"rgba(255,255,255,0.05)", color:"#aaa", fontSize:11, cursor:"pointer" };

const EDITOR_SAVE = { ...EDITOR_BUTTON, background:"rgba(104,211,145,0.15)", color:"#68d391" };

const EDITOR_REMOVE = { ...EDITOR_BUTTON, marginLeft:"auto", color:"#fc8181" };

const EDITOR_ERROR = { fontSize:11, color:"#fc8181", marginBottom:6 };

function TestScoreEditor({ initial, onSave, onCancel, onDelete }) {
  const [form, setForm] = useState(() => (initial ? entryToForm(initial) : blankTestForm("sat")));
  const [error, setError] = useState("");
  const defs = sectionDefs(form.test);
  const limit = TEST_SCORE_LIMITS[form.test];
  const save = () => {
    const entry = formToEntry(form);
    const check = validateTestEntry(entry);
    if (!check.ok) { setError(check.errors[0]); return; }
    onSave(entry);
  };
  return (
    <div data-testid="test-score-editor" style={{ background:"rgba(127,119,221,0.08)", borderRadius:10, padding:12, marginBottom:12, border:"1px solid rgba(127,119,221,0.35)" }}>
      <div style={{ display:"flex", gap:6, marginBottom:6 }}>
        <select aria-label="Test" value={form.test} onChange={(e) => { setError(""); setForm(blankTestForm(e.target.value)); }} style={{ ...EDITOR_SELECT, flex:1 }}>
          {TEST_ORDER.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <input aria-label={`${testLabel(form.test)} total`} type="number" min={limit?.min} max={limit?.max} step={limit?.step ?? "any"} value={form.totalScore}
          onChange={(e) => setForm((p) => ({ ...p, totalScore: e.target.value }))} placeholder={`Total (${limit?.label || ""})`} style={{ ...EDITOR_INPUT, flex:1 }} />
      </div>
      {form.test === "sat_subject" && (
        <input aria-label="Subject" value={form.subject} onChange={(e) => setForm((p) => ({ ...p, subject: e.target.value }))} placeholder="Subject (e.g. Math Level 2)" style={{ ...EDITOR_INPUT, marginBottom:6 }} />
      )}
      {defs.length > 0 && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:6 }}>
          {defs.map((d) => (
            <input key={d.key} aria-label={`${testLabel(form.test)} ${d.label}`} type="number" min={d.min} max={d.max} step={d.step} value={form.sections[d.key] ?? ""}
              onChange={(e) => setForm((p) => withSection(p, d.key, e.target.value))} placeholder={`${d.label} (${d.min}-${d.max})`} style={EDITOR_INPUT} />
          ))}
        </div>
      )}
      <input aria-label="Test date" type="month" value={form.date} onChange={(e) => setForm((p) => ({ ...p, date: e.target.value }))} style={{ ...EDITOR_INPUT, marginBottom:6 }} />
      {error && <div role="alert" style={EDITOR_ERROR}>{error}</div>}
      <div style={{ display:"flex", gap:6 }}>
        <button type="button" onClick={save} style={EDITOR_SAVE}>Save</button>
        <button type="button" onClick={onCancel} style={EDITOR_BUTTON}>Cancel</button>
        {onDelete && <button type="button" onClick={onDelete} style={EDITOR_REMOVE}>Remove</button>}
      </div>
    </div>
  );
}

function ApScoreEditor({ initial, onSave, onCancel, onDelete }) {
  const [form, setForm] = useState({
    exam: initial?.exam || initial?.subject || initial?.name || "",
    score: String(initial?.score ?? 5),
    year: String(initial?.year || new Date().getFullYear()),
  });
  const [error, setError] = useState("");
  const save = () => {
    const exam = String(form.exam || "").trim().slice(0, 80);
    const score = parseInt(form.score, 10);
    const year = parseInt(form.year, 10);
    if (!exam) { setError("Pick the AP exam."); return; }
    if (!(score >= 1 && score <= 5)) { setError("AP scores run 1-5."); return; }
    if (!(year >= 2000 && year <= 2100)) { setError("Enter the exam year."); return; }
    onSave({ exam, score, year });
  };
  const known = AP_EXAM_LIST.includes(form.exam);
  return (
    <div data-testid="ap-score-editor" style={{ background:"rgba(246,173,85,0.08)", borderRadius:10, padding:12, marginBottom:12, border:"1px solid rgba(246,173,85,0.35)" }}>
      <select aria-label="AP exam" value={known ? form.exam : (form.exam ? "__custom" : "")} onChange={(e) => setForm((p) => ({ ...p, exam: e.target.value === "__custom" ? p.exam : e.target.value }))} style={{ ...EDITOR_SELECT, marginBottom:6 }}>
        <option value="">Select AP exam (CollegeBoard)</option>
        {AP_EXAM_LIST.map((c) => <option key={c} value={c}>{`AP ${c}`}</option>)}
        {!known && form.exam && <option value="__custom">{`AP ${form.exam}`}</option>}
      </select>
      <div style={{ display:"flex", gap:6, marginBottom:6 }}>
        <select aria-label="AP score" value={form.score} onChange={(e) => setForm((p) => ({ ...p, score: e.target.value }))} style={{ ...EDITOR_SELECT, flex:1 }}>
          {["5", "4", "3", "2", "1"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input aria-label="AP exam year" type="number" min="2000" max="2100" value={form.year} onChange={(e) => setForm((p) => ({ ...p, year: e.target.value }))} placeholder="Year" style={{ ...EDITOR_INPUT, flex:1 }} />
      </div>
      {error && <div role="alert" style={EDITOR_ERROR}>{error}</div>}
      <div style={{ display:"flex", gap:6 }}>
        <button type="button" onClick={save} style={EDITOR_SAVE}>Save</button>
        <button type="button" onClick={onCancel} style={EDITOR_BUTTON}>Cancel</button>
        {onDelete && <button type="button" onClick={onDelete} style={EDITOR_REMOVE}>Remove</button>}
      </div>
    </div>
  );
}

function ClassRankEditor({ initial, onSave, onCancel, onDelete }) {
  const [form, setForm] = useState({
    rank: initial?.rank != null ? String(initial.rank) : "",
    size: initial?.size != null ? String(initial.size) : "",
    topPercent: initial?.topPercent != null && initial?.rank == null ? String(initial.topPercent) : "",
  });
  const [error, setError] = useState("");
  const save = () => {
    const rank = normalizeClassRank(form);
    if (!rank) { setError("Enter a rank with the class size, or the top percentage."); return; }
    onSave(rank);
  };
  return (
    <div data-testid="class-rank-editor" style={{ background:"rgba(55,138,221,0.08)", borderRadius:10, padding:12, marginBottom:12, border:"1px solid rgba(55,138,221,0.3)" }}>
      <div style={{ fontSize:11, color:"#6a8ab5", marginBottom:6 }}>Class rank</div>
      <div style={{ display:"flex", gap:6, marginBottom:6 }}>
        <input aria-label="Class rank" type="number" min="1" value={form.rank} onChange={(e) => setForm((p) => ({ ...p, rank: e.target.value }))} placeholder="Rank" style={EDITOR_INPUT} />
        <input aria-label="Class size" type="number" min="1" value={form.size} onChange={(e) => setForm((p) => ({ ...p, size: e.target.value }))} placeholder="Class size" style={EDITOR_INPUT} />
        <input aria-label="Top percent" type="number" min="0.1" max="100" step="0.1" value={form.topPercent} onChange={(e) => setForm((p) => ({ ...p, topPercent: e.target.value }))} placeholder="or top %" style={EDITOR_INPUT} />
      </div>
      {error && <div role="alert" style={EDITOR_ERROR}>{error}</div>}
      <div style={{ display:"flex", gap:6 }}>
        <button type="button" onClick={save} style={EDITOR_SAVE}>Save</button>
        <button type="button" onClick={onCancel} style={EDITOR_BUTTON}>Cancel</button>
        {onDelete && <button type="button" onClick={onDelete} style={EDITOR_REMOVE}>Remove</button>}
      </div>
    </div>
  );
}

export default function Sidebar(props) {
  const {
    activeThreadId,
    activities,
    addTargetSchool,
    beginEdit,
    budgetStatus,
    collegePositioning,
    collegePositioningLoading,
    collegeValues,
    collegeValuesHint,
    collegeValuesLoading,
    collegeValuesQuery,
    collegeVerification,
    collegeVerifying,
    commitProfile,
    data,
    deleteThread,
    draftA,
    draftB,
    editECFromProfile,
    editingField,
    evidenceVersion,
    expandedEC,
    handleDeleteAccount,
    handleLogout,
    locale,
    lookupCollege,
    newThread,
    openProfileEditor,
    openThread,
    profile,
    removeTargetSchool,
    renameThreadTitle,
    renamingThreadId,
    searchThreads,
    setActivePanel,
    setCollegeValues,
    setCollegeValuesHint,
    setCollegeValuesQuery,
    setData,
    setDraftA,
    setDraftB,
    setEditingField,
    setEvidenceVersion,
    setExpandedEC,
    setLocale,
    setRenamingThreadId,
    setShowAllCourses,
    setShowAllECs,
    setTargetSchoolInput,
    setThreadSearchQ,
    setThreadSearchResults,
    showAllCourses,
    showAllECs,
    sidebarOpen,
    targetSchoolInput,
    targetSchools,
    threadList,
    threadSearchQ,
    threadSearchResults,
    user,
    verifyCollegeFit,
  } = props;
  return (
    <aside aria-label="Student profile and planning tools" className={`cc-sidebar-overlay ${sidebarOpen ? "is-open" : "is-closed"}`} style={{ width:sidebarOpen?280:0,overflow:"hidden",transition:"width 0.25s ease",borderRight:sidebarOpen?"1px solid rgba(255,255,255,0.05)":"none",background:"rgba(255,255,255,0.015)",flexShrink:0 }}>
      <div style={{ padding:18,overflowY:"auto",height:"100%",width:280,boxSizing:"border-box" }}>
        <div style={{ display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8,marginBottom:12 }}>
          <div style={{minWidth:0,flex:1}}>
            <div style={{ fontSize:14,fontWeight:600 }}>{user?.name}</div>
            <div style={{ fontSize:12,color:"#a8b3c1",overflowWrap:"anywhere" }}>{user?.email ? (user.email.split("@")[0].slice(0,2) + "***@" + user.email.split("@")[1]) : ""} · {user?.grade}</div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <button onClick={handleLogout} style={{ padding:"7px 9px",borderRadius:6,border:"1px solid rgba(255,255,255,0.16)",background:"transparent",color:"#b7c1ce",fontSize:11,cursor:"pointer" }}>Log out</button>
            <button onClick={handleDeleteAccount} style={{ padding:"7px 9px",borderRadius:6,border:"1px solid rgba(245,101,101,0.35)",background:"transparent",color:"#ff9da5",fontSize:11,cursor:"pointer" }}>Delete</button>
          </div>
        </div>
        {budgetStatus?.capUsd != null && (
          <div aria-label={`Monthly AI budget: $${budgetStatus.committedUsd.toFixed(2)} used of $${budgetStatus.capUsd.toFixed(2)}`} style={{marginBottom:16,padding:10,borderRadius:8,border:"1px solid rgba(255,255,255,0.14)",background:"rgba(255,255,255,0.025)"}}>
            <div style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:12,color:"#b7c1ce"}}><span>AI budget</span><span>${budgetStatus.remainingUsd.toFixed(2)} left</span></div>
            <div style={{height:6,marginTop:7,borderRadius:3,background:"rgba(255,255,255,0.10)",overflow:"hidden"}}><div style={{height:"100%",width:`${Math.min(100,(budgetStatus.committedUsd/budgetStatus.capUsd)*100)}%`,background:budgetStatus.remainingUsd>0?"#3f9c72":"#c85c64"}} /></div>
          </div>
        )}

        {/* ─── Chat history (multi-thread) ─────────────────────────── */}
        <SidebarSection id="chats" title="Chats" action={
          <button onClick={() => newThread()}
            title="Start a new conversation"
            style={{ padding:"3px 8px",borderRadius:6,border:"1px solid rgba(55,138,221,0.25)",background:"rgba(55,138,221,0.08)",color:"#63b3ed",fontSize:11,fontWeight:600,cursor:"pointer" }}>
            + New
          </button>
        }>
        <input
          placeholder="Search chats…"
          value={threadSearchQ}
          onChange={e => searchThreads(e.target.value)}
          style={{ width:"100%",boxSizing:"border-box",padding:"6px 9px",borderRadius:6,border:"1px solid rgba(255,255,255,0.06)",background:"rgba(255,255,255,0.02)",color:"#bbb",fontSize:11,marginBottom:8,outline:"none" }}
        />
        <div style={{ maxHeight:200,overflowY:"auto",marginBottom:14 }}>
          {threadSearchQ.length >= 2 && threadSearchResults.length > 0 && (
            <>
              <div style={{fontSize:10,color:"#555",margin:"4px 0 6px"}}>Matches</div>
              {threadSearchResults.slice(0,10).map(r => (
                <div key={r.id} onClick={()=>{ openThread(r.thread_id); setThreadSearchQ(""); setThreadSearchResults([]); }}
                  style={{padding:"6px 8px",borderRadius:6,cursor:"pointer",fontSize:11,color:"#aaa",marginBottom:4,background:"rgba(255,255,255,0.015)"}}>
                  <div style={{fontWeight:600,color:"#ccc"}}>{r.title || "Untitled"}</div>
                  <div style={{color:"#666",fontSize:10,marginTop:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{r.content.slice(0,80)}</div>
                </div>
              ))}
              <div style={{height:1,background:"rgba(255,255,255,0.04)",margin:"6px 0"}} />
            </>
          )}
          {threadList.length === 0 && (
            <div style={{fontSize:11,color:"#555",padding:"8px 0",fontStyle:"italic"}}>No chats yet. Send a message to start one.</div>
          )}
          {threadList.map(t => (
            <div key={t.id}
              onClick={() => openThread(t.id)}
              style={{
                padding:"7px 9px",borderRadius:6,cursor:"pointer",fontSize:11,marginBottom:3,
                background: activeThreadId === t.id ? "rgba(55,138,221,0.10)" : "transparent",
                border: activeThreadId === t.id ? "1px solid rgba(55,138,221,0.20)" : "1px solid transparent",
                display:"flex",alignItems:"center",justifyContent:"space-between",gap:6,
              }}>
              <div style={{flex:1,minWidth:0,overflow:"hidden"}}>
                {renamingThreadId === t.id ? (
                  <input
                    autoFocus
                    defaultValue={t.title || ""}
                    onClick={e => e.stopPropagation()}
                    onKeyDown={e => {
                      e.stopPropagation();
                      if (e.key === "Enter") renameThreadTitle(t.id, e.target.value);
                      else if (e.key === "Escape") setRenamingThreadId(null);
                    }}
                    onBlur={e => renameThreadTitle(t.id, e.target.value)}
                    style={{width:"100%",padding:"2px 6px",borderRadius:5,border:"1px solid rgba(55,138,221,0.4)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:11,outline:"none"}}
                  />
                ) : (
                  <div
                    onDoubleClick={e => { e.stopPropagation(); setRenamingThreadId(t.id); }}
                    title="Double-click to rename"
                    style={{color:activeThreadId === t.id ? "#cfe5ff" : "#bbb",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",fontWeight: activeThreadId === t.id ? 600 : 400}}
                  >{t.title || "Untitled"}</div>
                )}
                <div style={{fontSize:9,color:"#555",marginTop:2}}>{t.message_count} msg {"·"} {formatServerDate(t.updated_at)}</div>
              </div>
              <button onClick={e => { e.stopPropagation(); if (confirm("Delete this chat?")) deleteThread(t.id, true); }}
                title="Delete this chat"
                style={{background:"none",border:"none",color:"#666",cursor:"pointer",fontSize:11,padding:"2px 4px",opacity:0.5}}>{"✕"}</button>
            </div>
          ))}
        </div>

        {/* ─── College values + fit ────────────────────────────────── */}
        </SidebarSection>
        <SidebarSection id="college-fit" title="College fit">
        <div style={{display:"flex",gap:6,marginBottom:8}}>
          <input
            placeholder="e.g. UC Berkeley, Princeton, Texas A&M College Station"
            value={collegeValuesQuery}
            onChange={e => {
              setCollegeValuesQuery(e.target.value);
              // Clear stale results as soon as the student starts
              // typing a new query — otherwise the previous college's
              // values stay visible and it looks like the new search
              // never fired. Cached result still re-appears instantly
              // on submit (server-side cache), so this isn't wasteful.
              if (collegeValues) setCollegeValues(null);
            }}
            onKeyDown={e => { if (e.key === "Enter" && collegeValuesQuery.trim()) lookupCollege(collegeValuesQuery.trim(), collegeValuesHint.trim() || undefined); }}
            style={{ flex:1,padding:"6px 9px",borderRadius:6,border:"1px solid rgba(255,255,255,0.06)",background:"rgba(255,255,255,0.02)",color:"#bbb",fontSize:11,outline:"none" }}
          />
          <button onClick={() => collegeValuesQuery.trim() && lookupCollege(collegeValuesQuery.trim(), collegeValuesHint.trim() || undefined)}
            disabled={collegeValuesLoading || !collegeValuesQuery.trim()}
            style={{ padding:"5px 10px",borderRadius:6,border:"1px solid rgba(104,211,145,0.25)",background:collegeValuesLoading?"rgba(255,255,255,0.04)":"rgba(104,211,145,0.10)",color:collegeValuesLoading?"#666":"#68d391",fontSize:11,fontWeight:600,cursor:(collegeValuesLoading||!collegeValuesQuery.trim())?"default":"pointer" }}>
            {collegeValuesLoading ? "…" : "Look up"}
          </button>
          {(collegeValues || collegeValuesQuery) && !collegeValuesLoading && (
            <button
              onClick={() => { setCollegeValues(null); setCollegeValuesQuery(""); }}
              title="Clear and start a new search"
              style={{ padding:"5px 8px",borderRadius:6,border:"1px solid rgba(255,255,255,0.06)",background:"transparent",color:"#6a6a7a",fontSize:11,cursor:"pointer" }}
            >✕</button>
          )}
        </div>
        {/* Optional official-page URL — needed for non-US universities
            (not in the US College Scorecard) and schools whose sites
            block the homepage crawl. Academic hosts only (.edu / .ac.xx /
            .edu.xx); the backend rejects anything else. */}
        <input
          value={collegeValuesHint}
          onChange={e => setCollegeValuesHint(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && collegeValuesQuery.trim()) lookupCollege(collegeValuesQuery.trim(), collegeValuesHint.trim() || undefined); }}
          placeholder="Official page URL (optional — for non-US schools, use an .edu / .ac.xx page)"
          style={{ width:"100%",padding:"5px 9px",borderRadius:6,border:"1px solid rgba(255,255,255,0.05)",background:"rgba(255,255,255,0.015)",color:"#999",fontSize:10,outline:"none",marginTop:-2,marginBottom:4,boxSizing:"border-box" }}
        />
        {/* Tip: be specific about campus to avoid branch confusion */}
        <div style={{fontSize:9,color:"#555",marginTop:0,marginBottom:6,fontStyle:"italic"}}>
          For multi-campus systems, name the specific campus (e.g. "UC Berkeley", not "University of California").
        </div>
        {/* Clear server-side cache button — useful when a previous
            extraction was wrong (branch confusion) and the cache TTL
            hasn't expired. Scoped to this account's entries only. */}
        <button
          onClick={async () => {
            if (!confirm("Clear all cached college values for this account? Future lookups will re-extract from the web.")) return;
            const token = window.__CC_SESSION_TOKEN__;
            try {
              const r = await fetch("/api/colleges/values", {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
              });
              const body = await r.json().catch(() => ({}));
              if (r.ok) {
                setCollegeValues(null);
                setCollegeValuesQuery("");
                alert(`Cleared ${body.deleted ?? 0} cached college values. Next lookup will re-extract.`);
              } else {
                alert(`Clear failed: ${body.error || `HTTP ${r.status}`}`);
              }
            } catch (err) {
              alert(`Clear failed: ${err?.message || "unknown"}`);
            }
          }}
          style={{fontSize:9,color:"#6a8ab5",background:"transparent",border:"1px solid rgba(106,138,181,0.15)",borderRadius:5,padding:"3px 8px",cursor:"pointer",marginBottom:8}}
        >
          ↺ Clear cached college values
        </button>
        {collegeValues && !collegeValues.error && (
          <CalibratedFitCard
            collegeValues={collegeValues}
            positioning={collegePositioning}
            loading={collegePositioningLoading}
            locale={locale}
            isTarget={targetSchools.some(s => s.toLowerCase() === String(collegeValues.displayName||"").toLowerCase())}
            onAddTarget={() => addTargetSchool(collegeValues.displayName)}
            verification={collegeVerification}
            verifying={collegeVerifying}
            onVerify={() => verifyCollegeFit(collegeValues.displayName, Boolean(collegeVerification))}
          />
        )}
        {collegeValues?.error && (
          <div style={{fontSize:10,color:"#fc8181",padding:"6px 8px",borderRadius:6,background:"rgba(245,101,101,0.05)",border:"1px solid rgba(245,101,101,0.15)",marginBottom:14}}>
            {collegeValues.error}
          </div>
        )}

        </SidebarSection>
        <SidebarSection id="profile" title="Profile">
        <div style={{display:"flex",gap:8,marginBottom:12}}>
          <button onClick={()=>openProfileEditor(0)} style={{padding:"7px 10px",borderRadius:8,border:"1px solid rgba(55,138,221,0.18)",background:"rgba(55,138,221,0.08)",color:"#63b3ed",fontSize:11,cursor:"pointer"}}>Edit profile</button>
          {Object.keys(data?.chatMemory || {}).length > 0 && (
            <button
              onClick={() => { if (confirm("Clear the counselor's cached conversation highlights? Chat history itself is kept.")) setData(prev => ({ ...prev, chatMemory: {} })); }}
              title="The counselor caches highlights of recent conversations (in your encrypted vault) to stay consistent across chats. Clear them if they've gone stale."
              style={{padding:"7px 10px",borderRadius:8,border:"1px solid rgba(255,255,255,0.08)",background:"transparent",color:"#8a8a9a",fontSize:11,cursor:"pointer"}}
            >Clear AI memory</button>
          )}
          {/* Transparency: weights, thresholds, and live "data as of"
              freshness (models + college data). Opens the methodology as an
              in-app popup (same overlay as Disclosures). */}
          <button
            onClick={() => setActivePanel("methodology")}
            title="See the weights, data sources, and how fresh each source is"
            style={{padding:"7px 10px",borderRadius:8,border:"1px solid rgba(167,139,250,0.20)",background:"rgba(167,139,250,0.08)",color:"#a78bfa",fontSize:11,cursor:"pointer"}}
          >
            How scoring works
          </button>
        </div>
        {editingField === "gpa" ? (
          <div style={{ background:"rgba(55,138,221,0.08)",borderRadius:10,padding:12,marginBottom:12,border:"1px solid rgba(55,138,221,0.3)" }}>
            <div style={{ fontSize:11,color:"#6a8ab5",marginBottom:6 }}>GPA (unweighted / weighted)</div>
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              <input autoFocus value={draftA} onChange={e=>setDraftA(e.target.value)}
                onKeyDown={e=>{ if(e.key==="Enter"){ commitProfile(p=>{ const uw=parseFloat(draftA); const w=parseFloat(draftB); p.gpa={ unweighted: Number.isFinite(uw)?uw:(p.gpa?.unweighted ?? null), weighted: Number.isFinite(w)?w:(draftB.trim()===""?null:(p.gpa?.weighted ?? null)) }; }); } else if(e.key==="Escape") setEditingField(null); }}
                placeholder="3.92" style={{width:64,padding:"4px 8px",borderRadius:6,border:"1px solid rgba(55,138,221,0.4)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:14,outline:"none"}} />
              <span style={{color:"#6a8ab5"}}>/</span>
              <input value={draftB} onChange={e=>setDraftB(e.target.value)}
                onKeyDown={e=>{ if(e.key==="Enter"){ commitProfile(p=>{ const uw=parseFloat(draftA); const w=parseFloat(draftB); p.gpa={ unweighted: Number.isFinite(uw)?uw:(p.gpa?.unweighted ?? null), weighted: Number.isFinite(w)?w:(draftB.trim()===""?null:(p.gpa?.weighted ?? null)) }; }); } else if(e.key==="Escape") setEditingField(null); }}
                placeholder="—" style={{width:64,padding:"4px 8px",borderRadius:6,border:"1px solid rgba(55,138,221,0.4)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:14,outline:"none"}} />
              <button onClick={()=>commitProfile(p=>{ const uw=parseFloat(draftA); const w=parseFloat(draftB); p.gpa={ unweighted: Number.isFinite(uw)?uw:(p.gpa?.unweighted ?? null), weighted: Number.isFinite(w)?w:(draftB.trim()===""?null:(p.gpa?.weighted ?? null)) }; })} style={{padding:"4px 8px",borderRadius:6,border:"none",background:"rgba(104,211,145,0.15)",color:"#68d391",fontSize:11,cursor:"pointer"}}>Save</button>
            </div>
          </div>
        ) : profile.gpa ? (
          <div onDoubleClick={()=>beginEdit("gpa", profile.gpa.unweighted ?? "", profile.gpa.weighted ?? "")} title="Double-click to edit"
            style={{ background:"rgba(55,138,221,0.08)",borderRadius:10,padding:12,marginBottom:12,border:"1px solid rgba(55,138,221,0.15)",cursor:"pointer",userSelect:"none" }}>
            <div style={{ fontSize:11,color:"#6a8ab5" }}>GPA</div>
            <div style={{ fontSize:22,fontWeight:700,color:"#63b3ed" }}>{profile.gpa.unweighted}{profile.gpa.weighted?` / ${profile.gpa.weighted}w`:""}</div>
          </div>
        ) : <p onDoubleClick={()=>beginEdit("gpa","","")} title="Double-click to add" style={{ fontSize:12,color:"#444",margin:"0 0 12px",cursor:"pointer" }}>{profile.gpaStatus === "pending" ? "GPA not available yet." : "Tell the agent your GPA."}</p>}

        {/* Class rank: compared with a school's C10 shares in College Fit. */}
        {editingField === "rank" ? (
          <ClassRankEditor initial={profile.classRank || null}
            onSave={(rank)=>commitProfile(p=>{ p.classRank = rank; })}
            onCancel={()=>setEditingField(null)}
            onDelete={profile.classRank ? ()=>commitProfile(p=>{ delete p.classRank; }) : null} />
        ) : profile.classRank ? (
          <div onDoubleClick={()=>beginEdit("rank")} title="Double-click or use the pencil to edit"
            style={{ background:"rgba(55,138,221,0.06)",borderRadius:10,padding:"8px 12px",marginBottom:12,border:"1px solid rgba(55,138,221,0.12)",cursor:"pointer",userSelect:"none",display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <div>
              <div style={{ fontSize:11,color:"#6a8ab5" }}>Class rank</div>
              <div style={{ fontSize:13,fontWeight:600,color:"#63b3ed" }}>{formatClassRank(profile.classRank)}</div>
            </div>
            <button type="button" aria-label="Edit class rank" onClick={()=>beginEdit("rank")} style={{ background:"none",border:"none",color:"#6a8ab5",cursor:"pointer",fontSize:12,padding:"0 2px" }}>✎</button>
          </div>
        ) : (
          <button type="button" onClick={()=>beginEdit("rank")} style={{ marginBottom:12,fontSize:11,color:"#63b3ed",background:"rgba(55,138,221,0.06)",border:"1px solid rgba(55,138,221,0.18)",borderRadius:8,padding:"6px 10px",cursor:"pointer",width:"100%" }}>
            + Add class rank
          </button>
        )}

        {/* Auto-calculate GPA from the courses list (unweighted 4.0 +
            weighted with AP/IB/dual +1.0, honors +0.5). */}
        {profile.courses?.length > 0 && (
          <button
            onClick={() => {
              const g = computeGpaFromCourses(profile.courses);
              if (!g) { alert("Add courses with letter/number grades first — none of the current courses have a gradeable mark."); return; }
              commitProfile(p => { p.gpa = { unweighted: g.unweighted, weighted: g.weighted }; });
            }}
            title="Compute unweighted + weighted GPA from your course grades"
            style={{ marginBottom:12, fontSize:11, color:"#63b3ed", background:"rgba(55,138,221,0.08)", border:"1px solid rgba(55,138,221,0.25)", borderRadius:8, padding:"6px 10px", cursor:"pointer", width:"100%" }}
          >
            🧮 Calculate GPA from courses
          </button>
        )}

        {/* Standardized tests: every entry (total, sections, date, subject)
            is editable in place, removable, and new ones can be added. */}
        {(profile.testScores || []).map((t,i)=>(
          editingField === `test:${i}` ? (
            <TestScoreEditor key={i} initial={t}
              onSave={(entry)=>commitProfile(p=>{ const ts=[...(p.testScores||[])]; ts[i]=entry; p.testScores=ts; })}
              onCancel={()=>setEditingField(null)}
              onDelete={()=>commitProfile(p=>{ p.testScores=(p.testScores||[]).filter((_,j)=>j!==i); })} />
          ) : (
            <div key={i} onDoubleClick={()=>beginEdit(`test:${i}`)} title="Double-click or use the pencil to edit"
              style={{ background:"rgba(127,119,221,0.08)",borderRadius:10,padding:12,marginBottom:12,border:"1px solid rgba(127,119,221,0.15)",cursor:"pointer",userSelect:"none" }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                <div style={{ fontSize:11,color:"#9a94d4" }}>{testLabel(t.test)}{t.subject?` · ${t.subject}`:""}{t.date?` · ${t.date}`:""}</div>
                <button type="button" aria-label={`Edit ${testLabel(t.test)} score`} onClick={()=>beginEdit(`test:${i}`)} style={{ background:"none",border:"none",color:"#9a94d4",cursor:"pointer",fontSize:12,padding:"0 2px" }}>✎</button>
              </div>
              <div style={{ fontSize:22,fontWeight:700,color:"#afa9ec" }}>{t.totalScore}</div>
              {formatSections(t, { short: true }) && (
                <div style={{ fontSize:11,color:"#9a94d4",marginTop:2 }}>{formatSections(t, { short: true })}</div>
              )}
            </div>
          )
        ))}
        {editingField === "test:new" ? (
          <TestScoreEditor initial={null}
            onSave={(entry)=>commitProfile(p=>{ p.testScores=[...(p.testScores||[]), entry]; })}
            onCancel={()=>setEditingField(null)} />
        ) : (
          <button type="button" onClick={()=>beginEdit("test:new")} style={{ marginBottom:12,fontSize:11,color:"#afa9ec",background:"rgba(127,119,221,0.08)",border:"1px solid rgba(127,119,221,0.25)",borderRadius:8,padding:"6px 10px",cursor:"pointer",width:"100%" }}>
            + Add test score
          </button>
        )}

        </SidebarSection>
        {profile.courses?.length > 0 && (
          <SidebarSection id="courses" title="Courses" count={profile.courses.length}>
          {(showAllCourses ? profile.courses : profile.courses.slice(0,5)).map((c,i)=>(
            editingField === `course:${i}` ? (
              <div key={i} style={{ display:"flex",gap:6,alignItems:"center",padding:"4px 0",borderBottom:"1px solid rgba(255,255,255,0.03)" }}>
                <input autoFocus value={draftA} onChange={e=>setDraftA(e.target.value)}
                  onKeyDown={e=>{ if(e.key==="Enter"){ commitProfile(p=>{ const cs=[...(p.courses||[])]; cs[i]={...cs[i], name: draftA.trim()||cs[i].name, grade: draftB.trim()}; p.courses=cs; }); } else if(e.key==="Escape") setEditingField(null); }}
                  placeholder="Course name" style={{flex:1,minWidth:0,padding:"4px 8px",borderRadius:6,border:"1px solid rgba(99,179,237,0.4)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:12,outline:"none"}} />
                <input value={draftB} onChange={e=>setDraftB(e.target.value)}
                  onKeyDown={e=>{ if(e.key==="Enter"){ commitProfile(p=>{ const cs=[...(p.courses||[])]; cs[i]={...cs[i], name: draftA.trim()||cs[i].name, grade: draftB.trim()}; p.courses=cs; }); } else if(e.key==="Escape") setEditingField(null); }}
                  placeholder="A" style={{width:48,padding:"4px 6px",borderRadius:6,border:"1px solid rgba(99,179,237,0.4)",background:"rgba(255,255,255,0.06)",color:"#fff",fontSize:12,outline:"none"}} />
                <button onClick={()=>commitProfile(p=>{ const cs=[...(p.courses||[])]; cs[i]={...cs[i], name: draftA.trim()||cs[i].name, grade: draftB.trim()}; p.courses=cs; })} style={{padding:"4px 8px",borderRadius:6,border:"none",background:"rgba(104,211,145,0.15)",color:"#68d391",fontSize:11,cursor:"pointer"}}>Save</button>
              </div>
            ) : (
              <div key={i} onDoubleClick={()=>beginEdit(`course:${i}`, c.name ?? "", c.grade ?? "")} title="Double-click to edit"
                style={{ fontSize:12,padding:"4px 0",borderBottom:"1px solid rgba(255,255,255,0.03)",display:"flex",justifyContent:"space-between",cursor:"pointer",userSelect:"none" }}>
                <span><span style={{color:c.type==="ap"?"#f6ad55":"#666"}}>{c.type==="ap" && !/^ap\s+/i.test(String(c.name || ""))?"AP ":""}</span>{c.name}</span>
                <span style={{color:"#63b3ed",fontWeight:600}}>{c.grade}</span>
              </div>
            )
          ))}
          {profile.courses.length > 5 && (
            <button onClick={()=>setShowAllCourses(v=>!v)} style={{ marginTop:6,fontSize:10.5,color:"#6a8ab5",background:"transparent",border:"1px solid rgba(99,179,237,0.18)",borderRadius:6,padding:"3px 9px",cursor:"pointer" }}>
              {showAllCourses ? "Show less" : `Show all ${profile.courses.length}`}
            </button>
          )}
          </SidebarSection>
        )}

        {/* AP exam scores: editable in place (exam, score, year), removable,
            and addable — no survey round-trip. */}
        <SidebarSection id="ap-scores" title="AP exam scores" count={(profile.apScores || []).length}>
        {(profile.apScores || []).map((x,i)=>(
          editingField === `ap:${i}` ? (
            <ApScoreEditor key={i} initial={x}
              onSave={(entry)=>commitProfile(p=>{ const a=[...(p.apScores||[])]; a[i]=entry; p.apScores=a; })}
              onCancel={()=>setEditingField(null)}
              onDelete={()=>commitProfile(p=>{ p.apScores=(p.apScores||[]).filter((_,j)=>j!==i); })} />
          ) : (
            <div key={i} onDoubleClick={()=>beginEdit(`ap:${i}`)} title="Double-click or use the pencil to edit"
              style={{ fontSize:12,padding:"4px 0",borderBottom:"1px solid rgba(255,255,255,0.03)",display:"flex",justifyContent:"space-between",alignItems:"center",gap:6,cursor:"pointer",userSelect:"none" }}>
              <span><span style={{color:"#f6ad55"}}>AP </span>{x.exam || x.subject || x.name}{x.year ? <span style={{color:"#666"}}> · {x.year}</span> : null}</span>
              <span style={{display:"flex",alignItems:"center",gap:6}}>
                <span style={{color:"#f6ad55",fontWeight:600}}>{x.score}</span>
                <button type="button" aria-label={`Edit AP ${x.exam || x.subject || x.name} score`} onClick={()=>beginEdit(`ap:${i}`)} style={{ background:"none",border:"none",color:"#f6ad55",cursor:"pointer",fontSize:12,padding:"0 2px" }}>✎</button>
              </span>
            </div>
          )
        ))}
        {editingField === "ap:new" ? (
          <ApScoreEditor initial={null}
            onSave={(entry)=>commitProfile(p=>{ p.apScores=[...(p.apScores||[]), entry]; })}
            onCancel={()=>setEditingField(null)} />
        ) : (
          <button type="button" onClick={()=>beginEdit("ap:new")} style={{ marginTop:6,fontSize:11,color:"#f6ad55",background:"rgba(246,173,85,0.08)",border:"1px solid rgba(246,173,85,0.25)",borderRadius:8,padding:"6px 10px",cursor:"pointer",width:"100%" }}>
            + Add AP score
          </button>
        )}

        </SidebarSection>
        <SidebarSection id="ecs" title="ECs" count={activities.length}>
        {/* Files attached in chat (certificates, letters, write-ups) are
            filed to the activity they name as they arrive; this reads the
            older ones in and says what was linked. */}
        {activities.length > 0 && <ChatEvidenceSync onLinked={() => setEvidenceVersion((v) => v + 1)} />}
        {activities.length > 0 ? (showAllECs ? activities : activities.slice(0,4)).map((a,i)=>(
          <div key={i} style={{ fontSize:12,padding:"5px 0",borderBottom:"1px solid rgba(255,255,255,0.03)" }}>
            {/* Click row to expand prestige rationale (Round 2 F5).      */}
            {/* PrestigeCard self-fetches /api/ec/strength/:name/prestige  */}
            {/* on mount; toggling expandedEC remounts it for that EC.    */}
            <div
              onClick={() => setExpandedEC(expandedEC === i ? null : i)}
              onDoubleClick={() => editECFromProfile(a)}
              title="Click to expand · double-click to edit"
              style={{ cursor:"pointer",display:"flex",alignItems:"center",gap:6,userSelect:"none" }}
            >
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:500 }}>{a.name}</div>
                <div style={{ fontSize:10,color:"#6a6a7a" }}>{a.role} · {a.category}</div>
              </div>
              <span style={{ fontSize:10,color:"#6a6a7a" }}>{expandedEC === i ? "▾" : "▸"}</span>
            </div>
            {expandedEC === i && (
              <div style={{ marginTop:8 }}>
                <PrestigeCard key={evidenceVersion} ecName={a.name} locale={locale} />
                <EcEvidence ecName={a.name} refreshKey={evidenceVersion} />
              </div>
            )}
          </div>
        )) : <p style={{ fontSize:12,color:"#444",margin:0 }}>No activities yet.</p>}
        {activities.length > 4 && (
          <button onClick={()=>setShowAllECs(v=>!v)} style={{ marginTop:6,fontSize:10.5,color:"#6a8ab5",background:"transparent",border:"1px solid rgba(99,179,237,0.18)",borderRadius:6,padding:"3px 9px",cursor:"pointer" }}>
            {showAllECs ? "Show less" : `Show all ${activities.length}`}
          </button>
        )}

        </SidebarSection>
        {/* Uploaded documents: the survey transcript and every file attached in chat. */}
        {(data.documents||[]).length > 0 && (
          <SidebarSection id="documents" title="Documents" count={data.documents.length}>
          {data.documents.map((doc,i)=>(
            <div key={i} style={{ fontSize:12,padding:"6px 0",borderBottom:"1px solid rgba(255,255,255,0.03)",display:"flex",alignItems:"center",gap:8 }}>
              <span style={{ fontSize:14 }}>{doc.type==="pdf"?"📄":doc.type==="image"?"🖼️":"📋"}</span>
              <div style={{ flex:1,minWidth:0 }}>
                <div style={{ fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{doc.name}</div>
                <div style={{ fontSize:10,color:"#555" }}>{doc.category}{doc.academicYear ? ` · ${formatAcademicYearLabel(doc.academicYear)}` : ""} · {new Date(doc.uploadedAt).toLocaleDateString()}</div>
              </div>
              <button onClick={()=>{setData(prev=>({...prev,documents:(prev.documents||[]).filter((_,j)=>j!==i)}));}} style={{ background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:11,padding:"2px 4px" }}>✕</button>
            </div>
          ))}
          </SidebarSection>
        )}

        {/* ─── Target schools (shared across the chat tools) ─── */}
        {/* Named universities the student is aiming for. Read by Rank EC   */}
        {/* ideas, Edit your story, and Course plan to tailor output to     */}
        {/* what these schools value. The survey only captures college      */}
        {/* TYPES, so named targets live here (persisted per account).      */}
        <SidebarSection id="targets" title="🎯 Target schools">
        <div style={{ fontSize:10,color:"#555",marginBottom:8,lineHeight:1.5 }}>Used to tailor Rank EC ideas, Edit your story &amp; Course plan.</div>
        <div style={{ display:"flex",flexWrap:"wrap",gap:6,marginBottom:8 }}>
          {targetSchools.length === 0 && (
            <span style={{ fontSize:11,color:"#6a6a7a",lineHeight:1.5 }}>
              No targets yet — add the schools you're aiming for, then tap any one to see its fit.
            </span>
          )}
          {targetSchools.map((s)=>(
            <span key={s} style={{ display:"inline-flex",alignItems:"center",gap:6,padding:"3px 8px",borderRadius:12,background:"rgba(167,139,250,0.10)",border:"1px solid rgba(167,139,250,0.25)",fontSize:11,color:"#c4b5fd" }}>
              <button
                onClick={()=>{ setCollegeValuesQuery(s); lookupCollege(s); }}
                title="See College Fit for this school"
                aria-label={`See College Fit for ${s}`}
                style={{ background:"none",border:"none",color:"#c4b5fd",cursor:"pointer",fontSize:11,padding:0,textDecoration:"underline",textDecorationStyle:"dotted" }}
              >{s}</button>
              <button onClick={()=>removeTargetSchool(s)} title="Remove" aria-label={`Remove ${s}`} style={{ background:"none",border:"none",color:"#c4b5fd",cursor:"pointer",fontSize:12,padding:0,lineHeight:1 }}>✕</button>
            </span>
          ))}
        </div>
        {targetSchools.length > 0 && (
          <div style={{ fontSize:10,color:"#6a6a7a",marginBottom:8,lineHeight:1.5 }}>
            {targetSchools.length} target{targetSchools.length>1?"s":""} · tap a school to check its fit — aim for a mix of reach, target &amp; safety schools.
          </div>
        )}
        <div style={{ display:"flex",gap:6,marginBottom:14 }}>
          <input
            value={targetSchoolInput}
            onChange={(e)=>setTargetSchoolInput(e.target.value)}
            onKeyDown={(e)=>{ if(e.key==="Enter"){ e.preventDefault(); addTargetSchool(targetSchoolInput); } }}
            placeholder="Add a university…"
            aria-label="Add a target university"
            style={{ flex:1,padding:"6px 10px",borderRadius:8,border:"1px solid rgba(255,255,255,0.08)",background:"rgba(255,255,255,0.03)",color:"#e8e6e3",fontSize:12,outline:"none" }}
          />
          <button onClick={()=>addTargetSchool(targetSchoolInput)} disabled={!targetSchoolInput.trim()} style={{ padding:"6px 12px",borderRadius:8,border:"1px solid rgba(167,139,250,0.25)",background:"rgba(167,139,250,0.08)",color:"#c4b5fd",fontSize:12,cursor:targetSchoolInput.trim()?"pointer":"default" }}>Add</button>
        </div>

        {/* ─── Round 1-5 tools (narrative, candidates, deadlines) ─── */}
        {/* Three buttons that pop a full panel into <activePanel/>. The     */}
        {/* student stays in the chat — the panel renders as an overlay so  */}
        {/* they don't lose their conversation context.                     */}
        </SidebarSection>
        <SidebarSection id="tools" title="Tools">
        {/* Edit story / Rank ECs / Spike / Course plan now launch INLINE  */}
        {/* in the chat (see the launcher row above the composer). Only    */}
        {/* Deadlines remains as a sidebar modal.                          */}
        <div style={{ display:"flex",flexDirection:"column",gap:6,marginBottom:14 }}>
          <button onClick={()=>setActivePanel("deadlines")} style={sidebarToolBtn}>
            {tt(locale, "chat.tools.deadlines")}
          </button>
          <button onClick={()=>setActivePanel("disclosure")} style={sidebarToolBtn}>
            {tt(locale, "chat.tools.disclosure")}
          </button>
        </div>

        {/* ─── Locale toggle (Round 5) ─── */}
        {/* Persists to localStorage; api.js reads from there for every    */}
        {/* request, so backend friendlyMessage / friendlyLegendI18n flips */}
        {/* immediately on the next call.                                   */}
        </SidebarSection>
        <SidebarSection id="language" title={tt(locale, "locale.label")}>
        <div style={{ display:"flex",gap:6 }}>
          <button onClick={()=>setLocale("en-US")} style={{ ...localeBtn, ...(locale==="en-US"?localeBtnActive:{}) }}>
            {tt(locale, "locale.en")}
          </button>
          <button onClick={()=>setLocale("ko")} style={{ ...localeBtn, ...(locale==="ko"?localeBtnActive:{}) }}>
            {tt(locale, "locale.ko")}
          </button>
        </div>
        </SidebarSection>

      </div>
    </aside>
  );
}
