import crypto from "node:crypto";

// Consent is explicit and operation-scoped. Student accounts always use the
// stricter minor-safe defaults; callers cannot downgrade that policy.
export const CONSENT_TYPES = Object.freeze({
  DATA_PROCESSING: "data_processing",
  AI_INTERACTION: "ai_interaction",
  SESSION_PERSISTENCE: "session_persistence",
  FAFSA_CONTRIBUTOR: "fafsa_contributor",
  INSTITUTIONAL_SHARING: "institutional_sharing",
  CROSS_BORDER_TRANSFER: "cross_border_transfer",
  CHAT_TRANSCRIPT_GRAPHING: "chat_transcript_graphing",
});

const VALID_CONSENT_TYPES = new Set(Object.values(CONSENT_TYPES));
const VALID_GRANTORS = new Set(["student", "parent_guardian"]);

export function isValidConsentType(consentType) {
  return VALID_CONSENT_TYPES.has(consentType);
}

export function grantConsent(stmts, studentId, consentType, options = {}) {
  if (!isValidConsentType(consentType)) throw new Error("Unsupported consent type.");
  const grantedBy = options.grantedBy || "student";
  if (!VALID_GRANTORS.has(grantedBy)) throw new Error("Unsupported consent grantor.");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = options.expiresAt || null;
  const scope = options.scope || null;
  stmts.insertConsent.run(id, studentId, consentType, now, grantedBy, expiresAt, scope);
  return { id, studentId, consentType, grantedAt: now, grantedBy, expiresAt, scope };
}

export function revokeConsent(stmts, consentId, revokedBy = "student") {
  if (!VALID_GRANTORS.has(revokedBy)) throw new Error("Unsupported consent revoker.");
  stmts.revokeConsent.run(revokedBy, consentId);
  return { id: consentId, revoked: true, revokedBy };
}

// Withdrawing a consent. Korea PIPA (Art. 37) and the consent copy promise
// that redacted content reaches the overseas AI provider only with consent,
// and until this existed the only way to withdraw it was deleting the whole
// account. Every active row of the type is revoked; a later grant is a new
// row, so the student can turn a feature back on.
export function revokeConsentType(stmts, studentId, consentType, revokedBy = "student") {
  if (!isValidConsentType(consentType)) throw new Error("Unsupported consent type.");
  if (!VALID_GRANTORS.has(revokedBy)) throw new Error("Unsupported consent revoker.");
  const result = stmts.revokeConsentByType.run(revokedBy, studentId, consentType);
  return { studentId, consentType, revoked: true, revokedBy, count: result.changes };
}

// The consent types whose newest record is a revocation: withdrawn, as
// opposed to never recorded. The client re-grants missing onboarding rows
// for accounts made by older signup builds; a withdrawn type must never be
// re-granted that way.
export function revokedConsentTypes(stmts, studentId, types = Object.values(CONSENT_TYPES)) {
  if (!stmts.getLatestConsentOfType) return [];
  return types.filter((type) => {
    const latest = stmts.getLatestConsentOfType.get(studentId, type);
    return !!latest?.revoked_at;
  });
}

export function hasActiveConsent(stmts, studentId, consentType) {
  if (!isValidConsentType(consentType)) return { hasConsent: false, record: null };
  const record = stmts.getActiveConsent.get(studentId, consentType);
  return { hasConsent: !!record, record: record || null };
}

export function getConsentHistory(stmts, studentId) {
  return stmts.getAllConsent.all(studentId);
}

export function validateRequiredConsents(stmts, studentId, operation, _isMinor = true) {
  const requiredConsents = getRequiredConsentsForOperation(operation);
  const results = requiredConsents.map((consentType) => {
    const { hasConsent, record } = hasActiveConsent(stmts, studentId, consentType);
    return { consentType, required: true, granted: hasConsent, record };
  });
  const missing = results.filter((result) => !result.granted).map((result) => result.consentType);
  return {
    allowed: missing.length === 0,
    results,
    missing,
    message: missing.length === 0
      ? "All required consents are active."
      : `Missing consent(s): ${missing.join(", ")}.`,
  };
}

function getRequiredConsentsForOperation(operation) {
  const base = [CONSENT_TYPES.DATA_PROCESSING];
  switch (operation) {
    case "ai_interaction":
    case "cross_border":
    case "strategy_council":
      return [...base, CONSENT_TYPES.AI_INTERACTION, CONSENT_TYPES.CROSS_BORDER_TRANSFER];
    case "fafsa_workflow":
      return [...base, CONSENT_TYPES.FAFSA_CONTRIBUTOR];
    case "session_persistence":
      return [...base, CONSENT_TYPES.SESSION_PERSISTENCE];
    case "institutional_sharing":
      return [...base, CONSENT_TYPES.INSTITUTIONAL_SHARING];
    case "chat_transcript_graphing":
      return [...base, CONSENT_TYPES.CHAT_TRANSCRIPT_GRAPHING];
    default:
      return base;
  }
}

