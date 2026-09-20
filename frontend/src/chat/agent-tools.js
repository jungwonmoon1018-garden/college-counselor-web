// agent-tools.js — execTool, the client-side tool runner the agents call.
// Moved out of App.jsx on 2026-09-20.
import { IPEDS, AP_RIGOR, EC_MAJOR_RELEVANCE, analyzeECStrength, contextualizeSAT } from "../profile/profile-analysis.js";

// ═══════════════════════════════════════════════════════════
// TOOL EXECUTION
// ═══════════════════════════════════════════════════════════
export async function execTool(name, input, stateRef, setData) {
  const data = stateRef.current;
  const commitData = (nextData) => {
    stateRef.current = nextData;
    setData(nextData);
  };
  const matchesActivity = (item, target) => {
    if (!target) return false;
    if (target.id) return item.id === target.id;
    return Boolean(target.name) && item.name === target.name;
  };
  const matchesProfileItem = (item, target, keys) => {
    if (!target) return false;
    if (target.id) return item.id === target.id;
    const providedKeys = keys.filter(key => target[key] !== undefined);
    return providedKeys.length > 0 && providedKeys.every(key => item?.[key] === target[key]);
  };
  switch (name) {
    case "get_student_profile": return { profile: data.profile || { gpa:null,courses:[],apScores:[],testScores:[] } };
    case "update_student_profile": {
      const currentProfile = data.profile || {gpa:null,courses:[],apScores:[],testScores:[]};
      const p = {
        ...currentProfile,
        courses: [...(currentProfile.courses || [])],
        apScores: [...(currentProfile.apScores || [])],
        testScores: [...(currentProfile.testScores || [])]
      };
      const {field,action,data:d}=input;
      if(field==="gpa"&&action==="set")p.gpa=d;
      else if(field==="courses"&&action==="set")p.courses=Array.isArray(d)?d:[d];
      else if(field==="courses"&&action==="add")p.courses=[...(p.courses||[]),d];
      else if(field==="courses"&&action==="remove")p.courses=(p.courses||[]).filter(c=>!matchesProfileItem(c,d,["name","year"]));
      else if(field==="ap_scores"&&action==="set")p.apScores=Array.isArray(d)?d:[d];
      else if(field==="ap_scores"&&action==="add")p.apScores=[...(p.apScores||[]),d];
      else if(field==="ap_scores"&&action==="remove")p.apScores=(p.apScores||[]).filter(a=>!matchesProfileItem(a,d,["exam","year","score"]));
      else if(field==="test_scores"&&action==="set")p.testScores=Array.isArray(d)?d:[d];
      else if(field==="test_scores"&&action==="add")p.testScores=[...(p.testScores||[]),d];
      else if(field==="test_scores"&&action==="remove")p.testScores=(p.testScores||[]).filter(t=>!matchesProfileItem(t,d,["test","date","subject","totalScore"]));
      else return {success:false,error:`Unsupported profile update: ${field}/${action}`};
      const nextData = {...data,profile:p};
      commitData(nextData);
      return {success:true,updated:field,profile:p};
    }
    case "get_extracurriculars": return { activities: data.activities||[] };
    case "update_extracurriculars": {
      const a=[...(data.activities||[])];
      if(input.action==="add")a.push({...input.activity,id:input.activity?.id||crypto.randomUUID()});
      else if(input.action==="update"){
        const i=a.findIndex(x=>matchesActivity(x,input.activity));
        if(i<0)return {success:false,error:"Activity not found"};
        a[i]={...a[i],...input.activity,id:a[i].id||input.activity.id||crypto.randomUUID()};
      } else if(input.action==="remove"){
        const i=a.findIndex(x=>matchesActivity(x,input.activity));
        if(i<0)return {success:false,error:"Activity not found"};
        a.splice(i,1);
      } else return {success:false,error:`Unsupported extracurricular action: ${input.action}`};
      const nextData = {...data,activities:a};
      commitData(nextData);
      return {success:true,count:a.length,activities:a};
    }
    case "search_colleges": {
      // Route through backend /api/colleges/search for 2000+ colleges with Scorecard integration
      const proxyUrl = window.__CC_PROXY_URL__;
      const token = window.__CC_SESSION_TOKEN__;
      if (proxyUrl) {
        try {
          const base = proxyUrl.replace(/\/chat\/?$/,"");
          const searchRes = await fetch(`${base}/colleges/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(token ? { "Authorization": `Bearer ${token}` } : {}) },
            body: JSON.stringify({ name: input.majorKeyword, states: input.states, minSAT: input.satMin, maxTuition: input.maxTuition, sizePreference: input.sizePreference, limit: 10 })
          });
          if (searchRes.ok) {
            const backendResult = await searchRes.json();
            return { source: "NCES IPEDS + College Scorecard", sourceUrl: "https://nces.ed.gov/ipeds/", results: backendResult.results || backendResult };
          }
        } catch (err) { console.warn("[search_colleges] Backend unavailable, using local IPEDS:", err?.message); }
      }
      // Fallback: local IPEDS data (18 colleges)
      let r=[...IPEDS];
      if(input.satMin)r=r.filter(c=>c.sat75>=input.satMin);
      if(input.satMax)r=r.filter(c=>c.sat25<=input.satMax);
      if(input.states?.length)r=r.filter(c=>input.states.includes(c.state));
      if(input.maxTuition)r=r.filter(c=>c.tuitionIn<=input.maxTuition||c.tuitionOut<=input.maxTuition);
      if(input.sizePreference==="small")r=r.filter(c=>c.enroll<10000);
      else if(input.sizePreference==="medium")r=r.filter(c=>c.enroll>=10000&&c.enroll<25000);
      else if(input.sizePreference==="large")r=r.filter(c=>c.enroll>=25000);
      if(input.majorKeyword){const kw=input.majorKeyword.toLowerCase();r=r.filter(c=>(c.majors||[]).some(m=>m.toLowerCase().includes(kw)));}
      const satEntry = (data.profile?.testScores || []).find(t => t.test === "sat");
      const actEntry = !satEntry ? (data.profile?.testScores || []).find(t => t.test === "act") : null;
      const actToSat = {36:1590,35:1570,34:1550,33:1520,32:1500,31:1480,30:1450,29:1420,28:1390,27:1360,26:1330,25:1300,24:1260,23:1230,22:1200,21:1160,20:1130,19:1100,18:1060,17:1030,16:990,15:960,14:920,13:880,12:840,11:800,10:760,9:720};
      const convertACT = (act) => { const clamped = Math.max(9, Math.min(36, Math.round(act))); return actToSat[clamped] || 1000; };
      const sat = satEntry ? satEntry.totalScore : actEntry ? convertACT(actEntry.totalScore) : null;
      r=r.map(c=>({...c,fitScore:sat?Math.max(0,Math.round(100-Math.abs(sat-(c.sat25+c.sat75)/2)/5)):50})).sort((a,b)=>b.fitScore-a.fitScore).slice(0,10);
      return {source:"NCES IPEDS (local fallback)",sourceUrl:"https://nces.ed.gov/ipeds/",results:r};
    }
    case "generate_study_notes": {
      const n=[...(data.studyNotes||[]),{...input,id:crypto.randomUUID(),createdAt:new Date().toISOString()}];
      const nextData = {...data,studyNotes:n};
      commitData(nextData);
      return {saved:true,subject:input.subject};
    }
    case "suggest_ecs": {
      const interests = (input.interests || []).map(i => i.toLowerCase());
      const existing = (data.activities || []).map(a => (a.name || "").toLowerCase());
      // Build suggestions from EC_MAJOR_RELEVANCE based on interests
      const suggestions = [];
      for (const [majorKey, cats] of Object.entries(EC_MAJOR_RELEVANCE)) {
        const majorLower = majorKey.toLowerCase();
        if (interests.some(i => majorLower.includes(i) || i.includes(majorLower.split("/")[0]))) {
          for (const ec of [...cats.strong, ...cats.good].slice(0, 6)) {
            if (!existing.some(e => { const ecLower = ec.toLowerCase(); return e.includes(ecLower) || ecLower.includes(e); }) && suggestions.length < 5) {
              const isStrong = cats.strong.includes(ec);
              suggestions.push({ name: ec, category: "club", why: `${isStrong ? "Strongly" : "Well"} aligned with ${majorKey}`, commitment: isStrong ? "5-8 hrs/week" : "2-4 hrs/week" });
            }
          }
        }
      }
      // Fallback if no interest match
      if (suggestions.length === 0) {
        suggestions.push(
          {name:"Debate Club",category:"club",why:"Builds critical thinking and public speaking",commitment:"3-5 hrs/week"},
          {name:"Peer Tutoring",category:"community_service",why:"Shows mastery and leadership",commitment:"2-4 hrs/week"},
          {name:"Research with a professor",category:"research",why:"Demonstrates intellectual curiosity",commitment:"5-8 hrs/week summer"},
        );
      }
      // Filter by available hours if specified
      const maxHrs = input.hoursAvailable || 999;
      const filtered = suggestions.filter(s => {
        const hrs = parseInt(s.commitment) || 4;
        return hrs <= maxHrs;
      });
      return { suggestions: filtered.length ? filtered : suggestions.slice(0, 3), note: `Personalized for: ${interests.join(", ") || "general interests"}.` };
    }

    case "get_ap_rigor": {
      const courses = input.courses || [];
      const results = courses.map(c => {
        const cNorm = c.toLowerCase().replace(/^ap\s+/, "").trim();
        // Prefer exact match, then best substring match (longest key wins to avoid "Physics" matching before "Physics C: E&M")
        const exactKey = Object.keys(AP_RIGOR).find(k => k.toLowerCase().replace(/^ap\s+/, "").trim() === cNorm);
        const partialKeys = Object.keys(AP_RIGOR).filter(k => {
          const kNorm = k.toLowerCase();
          return kNorm.includes(cNorm) || cNorm.includes(kNorm.replace(/^ap\s+/, "").trim());
        }).sort((a, b) => b.length - a.length); // longest match first to prefer specificity
        const key = exactKey || partialKeys[0] || null;
        if (!key) return { course: c, found: false, note: "Not found in CollegeBoard database" };
        const d = AP_RIGOR[key];
        return { course: key, found: true, tier: d.tier, label: d.label, pct5: d.pct5, pct3plus: d.pct3plus, meanScore: d.meanScore, note: d.note, source: "CollegeBoard AP Score Distributions 2026 (preliminary)" };
      });
      // Sort by tier (hardest first) for comparison
      results.sort((a, b) => (a.tier || 99) - (b.tier || 99));
      const tierExplain = { 1:"Extremely Hard — few students score 5. Strongest signal of rigor.", 2:"Very Hard — challenging for most students. Strong rigor signal.", 3:"Hard — significant preparation needed. Good rigor signal.", 4:"Moderate — accessible with effort. Standard AP rigor.", 5:"Introductory — good entry to AP. Less weight in rigor evaluation." };
      return { results, tierScale: tierExplain, source: "CollegeBoard AP Score Distributions 2026 (preliminary)", note: "Tier rankings based on % scoring 5 and mean scores. Self-selection effects noted where relevant." };
    }

    case "get_sat_context": {
      const result = contextualizeSAT(input.score, input.state, input.region);
      return result || { error: "Could not analyze score" };
    }

    case "analyze_ec_strength": {
      const activities = data.activities || [];
      const majorInterest = data.majorInterest || data.profile?.majorInterest || "";
      const goals = data.goals || [];
      return analyzeECStrength(activities, majorInterest, goals);
    }
    // ═══════════════════════════════════════════════════════════
    // RAG TOOLS — fetch context from backend
    // ═══════════════════════════════════════════════════════════
    case "fetch_rag_context": {
      const proxyUrl = window.__CC_PROXY_URL__;
      const token = window.__CC_SESSION_TOKEN__;
      if (!proxyUrl || !token) return { error: "RAG backend not configured", fallback: { profile: data.profile, activities: data.activities } };
      try {
        const r = await fetch(proxyUrl.replace(/\/chat\/?$/,"/rag/context"), {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ agentId: input.agentId || "holistic", queryFocus: input.focus || "holistic" })
        });
        if (!r.ok) return { error: `RAG retrieval failed: ${r.status}`, fallback: { profile: data.profile, activities: data.activities } };
        return await r.json();
      } catch (err) {
        return { error: err?.message, fallback: { profile: data.profile, activities: data.activities } };
      }
    }
    case "fetch_college_match": {
      const proxyUrl = window.__CC_PROXY_URL__;
      const token = window.__CC_SESSION_TOKEN__;
      if (!proxyUrl || !token) return execTool("search_colleges", input, stateRef, setData); // fallback to local
      try {
        const r = await fetch(proxyUrl.replace(/\/chat\/?$/,"/rag/college-match"), {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify(input)
        });
        if (!r.ok) return execTool("search_colleges", input, stateRef, setData); // fallback
        return await r.json();
      } catch {
        return execTool("search_colleges", input, stateRef, setData); // fallback
      }
    }
    case "fetch_student_trends": {
      const proxyUrl = window.__CC_PROXY_URL__;
      const token = window.__CC_SESSION_TOKEN__;
      if (!proxyUrl || !token) return { error: "RAG backend not configured", trends: {} };
      try {
        const r = await fetch(proxyUrl.replace(/\/chat\/?$/,"/students/timeline"), {
          headers: { "Authorization": `Bearer ${token}` }
        });
        if (!r.ok) return { error: `Timeline fetch failed: ${r.status}`, trends: {} };
        return await r.json();
      } catch (err) {
        return { error: err?.message, trends: {} };
      }
    }
    case "fetch_milestones": {
      const proxyUrl = window.__CC_PROXY_URL__;
      const token = window.__CC_SESSION_TOKEN__;
      if (!proxyUrl || !token) return { milestones: [] };
      try {
        const r = await fetch(proxyUrl.replace(/\/chat\/?$/,"/students/milestones"), {
          headers: { "Authorization": `Bearer ${token}` }
        });
        if (!r.ok) return { milestones: [] };
        return await r.json();
      } catch {
        return { milestones: [] };
      }
    }
    default: return {error:`Unknown tool: ${name}`};
  }
}
