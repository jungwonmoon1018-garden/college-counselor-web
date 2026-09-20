// profile-analysis.js — the client's offline reference tables (the IPEDS
// sample, AP rigor, regional SAT context, EC-to-major relevance) and the
// deterministic reads built on them. Moved out of App.jsx on 2026-09-20.
// ═══════════════════════════════════════════════════════════
// IPEDS DATA
// ═══════════════════════════════════════════════════════════
export const IPEDS = [
  { name:"Massachusetts Institute of Technology",state:"MA",sat25:1510,sat75:1580,accept:3.9,enroll:11934,tuitionIn:61990,tuitionOut:61990,unitId:"166683",majors:["CS","Engineering","Physics","Math","Biology"] },
  { name:"Stanford University",state:"CA",sat25:1500,sat75:1570,accept:3.6,enroll:17680,tuitionIn:62484,tuitionOut:62484,unitId:"243744",majors:["CS","Engineering","Biology","Economics","Psychology"] },
  { name:"Harvard University",state:"MA",sat25:1480,sat75:1580,accept:3.2,enroll:30631,tuitionIn:59076,tuitionOut:59076,unitId:"166027",majors:["Economics","CS","Government","Biology","Math"] },
  { name:"UC Berkeley",state:"CA",sat25:1300,sat75:1520,accept:11.3,enroll:45307,tuitionIn:14312,tuitionOut:44066,unitId:"110635",majors:["CS","Engineering","Business","Biology","Economics"] },
  { name:"University of Michigan",state:"MI",sat25:1340,sat75:1530,accept:17.7,enroll:48090,tuitionIn:16736,tuitionOut:57273,unitId:"170976",majors:["Business","Engineering","CS","Psychology","Economics"] },
  { name:"Georgia Tech",state:"GA",sat25:1370,sat75:1530,accept:16.0,enroll:44008,tuitionIn:12682,tuitionOut:33794,unitId:"139755",majors:["CS","Engineering","Business","Biology","Math"] },
  { name:"UT Austin",state:"TX",sat25:1230,sat75:1480,accept:29.0,enroll:52384,tuitionIn:11448,tuitionOut:41070,unitId:"228778",majors:["Business","Engineering","CS","Biology","Communications"] },
  { name:"UIUC",state:"IL",sat25:1280,sat75:1500,accept:43.0,enroll:56607,tuitionIn:16004,tuitionOut:34316,unitId:"145637",majors:["Engineering","CS","Business","Biology","Psychology"] },
  { name:"UVA",state:"VA",sat25:1370,sat75:1520,accept:16.3,enroll:26245,tuitionIn:20342,tuitionOut:56950,unitId:"234076",majors:["Business","Economics","Biology","CS","Government"] },
  { name:"Carnegie Mellon",state:"PA",sat25:1480,sat75:1560,accept:11.0,enroll:16811,tuitionIn:63829,tuitionOut:63829,unitId:"211440",majors:["CS","Engineering","Business","Art","Math"] },
  { name:"UF",state:"FL",sat25:1300,sat75:1470,accept:23.0,enroll:55211,tuitionIn:6380,tuitionOut:28658,unitId:"134130",majors:["Business","Biology","Engineering","Psychology","Health"] },
  { name:"UW Seattle",state:"WA",sat25:1260,sat75:1470,accept:48.0,enroll:61689,tuitionIn:12076,tuitionOut:40740,unitId:"236948",majors:["CS","Engineering","Business","Biology","Psychology"] },
  { name:"NYU",state:"NY",sat25:1370,sat75:1530,accept:12.2,enroll:61803,tuitionIn:62192,tuitionOut:62192,unitId:"193900",majors:["Business","Film","Economics","CS","Psychology"] },
  { name:"Boston University",state:"MA",sat25:1350,sat75:1510,accept:14.0,enroll:36714,tuitionIn:65168,tuitionOut:65168,unitId:"164988",majors:["Business","Biology","Engineering","CS","Communications"] },
  { name:"Purdue",state:"IN",sat25:1180,sat75:1430,accept:49.0,enroll:51344,tuitionIn:9992,tuitionOut:28794,unitId:"153658",majors:["Engineering","CS","Business","Biology","Agriculture"] },
  { name:"Ohio State",state:"OH",sat25:1210,sat75:1420,accept:53.0,enroll:61369,tuitionIn:11936,tuitionOut:36722,unitId:"204796",majors:["Business","Engineering","Biology","Psychology","CS"] },
  { name:"Rice University",state:"TX",sat25:1490,sat75:1570,accept:7.7,enroll:8973,tuitionIn:58128,tuitionOut:58128,unitId:"227757",majors:["Engineering","CS","Biology","Economics","Architecture"] },
  { name:"Emory University",state:"GA",sat25:1420,sat75:1530,accept:11.4,enroll:15452,tuitionIn:60774,tuitionOut:60774,unitId:"139658",majors:["Business","Biology","Economics","Psychology","Nursing"] },
  { name:"USC",state:"CA",sat25:1400,sat75:1540,accept:9.2,enroll:49318,tuitionIn:66640,tuitionOut:66640,unitId:"123961",majors:["Business","Film","CS","Engineering","Communications"] },
  { name:"Penn State",state:"PA",sat25:1160,sat75:1370,accept:54.0,enroll:88502,tuitionIn:19286,tuitionOut:38824,unitId:"214777",majors:["Engineering","Business","Biology","CS","Education"] },
];

