// CreateAccountScreen, moved out of App.jsx on 2026-09-16 with the module-level
// helpers only it uses. App passes the state and callbacks it reads as
// one props object (createAccountProps in App.jsx); nothing here writes App state
// except through those callbacks.
import { BG, FONT, GLOBAL_CSS, S, btnPrimary, cardStyle, dots, inputStyle, labelStyle } from "../app-shared.js";
import { getEmailDomain } from "../app-shared.js";

// ═══════════════════════════════════════════════════════════
// SCHOOL EMAIL VALIDATION
// ═══════════════════════════════════════════════════════════
const EDU_DOMAINS = [
  ".edu", ".ac.uk", ".ac.kr", ".ac.jp", ".edu.au", ".edu.cn", ".edu.sg",
  ".edu.my", ".edu.ph", ".edu.hk", ".edu.tw", ".edu.br", ".edu.mx",
  ".edu.co", ".edu.ar", ".ac.in", ".ac.id", ".ac.th", ".ac.nz",
  ".edu.tr", ".edu.sa", ".edu.eg", ".edu.ng", ".edu.za",
  ".k12.us", ".k12.", ".school.", ".sch.",  // K-12 school domains
  // Korean school domains (specific suffixes only — bare .kr is too broad)
  ".or.kr",   // Korean organizational/school domains
  ".hs.kr", ".ms.kr", ".es.kr",  // Korean high/middle/elementary school domains
  ".go.kr",   // Korean government education offices
  ".kr",      // General Korean domains (e.g. school.kr, academy.kr)
  ".org",     // Non-profit / organization school domains
];

function isSchoolEmail(email) {
  if (!email || !email.includes("@")) return false;
  const domain = email.toLowerCase().split("@")[1];
  if (!domain) return false;
  return EDU_DOMAINS.some(suffix => {
    if (suffix.endsWith(".")) {
      // Mid-domain suffixes like ".k12." — require it to appear as a domain segment boundary
      const idx = domain.indexOf(suffix);
      return idx >= 0 && (idx === 0 || domain[idx - 1] === ".");
    }
    return domain.endsWith(suffix);
  });
}

