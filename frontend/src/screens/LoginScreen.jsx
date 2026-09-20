// LoginScreen, moved out of App.jsx on 2026-09-16 with the module-level
// helpers only it uses. App passes the state and callbacks it reads as
// one props object (loginProps in App.jsx); nothing here writes App state
// except through those callbacks.
import { BG, FONT, GLOBAL_CSS, inputStyle, labelStyle } from "../app-shared.js";
import { S, btnPrimary, cardStyle, dots } from "../app-shared.js";



export default function LoginScreen(props) {
  const {
    authBusy,
    handleLogin,
    handleStudentRecovery,
    lEmail,
    lError,
    lPass,
    runAuthGuarded,
    setLEmail,
    setLError,
    setLPass,
    setScreen,
    setShowLoginPass,
    setStudentRecoveryInput,
    setStudentRecoveryMessage,
    setStudentRecoveryOpen,
    setStudentRecoveryPassword,
    showLoginPass,
    studentRecoveryBusy,
    studentRecoveryInput,
    studentRecoveryMessage,
    studentRecoveryOpen,
    studentRecoveryPassword,
  } = props;
  return (
    <main style={{ minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",background:BG,fontFamily:FONT,padding:"20px 0" }}>
      <div style={cardStyle}>
        <div style={{ textAlign:"center",marginBottom:32 }}>
          <div style={{ display:"flex",justifyContent:"center",gap:6,marginBottom:14 }}>
            {dots.map((c,i)=>(<div key={i} style={{width:10,height:10,borderRadius:"50%",background:c,animation:`pulse2 2s ease-in-out ${i*0.15}s infinite`}} />))}
          </div>
          <h1 style={{ fontSize:24,fontWeight:700,color:"#e8e6e3",margin:0,letterSpacing:"-0.03em" }}>Welcome back</h1>
          <p style={{ fontSize:13,color:"#6a6a7a",marginTop:8 }}>Sign in to your encrypted vault</p>
        </div>

        <form onSubmit={(event)=>{event.preventDefault();runAuthGuarded(handleLogin, setLError);}} style={{ display:"flex",flexDirection:"column",gap:14 }}>
          <div>
            <label htmlFor="login-email" style={labelStyle}>Email</label>
            <input id="login-email" type="email" autoComplete="email" value={lEmail} onChange={e=>setLEmail(e.target.value)} placeholder="alex.kim@school.edu" style={inputStyle} />
          </div>
          <div>
            <label htmlFor="login-passphrase" style={labelStyle}>Passphrase</label>
            <div style={{display:"flex",gap:8}}>
              <input id="login-passphrase" type={showLoginPass ? "text" : "password"} autoComplete="current-password" value={lPass} onChange={e=>setLPass(e.target.value)} placeholder="Your vault passphrase" style={{...inputStyle,flex:1}} />
              <button onClick={()=>setShowLoginPass(v=>!v)} type="button" style={{padding:"0 14px",borderRadius:12,border:"1px solid rgba(255,255,255,0.08)",background:"rgba(255,255,255,0.02)",color:"#8a8a9a",cursor:"pointer"}}>{showLoginPass ? "Hide" : "Show"}</button>
            </div>
          </div>

          {lError && <div role="alert" style={{ fontSize:13,color:"#ffb4ba",background:"rgba(245,101,101,0.12)",padding:"10px 14px",borderRadius:8,animation:"fadeIn 0.2s ease" }}>{lError}</div>}

          <button type="submit" disabled={authBusy} style={{...btnPrimary,marginTop:4,opacity:authBusy?0.65:1,cursor:authBusy?"default":"pointer"}}>{authBusy ? "Signing in…" : "Sign in"}</button>
        </form>

        <div style={{marginTop:14}}>
          <button type="button" onClick={()=>{setStudentRecoveryOpen((value)=>!value);setStudentRecoveryMessage(null);}} style={{width:"100%",padding:"9px 12px",borderRadius:6,border:"1px solid rgba(255,255,255,0.16)",background:"transparent",color:"#b7c1ce",cursor:"pointer"}}>
            {studentRecoveryOpen ? "Cancel recovery" : "Recover account"}
          </button>
          {studentRecoveryOpen && (
            <form onSubmit={handleStudentRecovery} style={{display:"grid",gap:12,marginTop:12,padding:14,border:"1px solid rgba(255,255,255,0.14)",borderRadius:8}}>
              <p style={{fontSize:12,color:"#b7c1ce",lineHeight:1.5,margin:0}}>Recovery replaces the unreadable local vault. Data previously synced to this device's service will be restored after sign-in.</p>
              <div>
                <label htmlFor="student-recovery-code" style={labelStyle}>Recovery code</label>
                <input id="student-recovery-code" value={studentRecoveryInput} onChange={(event)=>setStudentRecoveryInput(event.target.value)} autoComplete="off" style={inputStyle} required />
              </div>
              <div>
                <label htmlFor="student-recovery-password" style={labelStyle}>New passphrase</label>
                <input id="student-recovery-password" type="password" value={studentRecoveryPassword} onChange={(event)=>setStudentRecoveryPassword(event.target.value)} autoComplete="new-password" minLength={12} style={inputStyle} required />
              </div>
              <button type="submit" disabled={studentRecoveryBusy} style={btnPrimary}>{studentRecoveryBusy ? "Resetting..." : "Reset passphrase"}</button>
            </form>
          )}
          {studentRecoveryMessage && <p role={studentRecoveryMessage.type==="error"?"alert":"status"} style={{fontSize:13,color:studentRecoveryMessage.type==="error"?"#ffb4ba":"#a9edce"}}>{studentRecoveryMessage.text}</p>}
        </div>

        {/* No account quick-pick: this device keeps no registry of who has an
            account, so there is nothing to enumerate on a shared machine. */}

        <div style={{ textAlign:"center",marginTop:16 }}>
          <button onClick={()=>{setScreen(S.CREATE);setLError("");}} style={{ background:"none",border:"none",color:"#6a6a7a",fontSize:13,cursor:"pointer",textDecoration:"underline",textUnderlineOffset:3 }}>
            New student? Create account
          </button>
        </div>
        <div style={{textAlign:"center",marginTop:10}}><a href="/admin.html" style={{color:"#9ed1ff",fontSize:13}}>Device administrator</a></div>
      </div>
      <style>{GLOBAL_CSS}</style>
    </main>
  );
}