const TARGET_UNIT_ID_ALIASES = new Map([
  ["mit", "166683"],
  ["stanford", "243744"],
  ["harvard", "166027"],
  ["berkeley", "110635"],
  ["university of california berkeley", "110635"],
  ["michigan", "170976"],
  ["university of michigan", "170976"],
  ["georgia institute of technology", "139755"],
  ["university of texas at austin", "228778"],
  ["university of illinois urbana champaign", "145637"],
  ["university of virginia", "234076"],
  ["carnegie mellon university", "211440"],
  ["university of florida", "134130"],
  ["university of washington", "236948"],
  ["new york university", "193900"],
  ["purdue university", "153658"],
  ["ohio state university", "204796"],
  ["university of southern california", "123961"],
]);

function normalizedSchoolKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function resolveTargetUnitId(name) {
  const key = normalizedSchoolKey(name);
  const exact = IPEDS.find((school) => normalizedSchoolKey(school.name) === key);
  return exact?.unitId || TARGET_UNIT_ID_ALIASES.get(key) || null;
}

export const AP_RIGOR = {
  "Physics C: E&M":       {tier:1,label:"Extremely Hard",pct5:24,pct3plus:75,meanScore:3.39,note:"Calculus-based E&M. Smallest exam population, self-selected."},
  "Physics C: Mechanics":  {tier:1,label:"Extremely Hard",pct5:20,pct3plus:72,meanScore:3.26,note:"Calculus-based mechanics. Strong math prerequisite."},
  "Calculus BC":           {tier:1,label:"Extremely Hard",pct5:46,pct3plus:82,meanScore:3.92,note:"High pass rate reflects self-selection; content is very rigorous."},
  "Chemistry":             {tier:2,label:"Very Hard",pct5:15,pct3plus:76,meanScore:3.31,note:"Heavy lab component + conceptual depth."},
  "Physics 1":             {tier:2,label:"Very Hard",pct5:19,pct3plus:68,meanScore:3.13,note:"Algebra-based but conceptually demanding. Lowest pass rate."},
  "Physics 2":             {tier:2,label:"Very Hard",pct5:20,pct3plus:72,meanScore:3.34,note:"Fluids, thermo, optics, nuclear. Small test population."},
  "US History":            {tier:2,label:"Very Hard",pct5:14,pct3plus:74,meanScore:3.31,note:"Massive content scope. DBQ + LEQ essays."},
  "European History":      {tier:2,label:"Very Hard",pct5:16,pct3plus:74,meanScore:3.31,note:"Broad chronological range. Heavy essay component."},
  "English Literature":    {tier:2,label:"Very Hard",pct5:16,pct3plus:73,meanScore:3.2,note:"Poetry analysis and literary argument under time pressure."},
  "Biology":               {tier:3,label:"Hard",pct5:15,pct3plus:71,meanScore:3.18,note:"Content-heavy with lab skills and data analysis."},
  "Calculus AB":           {tier:3,label:"Hard",pct5:20,pct3plus:65,meanScore:3.22,note:"Foundation of college math. Requires strong algebra/precalc."},
  "Statistics":            {tier:3,label:"Hard",pct5:17,pct3plus:62,meanScore:2.98,note:"Conceptual probability + inference. Less pure math."},
  "English Language":      {tier:3,label:"Hard",pct5:15,pct3plus:75,meanScore:3.23,note:"Rhetorical analysis and argument essays."},
  "World History":         {tier:3,label:"Hard",pct5:14,pct3plus:66,meanScore:3.22,note:"Global scope. Comparison + causation essays."},
  "Computer Science A":    {tier:3,label:"Hard",pct5:25,pct3plus:66,meanScore:3.19,note:"Java programming. Strong analytical thinking required."},
  "Macroeconomics":        {tier:4,label:"Moderate",pct5:19,pct3plus:66,meanScore:3.12,note:"Conceptual models + graphs. One semester of content."},
  "Microeconomics":        {tier:4,label:"Moderate",pct5:19,pct3plus:68,meanScore:3.2,note:"Supply/demand, market structures. One semester."},
  "US Government":         {tier:4,label:"Moderate",pct5:23,pct3plus:76,meanScore:3.42,note:"Shorter content scope but requires civic depth."},
  "Psychology":            {tier:4,label:"Moderate",pct5:15,pct3plus:74,meanScore:3.31,note:"Content memorization heavy. Highest enrollment."},
  "Environmental Science": {tier:4,label:"Moderate",pct5:13,pct3plus:69,meanScore:3.08,note:"Interdisciplinary. Broad but not as deep."},
  "Human Geography":       {tier:5,label:"Introductory",pct5:19,pct3plus:66,meanScore:3.2,note:"Often taken freshman year. Good AP entry point."},
  "Computer Science Principles":{tier:5,label:"Introductory",pct5:10,pct3plus:63,meanScore:2.9,note:"Broader computing concepts. No Java required."},
  "Precalculus":           {tier:4,label:"Moderate",pct5:29,pct3plus:82,meanScore:3.62,note:"New exam (2023). Bridges to Calculus."},
  "Seminar":               {tier:4,label:"Moderate",pct5:10,pct3plus:88,meanScore:3.27,note:"Research + presentation. Part of AP Capstone."},
  "Research":              {tier:3,label:"Hard",pct5:17,pct3plus:90,meanScore:3.53,note:"Independent research paper. Requires Seminar first."},
  "Art History":           {tier:3,label:"Hard",pct5:15,pct3plus:67,meanScore:3.13,note:"250 works to know. Visual analysis essays."},
  "Music Theory":          {tier:3,label:"Hard",pct5:18,pct3plus:59,meanScore:2.97,note:"Requires prior music literacy. Sight-singing + composition."},
  "Spanish Language":      {tier:4,label:"Moderate",pct5:21,pct3plus:83,meanScore:3.53,note:"Heritage speakers inflate stats. Non-heritage is harder."},
  "Spanish Literature":    {tier:2,label:"Very Hard",pct5:20,pct3plus:71,meanScore:3.25,note:"Literary analysis in Spanish. Advanced fluency required."},
  "French Language":       {tier:4,label:"Moderate",pct5:15,pct3plus:71,meanScore:3.18,note:"Speaking + writing in French."},
  "Chinese Language":      {tier:4,label:"Moderate",pct5:48,pct3plus:85,meanScore:3.91,note:"Heritage speakers dominate. Non-heritage is tier 2."},
  "Japanese Language":     {tier:4,label:"Moderate",pct5:47,pct3plus:72,meanScore:3.55,note:"Small exam population. Heritage speaker effect."},
  "Latin":                 {tier:3,label:"Hard",pct5:20,pct3plus:73,meanScore:3.32,note:"Translation of Caesar and Vergil. Dead language rigor."},
  "German Language":       {tier:4,label:"Moderate",pct5:24,pct3plus:68,meanScore:3.23,note:"Smaller test population."},
  "Italian Language":      {tier:4,label:"Moderate",pct5:19,pct3plus:69,meanScore:3.18,note:"Small exam. Heritage advantage."},
  "Comparative Government":{tier:4,label:"Moderate",pct5:15,pct3plus:70,meanScore:3.1,note:"Six countries' political systems."},
  "African American Studies":{tier:4,label:"Moderate",pct5:20,pct3plus:77,meanScore:3.41,note:"New exam (2024). Interdisciplinary approach."},
  "Studio Art: 2-D":       {tier:4,label:"Moderate",pct5:12,pct3plus:85,meanScore:3.42,note:"Portfolio submission. Subjective grading."},
  "Studio Art: 3-D":       {tier:4,label:"Moderate",pct5:7,pct3plus:75,meanScore:3.12,note:"Sculptural portfolio. Smallest art exam."},
  "Studio Art: Drawing":   {tier:4,label:"Moderate",pct5:16,pct3plus:83,meanScore:3.43,note:"Drawing portfolio. Most popular art AP."},
};