// What each consent is, in the words the student reads before giving it.
// Every type an operation can require is here, in English and Korean: the
// consent panel (frontend components/ConsentNeeded.jsx) offers a type a
// route requires only when the server describes it, and this copy used to
// cover only the three onboarding consents, the very types the panel never
// opens for, so a 403 naming any other type was a dead end. No route
// requires the other four yet; when one starts to, check its words here
// against what the feature does.
const COPY = {
  en: {
    [CONSENT_TYPES.DATA_PROCESSING]: {
      label: "Data processing consent",
      description: "I consent to storing the information I enter for local college-counseling features.",
    },
    [CONSENT_TYPES.AI_INTERACTION]: {
      label: "External AI processing consent",
      description: "I understand that redacted chat content is sent to OpenRouter when I use AI advice.",
    },
    [CONSENT_TYPES.CROSS_BORDER_TRANSFER]: {
      label: "Cross-border transfer consent",
      description: "I understand that OpenRouter may process redacted content in another country.",
    },
    [CONSENT_TYPES.FAFSA_CONTRIBUTOR]: {
      label: "FAFSA contributor consent",
      description: "I agree that what I enter about a FAFSA contributor (a parent or spouse whose information goes on my FAFSA) may be stored to help me with the FAFSA.",
    },
    [CONSENT_TYPES.SESSION_PERSISTENCE]: {
      label: "Saved session consent",
      description: "I agree that my session may be kept between visits so I can pick up where I left off.",
    },
    [CONSENT_TYPES.INSTITUTIONAL_SHARING]: {
      label: "School sharing consent",
      description: "I agree that information I choose may be shared with my school or my counselor.",
    },
    [CONSENT_TYPES.CHAT_TRANSCRIPT_GRAPHING]: {
      label: "Chat history map consent",
      description: "I agree that my chat history may be used to build a map of my interests and activities that the counselor draws on.",
    },
  },
  ko: {
    [CONSENT_TYPES.DATA_PROCESSING]: {
      label: "데이터 처리 동의",
      description: "입력한 정보를 로컬 대학 상담 기능을 위해 저장하는 데 동의합니다.",
    },
    [CONSENT_TYPES.AI_INTERACTION]: {
      label: "외부 AI 처리 동의",
      description: "AI 상담을 사용할 때 비식별 처리된 대화 내용이 OpenRouter로 전송됨을 이해합니다.",
    },
    [CONSENT_TYPES.CROSS_BORDER_TRANSFER]: {
      label: "국외 이전 동의",
      description: "OpenRouter가 비식별 처리된 내용을 다른 국가에서 처리할 수 있음을 이해합니다.",
    },
    [CONSENT_TYPES.FAFSA_CONTRIBUTOR]: {
      label: "FAFSA 기여자 정보 동의",
      description: "FAFSA 작성을 돕기 위해, 내가 입력한 FAFSA 기여자(내 FAFSA에 정보가 들어가는 부모 또는 배우자)에 관한 내용이 저장되는 데 동의합니다.",
    },
    [CONSENT_TYPES.SESSION_PERSISTENCE]: {
      label: "세션 유지 동의",
      description: "다음 방문 때 이어서 사용할 수 있도록 방문 사이에도 내 세션이 유지되는 데 동의합니다.",
    },
    [CONSENT_TYPES.INSTITUTIONAL_SHARING]: {
      label: "학교 공유 동의",
      description: "내가 선택한 정보가 우리 학교나 상담 선생님과 공유되는 데 동의합니다.",
    },
    [CONSENT_TYPES.CHAT_TRANSCRIPT_GRAPHING]: {
      label: "대화 기록 분석 동의",
      description: "내 대화 기록이 상담에 활용되는 관심사·활동 지도를 만드는 데 사용되는 데 동의합니다.",
    },
  },
};

// A locale arrives from a query string, where it can be missing or a list.
function copyFor(locale) {
  return String(locale || "").toLowerCase().startsWith("ko") ? COPY.ko : COPY.en;
}

export function getOnboardingConsentRequirements(_isMinor = true, locale = "en") {
  const copy = copyFor(locale);
  return [CONSENT_TYPES.DATA_PROCESSING, CONSENT_TYPES.AI_INTERACTION, CONSENT_TYPES.CROSS_BORDER_TRANSFER]
    .map((consentType) => ({ consentType, required: true, ...copy[consentType] }));
}

// The label and description of each type asked about, in the student's
// language, once each and in the order asked. A type the server does not
// know is left out rather than described: the panel names it and offers
// nothing, because a consent nobody could read is not consent.
export function describeConsentTypes(types, locale = "en") {
  const copy = copyFor(locale);
  const out = [];
  for (const type of Array.isArray(types) ? types : []) {
    if (!isValidConsentType(type) || out.some((item) => item.consentType === type)) continue;
    out.push({ consentType: type, ...copy[type] });
  }
  return out;
}