export default function CreateAccountScreen(props) {
  const {
    authBusy,
    cAgeAttest,
    cConsentAI,
    cConsentData,
    cEmail,
    cError,
    cFirst,
    cGrade,
    cLast,
    cPass,
    cPass2,
    createPassStrength,
    handleCreate,
    runAuthGuarded,
    setCAgeAttest,
    setCConsentAI,
    setCConsentData,
    setCEmail,
    setCError,
    setCFirst,
    setCGrade,
    setCLast,
    setCPass,
    setCPass2,
    setScreen,
    setShowCreatePass,
    setShowCreatePass2,
    showCreatePass,
    showCreatePass2,
  } = props;
  return (
    <main style={{ minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",background:BG,fontFamily:FONT,padding:"20px 0" }}>
      <div className="cc-create-card" style={cardStyle}>
        <div style={{ textAlign:"center",marginBottom:32 }}>
          <div style={{ display:"flex",justifyContent:"center",gap:6,marginBottom:14 }}>
            {dots.map((c,i)=>(<div key={i} style={{width:10,height:10,borderRadius:"50%",background:c,animation:`pulse2 2s ease-in-out ${i*0.15}s infinite`}} />))}
          </div>
          <h1 style={{ fontSize:24,fontWeight:700,color:"#e8e6e3",margin:0,letterSpacing:"-0.03em" }}>Create your account</h1>
          <p style={{ fontSize:13,color:"#6a6a7a",marginTop:8 }}>Email required · data encrypted on your device</p>
        </div>

        <form onSubmit={(event)=>{event.preventDefault();runAuthGuarded(handleCreate, setCError);}} style={{ display:"flex",flexDirection:"column",gap:14 }}>
          <div style={{ display:"flex",gap:10 }}>
            <div style={{ flex:1 }}>
              <label htmlFor="create-first" style={labelStyle}>First name</label>
              <input id="create-first" value={cFirst} onChange={e=>setCFirst(e.target.value)} placeholder="Alex"
                     name="given-name" autoComplete="given-name" autoCapitalize="words" style={inputStyle} />
            </div>
            <div style={{ flex:1 }}>
              <label htmlFor="create-last" style={labelStyle}>Last name</label>
              <input id="create-last" value={cLast} onChange={e=>setCLast(e.target.value)} placeholder="Kim"
                     name="family-name" autoComplete="family-name" autoCapitalize="words" style={inputStyle} />
            </div>
          </div>
          <div>
            <label htmlFor="create-email" style={labelStyle}>School or organizational email</label>
            <input id="create-email" type="email" autoComplete="email" value={cEmail} onChange={e=>setCEmail(e.target.value)} placeholder="alex.kim@school.edu" style={inputStyle} />
            {cEmail && cEmail.includes("@") && isSchoolEmail(cEmail) && (
              <div style={{ fontSize:11,color:"#68d391",marginTop:4 }}>
                ✓ {getEmailDomain(cEmail)} recognized as a school domain
              </div>
            )}
            {cEmail && cEmail.includes("@") && !isSchoolEmail(cEmail) && (
              <div style={{ fontSize:11,color:"#8a8a9a",marginTop:4 }}>
                Any email works — school or organizational emails recommended
              </div>
            )}
          </div>
          <fieldset style={{border:0,padding:0,margin:0}}>
            <legend style={labelStyle}>Grade level</legend>
            <div style={{ display:"flex",gap:8 }}>
              {["Freshman","Sophomore","Junior","Senior"].map(g=>(
                <button type="button" key={g} aria-pressed={cGrade===g} onClick={()=>setCGrade(g)} style={{
                  flex:1,padding:"10px 0",borderRadius:10,border:`1px solid ${cGrade===g?"rgba(55,138,221,0.5)":"rgba(255,255,255,0.08)"}`,
                  background:cGrade===g?"rgba(55,138,221,0.12)":"rgba(255,255,255,0.02)",
                  color:cGrade===g?"#63b3ed":"#8a8a9a",fontSize:12,fontWeight:cGrade===g?600:400,cursor:"pointer",transition:"all 0.15s"
                }}>{g}</button>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="create-passphrase" style={labelStyle}>Passphrase (encrypts your vault and signs you in)</label>
            <div style={{display:"flex",gap:8}}>
              <input id="create-passphrase" type={showCreatePass ? "text" : "password"} autoComplete="new-password" value={cPass} onChange={e=>setCPass(e.target.value)} placeholder="At least 12 characters" minLength={12} style={{...inputStyle,flex:1}} />
              <button onClick={()=>setShowCreatePass(v=>!v)} type="button" style={{padding:"0 14px",borderRadius:12,border:"1px solid rgba(255,255,255,0.08)",background:"rgba(255,255,255,0.02)",color:"#8a8a9a",cursor:"pointer"}}>{showCreatePass ? "Hide" : "Show"}</button>
            </div>
            <div style={{marginTop:8}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#8a8a9a",marginBottom:6}}>
                <span>Use a long, memorable phrase.</span>
                <span>{cPass.length} chars</span>
              </div>
              <div style={{height:6,borderRadius:999,background:"rgba(255,255,255,0.06)",overflow:"hidden"}}>
                <div style={{height:"100%",width:createPassStrength.fill,background:createPassStrength.color,transition:"width 0.2s ease"}} />
              </div>
              <div style={{fontSize:12,color:createPassStrength.color,marginTop:6}}>{createPassStrength.label} · Minimum 12 characters</div>
            </div>
          </div>
          <div>
            <label htmlFor="create-confirm" style={labelStyle}>Confirm passphrase</label>
            <div style={{display:"flex",gap:8}}>
              <input id="create-confirm" type={showCreatePass2 ? "text" : "password"} autoComplete="new-password" value={cPass2} onChange={e=>setCPass2(e.target.value)} placeholder="Type it again" minLength={12} style={{...inputStyle,flex:1}} />
              <button onClick={()=>setShowCreatePass2(v=>!v)} type="button" style={{padding:"0 14px",borderRadius:12,border:"1px solid rgba(255,255,255,0.08)",background:"rgba(255,255,255,0.02)",color:"#8a8a9a",cursor:"pointer"}}>{showCreatePass2 ? "Hide" : "Show"}</button>
            </div>
          </div>

          <div style={{ display:"flex",flexDirection:"column",gap:8,marginTop:4,padding:"12px 14px",borderRadius:10,background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.04)" }}>
            <div style={{ fontSize:10,fontWeight:600,color:"#6a6a7a",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:2 }}>Required consents</div>
            <div style={{ display:"flex",alignItems:"flex-start",gap:8 }}>
              <input type="checkbox" id="ageAttest" checked={cAgeAttest} onChange={e=>setCAgeAttest(e.target.checked)} style={{ marginTop:3,accentColor:"#378ADD",flexShrink:0 }} />
              <label htmlFor="ageAttest" style={{ fontSize:11,color:"#8a8a9a",lineHeight:1.5,cursor:"pointer" }}>I confirm I am a high school student (ages 14-18), or I have parental/guardian consent to use this tool. I understand this is an AI assistant, not a licensed counselor.</label>
            </div>
            <div style={{ display:"flex",alignItems:"flex-start",gap:8 }}>
              <input type="checkbox" id="consentAI" checked={cConsentAI} onChange={e=>setCConsentAI(e.target.checked)} style={{ marginTop:3,accentColor:"#378ADD",flexShrink:0 }} />
              <label htmlFor="consentAI" style={{ fontSize:11,color:"#8a8a9a",lineHeight:1.5,cursor:"pointer" }}>I understand my questions are processed by an AI system: redacted content is sent to an external AI provider (OpenRouter), which may process it in another country. Responses are advisory only and may contain errors. For official information, I should verify with school counselors and official sources.</label>
            </div>
            <div style={{ display:"flex",alignItems:"flex-start",gap:8 }}>
              <input type="checkbox" id="consentData" checked={cConsentData} onChange={e=>setCConsentData(e.target.checked)} style={{ marginTop:3,accentColor:"#378ADD",flexShrink:0 }} />
              <label htmlFor="consentData" style={{ fontSize:11,color:"#8a8a9a",lineHeight:1.5,cursor:"pointer" }}>I consent to my academic data being processed to provide personalized guidance. My data is encrypted, never sold, and I can export or delete it at any time.</label>
            </div>
          </div>

          {cError && <div role="alert" style={{ fontSize:13,color:"#ffb4ba",background:"rgba(245,101,101,0.12)",padding:"10px 14px",borderRadius:8,animation:"fadeIn 0.2s ease" }}>{cError}</div>}

          <button type="submit" disabled={authBusy} style={{...btnPrimary,marginTop:4,opacity:authBusy?0.65:1,cursor:authBusy?"default":"pointer"}}>{authBusy ? "Creating account…" : "Create account"}</button>
        </form>

        <div style={{ textAlign:"center",marginTop:20 }}>
          <button onClick={()=>{setScreen(S.LOGIN);setCError("");}} style={{ background:"none",border:"none",color:"#6a6a7a",fontSize:13,cursor:"pointer",textDecoration:"underline",textUnderlineOffset:3 }}>
            Already have an account? Sign in
          </button>
        </div>

        <div style={{textAlign:"center",marginTop:10}}><a href="/admin.html" style={{color:"#9ed1ff",fontSize:13}}>Device administrator</a></div>

        <p style={{ fontSize:10,color:"#333",textAlign:"center",marginTop:16,lineHeight:1.6 }}>
          Your personal vault is encrypted in your browser with your passphrase (AES-256-GCM) before it is stored, and we cannot recover a lost passphrase.
          Your profile, chat history and deadlines are also stored on this service's server so the counselor can use them and they survive across devices; chat messages and personal identifiers are encrypted there.
          Questions you ask are sent over HTTPS to the AI provider (OpenRouter) after names and other personal details are redacted; nothing is sold.
          You can export or delete everything from Settings.
        </p>
      </div>
      <style>{GLOBAL_CSS}</style>
    </main>
  );
}