// ═══════════════════════════════════════════════════════════
// SAT REGIONAL DATA (Source: CollegeBoard SAT Suite Annual Report 2024)
// Mean scores by state/region for contextualizing student scores
// ═══════════════════════════════════════════════════════════
const SAT_REGIONAL = {
  // US States (mean total score, participation rate %)
  "AL":{mean:1120,part:6},"AK":{mean:1098,part:8},"AZ":{mean:1132,part:31},
  "AR":{mean:1145,part:5},"CA":{mean:1165,part:62},"CO":{mean:1115,part:30},
  "CT":{mean:1105,part:80},"DE":{mean:1035,part:78},"FL":{mean:1080,part:74},
  "GA":{mean:1070,part:61},"HI":{mean:1095,part:52},"ID":{mean:1110,part:88},
  "IL":{mean:1115,part:80},"IN":{mean:1105,part:65},"IA":{mean:1220,part:3},
  "KS":{mean:1215,part:4},"KY":{mean:1165,part:5},"LA":{mean:1120,part:5},
  "ME":{mean:1055,part:85},"MD":{mean:1070,part:66},"MA":{mean:1145,part:72},
  "MI":{mean:1085,part:71},"MN":{mean:1215,part:5},"MS":{mean:1100,part:4},
  "MO":{mean:1215,part:4},"MT":{mean:1195,part:7},"NE":{mean:1210,part:4},
  "NV":{mean:1075,part:31},"NH":{mean:1090,part:68},"NJ":{mean:1095,part:79},
  "NM":{mean:1085,part:16},"NY":{mean:1075,part:73},"NC":{mean:1095,part:49},
  "ND":{mean:1235,part:2},"OH":{mean:1100,part:65},"OK":{mean:1135,part:6},
  "OR":{mean:1110,part:41},"PA":{mean:1095,part:67},"RI":{mean:1060,part:73},
  "SC":{mean:1045,part:58},"SD":{mean:1200,part:3},"TN":{mean:1170,part:7},
  "TX":{mean:1100,part:60},"UT":{mean:1195,part:7},"VT":{mean:1115,part:60},
  "VA":{mean:1125,part:59},"WA":{mean:1115,part:60},"WV":{mean:1050,part:81},
  "WI":{mean:1210,part:4},"WY":{mean:1190,part:4},"DC":{mean:1015,part:82},
  // International regions
  "East Asia":{mean:1215,part:null,note:"South Korea, Japan, China averages"},
  "South Asia":{mean:1180,part:null,note:"India, Pakistan, Bangladesh"},
  "Southeast Asia":{mean:1140,part:null,note:"Singapore, Philippines, Vietnam"},
  "Middle East":{mean:1105,part:null,note:"UAE, Saudi Arabia, Turkey"},
  "Europe":{mean:1195,part:null,note:"UK, Germany, France averages"},
  "Latin America":{mean:1085,part:null,note:"Mexico, Brazil, Colombia"},
  "Sub-Saharan Africa":{mean:1065,part:null,note:"Nigeria, Kenya, South Africa"},
  // National average
  "US National":{mean:1098,part:null,note:"National mean for class of 2024"},
};

// ═══════════════════════════════════════════════════════════
// EC-TO-MAJOR RELEVANCE MAP
// How each EC category maps to college major areas
// ═══════════════════════════════════════════════════════════
export const EC_MAJOR_RELEVANCE = {
  "Computer Science": {
    strong: ["Coding clubs","Hackathons","Robotics","CS research","Tech internship","App/website development","AI/ML projects","Cybersecurity club","Open source contributions"],
    good: ["Math team/competition","Science olympiad","Engineering club","Data analysis projects","FIRST Robotics","Debate (logical thinking)"],
    supplementary: ["Tutoring in STEM","Tech blog/YouTube","Entrepreneurship club","Student government (leadership)"]
  },
  "Engineering": {
    strong: ["FIRST Robotics","Engineering club","Science olympiad","Research with professor","Technical internship","CAD/design projects","Bridge/structure competitions"],
    good: ["Math competitions","Physics club","Coding club","Maker space/fab lab","Environmental projects","Drone club"],
    supplementary: ["Community service (engineering for change)","Mentoring younger students","Leadership roles"]
  },
  "Pre-Med/Biology": {
    strong: ["Hospital volunteering","Research (bio/chem lab)","Science olympiad (bio events)","Health-related internship","EMT/first responder training","Shadowing physicians"],
    good: ["Red Cross club","Public health advocacy","Biology club","Chemistry club","Mental health awareness club"],
    supplementary: ["Sports (discipline/teamwork)","Tutoring sciences","Community service","Foreign language (patient communication)"]
  },
  "Business/Economics": {
    strong: ["DECA/FBLA/BPA","Entrepreneurship club","Investment club","Business internship","Starting a small business","Economics competition"],
    good: ["Student government","Mock trial","Debate","Marketing for school events","Fundraising leadership","Financial literacy club"],
    supplementary: ["Sports (teamwork/leadership)","Community service","Math competitions","Newspaper (writing skills)"]
  },
  "Psychology": {
    strong: ["Psychology club","Peer counseling","Mental health advocacy","Research assistant (psych lab)","Crisis hotline volunteer","Behavioral science fair projects"],
    good: ["Community service with vulnerable populations","Special Olympics volunteer","Tutoring/mentoring","Sociology club"],
    supplementary: ["Creative writing","Theater (understanding emotion)","Sports psychology interest","Foreign language"]
  },
  "Arts/Design": {
    strong: ["Art portfolio development","Design competitions","Art exhibitions","Film/animation club","Photography club","Fashion design","Architecture club"],
    good: ["Theater/drama","Creative writing","Music performance","Graphic design for school","Museum volunteering","Art tutoring"],
    supplementary: ["Cultural clubs","Community mural projects","Social media content creation","Yearbook/literary magazine"]
  },
  "Political Science/Government": {
    strong: ["Model UN","Mock trial","Debate","Student government","Political campaign volunteering","Youth in Government","Congressional internship"],
    good: ["Community organizing","Journalism/newspaper","Civil rights advocacy","Law-related internship","Public speaking competitions"],
    supplementary: ["Community service","Foreign language","History club","Environmental advocacy"]
  },
  "Communications/Journalism": {
    strong: ["School newspaper","Broadcast journalism","Podcast/YouTube channel","Literary magazine","Yearbook","Blog with following","Journalism internship"],
    good: ["Debate","Public speaking","Theater","Social media management","Creative writing club","Photography"],
    supplementary: ["Student government","Marketing projects","Foreign language","Community radio"]
  },
  "Education": {
    strong: ["Tutoring/peer tutoring","Teaching assistant","Youth mentoring programs","After-school program volunteer","Summer camp counselor","Literacy program volunteer"],
    good: ["Student government","Special education volunteering","ESL tutoring","Sunday school teaching","Coaching younger teams"],
    supplementary: ["Community service","Public speaking","Foreign language","Club leadership"]
  },
};

// Analyze a student's ECs against their intended major
export function analyzeECStrength(activities, majorInterest, goals) {
  if (!majorInterest || !activities?.length) return { analysis: [], overallScore: 0, gaps: [], recommendations: [] };

  // Find best matching major category
  const majorKey = Object.keys(EC_MAJOR_RELEVANCE).find(k =>
    majorInterest.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(majorInterest.toLowerCase())
  ) || Object.keys(EC_MAJOR_RELEVANCE).find(k =>
    majorInterest.toLowerCase().split(/\s+/).some(w => k.toLowerCase().includes(w))
  );

  const relevance = majorKey ? EC_MAJOR_RELEVANCE[majorKey] : null;
  if (!relevance) return { analysis: activities.map(a => ({ ...a, relevance: "unknown", note: "No major-specific data available" })), overallScore: 50, gaps: [], recommendations: [], majorKey: null };

  // FIX 7c: Word-boundary matching instead of substring (prevents "Art" matching "Martial Arts" etc)
  const wordMatch = (actName, refName) => {
    const actWords = actName.toLowerCase().split(/[\s/,&-]+/).filter(w => w.length > 2);
    const refWords = refName.toLowerCase().split(/[\s/,&-]+/).filter(w => w.length > 2);
    // Require at least 2 matching words, or 1 match if either has only 1 meaningful word
    const matches = actWords.filter(aw => refWords.some(rw => aw.includes(rw) || rw.includes(aw)));
    const threshold = Math.min(actWords.length, refWords.length) <= 1 ? 1 : 2;
    return matches.length >= threshold;
  };

  const analysis = activities.map(a => {
    const name = a.name || "";
    const isStrong = relevance.strong.some(s => wordMatch(name, s));
    const isGood = relevance.good.some(s => wordMatch(name, s));
    const isSupp = relevance.supplementary.some(s => wordMatch(name, s));

    let rel = "general", note = "Not directly mapped to your major — shows breadth", score = 30;
    if (isStrong) { rel = "strong"; note = `Directly relevant to ${majorKey}. Admissions committees look for this.`; score = 100; }
    else if (isGood) { rel = "good"; note = `Supports your ${majorKey} interest. Shows related skills.`; score = 70; }
    else if (isSupp) { rel = "supplementary"; note = `Complements your profile. Shows well-roundedness.`; score = 50; }

    // Boost for leadership roles
    const leadershipRoles = ["president","founder","captain","head","director","lead","chief","editor","chair"];
    const hasLeadership = leadershipRoles.some(r => (a.role||"").toLowerCase().includes(r));
    if (hasLeadership) { score = Math.min(100, score + 15); note += " Leadership role adds significant value."; }

    // Boost for significant time commitment
    if (a.hoursPerWeek && parseFloat(a.hoursPerWeek) >= 10) { score = Math.min(100, score + 5); note += " High commitment shows dedication."; }

    return { ...a, relevance: rel, note, score };
  });

  const overallScore = analysis.length ? Math.round(analysis.reduce((s, a) => s + a.score, 0) / analysis.length) : 0;
  const hasStrong = analysis.some(a => a.relevance === "strong");
  const gaps = [];
  const recommendations = [];

  if (!hasStrong) {
    gaps.push(`No activities directly aligned with ${majorKey}`);
    recommendations.push(...relevance.strong.slice(0, 3).map(s => `Consider: ${s}`));
  }
  if (analysis.length < 4) {
    gaps.push("Fewer than 4 activities — colleges prefer depth AND some breadth");
  }
  if (!analysis.some(a => (a.role||"").toLowerCase().match(/president|founder|captain|head|director|lead/))) {
    gaps.push("No leadership positions yet — aim for one by junior/senior year");
  }

  return { analysis, overallScore, gaps, recommendations, majorKey };
}

// Contextualize a student's SAT score against regional and national averages
export function contextualizeSAT(score, state, region) {
  if (!score) return null;
  const national = SAT_REGIONAL["US National"];
  const stateData = state ? SAT_REGIONAL[state] : null;
  const regionData = region ? SAT_REGIONAL[region] : null;

  const result = {
    score,
    national: { mean: national.mean, diff: score - national.mean, percentileEstimate: estimatePercentile(score) },
    state: stateData ? { name: state, mean: stateData.mean, diff: score - stateData.mean, participation: stateData.part } : null,
    region: regionData ? { name: region, mean: regionData.mean, diff: score - regionData.mean, note: regionData.note } : null,
    interpretation: "",
    source: "CollegeBoard SAT Suite Annual Report 2024"
  };

  // Participation rate context (important — selection effects inflate means)
  if (stateData?.part && stateData.part < 50) {
    if (stateData.part < 15) {
      result.interpretation += `Note: ${state} has very low SAT participation (${stateData.part}%), so mostly self-selected high achievers take it. The state mean of ${stateData.mean} is significantly inflated. `;
    } else {
      result.interpretation += `Note: ${state} has moderate SAT participation (${stateData.part}%), meaning selection effects may inflate the state mean. `;
    }
  }

  const diff = score - national.mean;
  if (diff >= 300) result.interpretation += "Exceptional score — well above the 95th percentile nationally.";
  else if (diff >= 200) result.interpretation += "Excellent score — strong candidate for highly selective schools.";
  else if (diff >= 100) result.interpretation += "Above average — competitive for many selective institutions.";
  else if (diff >= 0) result.interpretation += "At or above the national average.";
  else if (diff >= -100) result.interpretation += "Slightly below national average — consider retaking or test-optional schools.";
  else result.interpretation += "Below national average — focus on test prep or emphasize other strengths in applications.";

  return result;
}

function estimatePercentile(score) {
  // Approximate SAT percentile mapping (CollegeBoard 2024)
  if (score >= 1550) return 99;
  if (score >= 1500) return 98;
  if (score >= 1450) return 96;
  if (score >= 1400) return 94;
  if (score >= 1350) return 91;
  if (score >= 1300) return 87;
  if (score >= 1250) return 82;
  if (score >= 1200) return 75;
  if (score >= 1150) return 67;
  if (score >= 1100) return 58;
  if (score >= 1050) return 48;
  if (score >= 1000) return 39;
  if (score >= 950) return 30;
  if (score >= 900) return 22;
  return Math.max(1, Math.round(score / 50));
}
