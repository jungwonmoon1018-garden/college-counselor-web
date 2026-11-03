// chat-errors.js — how a failed /api/chat or /api/council/convene call
// becomes an Error the client can reason about, and the words a student sees
// for it, in English and Korean.
//
// The routes answer every failure with a stable `code` (402 budget codes,
// 403 consent_required, 429 rate_limited, 502 provider_error /
// provider_auth_failed / empty_model_reply, 503 openrouter_not_configured /
// installation_setup_required, 504 provider_timeout). requestChat used to keep
// only the status, and App's formatter matched substrings of the English
// message, so a used-up monthly budget, a missing consent, a 429 and an
// unconfigured server all read "Something went wrong… please try again" — a
// capped student retried for days without being told why, and a Korean
// student got English. Each code now has its own copy that says what to do
// and whether trying again can help; an unknown code still says the latter.

const PROVIDER_AUTH_CODES = new Set(["provider_auth_failed", "provider_auth_rejected", "auth_rejected"]);

const COPY = {
  budget_used: {
    en: "You've used this month's AI budget, so the counselor can't answer new questions until it resets at the start of next month. Your profile, saved chats and deadlines still work. Trying again before then won't help.",
    ko: "이번 달 AI 사용 예산을 모두 사용해서 다음 달 초에 예산이 초기화될 때까지 새 질문에 답할 수 없어요. 프로필, 저장된 대화, 마감일은 계속 사용할 수 있어요. 그 전에는 다시 보내도 해결되지 않아요.",
  },
  budget_short: {
    en: "This question needs more of your monthly AI budget than you have left. Try a shorter question or one without attachments, or wait until the budget resets at the start of next month.",
    ko: "이 질문은 이번 달 남은 AI 예산보다 많은 예산이 필요해요. 더 짧게 질문하거나 첨부 파일 없이 보내 보세요. 아니면 다음 달 초 예산이 초기화될 때까지 기다려 주세요.",
  },
  unknown_model_pricing: {
    en: "The counselor's AI model has no price on file right now, so it's paused to protect your budget. This isn't something you did, and trying again won't help until your counselor updates the model settings.",
    ko: "지금 상담 AI 모델의 가격 정보가 없어서 예산 보호를 위해 잠시 멈췄어요. 학생 잘못이 아니며, 상담 선생님이 모델 설정을 고칠 때까지는 다시 보내도 해결되지 않아요.",
  },
  grade_required: {
    en: "Your account doesn't have a high-school grade (9-12) on file, so the counselor can't answer yet. Trying again won't help; please ask your counselor to check your account's graduation year.",
    ko: "계정에 고등학교 학년(9-12학년) 정보가 없어서 아직 답할 수 없어요. 다시 보내도 해결되지 않으니 상담 선생님께 계정의 졸업 연도를 확인해 달라고 요청해 주세요.",
  },
  consent_required: {
    en: "The counselor needs your permission to use AI and to send your question to the AI service before it can answer. Sending again won't work until that permission is given; ask your counselor if you're not sure how.",
    ko: "답변하려면 AI 사용과 질문을 AI 서비스로 보내는 것에 대한 동의가 필요해요. 동의하기 전에는 다시 보내도 작동하지 않아요. 방법을 모르겠다면 상담 선생님께 문의해 주세요.",
  },
  rate_limited: {
    en: (seconds) => `You're sending messages faster than the counselor can keep up. Wait ${seconds ? `${seconds} seconds` : "about a minute"}, then send again.`,
    ko: (seconds) => `메시지를 너무 빠르게 보내고 있어요. ${seconds ? `${seconds}초` : "1분 정도"} 기다린 뒤 다시 보내 주세요.`,
  },
  not_configured: {
    en: "The counselor's AI isn't set up on this site yet, so it can't answer. Trying again won't help; please let your counselor know.",
    ko: "이 사이트에 상담 AI가 아직 설정되지 않아서 답할 수 없어요. 다시 보내도 해결되지 않으니 상담 선생님께 알려 주세요.",
  },
  provider_auth_failed: {
    en: "The AI service turned down this site's connection. You're still signed in and nothing is wrong with your account. Trying again won't help until your counselor fixes the site's AI settings.",
    ko: "AI 서비스가 이 사이트의 연결을 거부했어요. 로그인은 그대로 유지되어 있고 계정에는 문제가 없어요. 상담 선생님이 사이트의 AI 설정을 고칠 때까지는 다시 보내도 해결되지 않아요.",
  },
  provider_error: {
    en: "The AI service had trouble answering. Wait a minute and try again.",
    ko: "AI 서비스가 답변하는 중에 문제가 생겼어요. 1분 정도 기다린 뒤 다시 시도해 주세요.",
  },
  timeout: {
    en: "The counselor took too long to answer, so the request was stopped. Try again, or split a long question into smaller ones.",
    ko: "답변이 너무 오래 걸려서 요청을 중단했어요. 다시 시도하거나 긴 질문을 여러 개로 나눠 보내 주세요.",
  },
  empty_model_reply: {
    en: "The AI sent back an empty answer. Try sending your question again; rewording it a little can help.",
    ko: "AI가 빈 답변을 보냈어요. 질문을 다시 보내 주세요. 표현을 조금 바꾸면 도움이 될 수 있어요.",
  },
  duplicate: {
    en: "That message was already sent once. Check the conversation for its answer, or send it again.",
    ko: "이 메시지는 이미 한 번 보내졌어요. 대화에서 답변을 확인하거나 다시 보내 주세요.",
  },
  session_expired: {
    en: "Your sign-in has expired. Sign out and sign back in, then send your question again.",
    ko: "로그인이 만료되었어요. 로그아웃한 뒤 다시 로그인하고 질문을 다시 보내 주세요.",
  },
  too_large: {
    en: "Your message or files are too large to send. Try a shorter question or smaller files.",
    ko: "메시지나 파일이 너무 커서 보낼 수 없어요. 더 짧게 질문하거나 더 작은 파일을 사용해 주세요.",
  },
  network: {
    en: "Couldn't reach the counselor. Check your internet connection, then try again.",
    ko: "상담 서버에 연결할 수 없어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.",
  },
  generic_retry: {
    en: "Something went wrong while answering that. Trying again in a minute may help; if it keeps happening, let your counselor know.",
    ko: "답변하는 중에 문제가 생겼어요. 1분 뒤에 다시 시도하면 해결될 수 있어요. 계속 문제가 생기면 상담 선생님께 알려 주세요.",
  },
  generic_no_retry: {
    en: "Something went wrong while answering that. Sending the same message again probably won't help; try rewording it, or let your counselor know if it keeps happening.",
    ko: "답변하는 중에 문제가 생겼어요. 같은 메시지를 다시 보내도 해결되지 않을 가능성이 높아요. 표현을 바꿔 보거나, 계속 문제가 생기면 상담 선생님께 알려 주세요.",
  },
};

const pick = (entry, locale, arg) => {
  const value = entry[locale === "ko" ? "ko" : "en"];
  return typeof value === "function" ? value(arg) : value;
};

// The Retry-After header (express-rate-limit's standardHeaders) or the body's
// retryAfterSeconds, as whole seconds; null when neither is a usable number.
function retryAfterFrom(body, headers) {
  const fromBody = Number(body?.retryAfterSeconds);
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
  let header = null;
  try { header = headers?.get?.("Retry-After") ?? null; } catch { header = null; }
  const fromHeader = Number(header);
  return Number.isFinite(fromHeader) && fromHeader > 0 ? Math.ceil(fromHeader) : null;
}

export async function readErrorBody(response) {
  try { return (await response.json()) || {}; } catch { return {}; }
}

// The Error a non-2xx reply becomes. The routes send { error: "string" } or
// { error: { message } }; every field the copy needs rides along on the error.
export function chatErrorFromResponse(status, body = {}, headers = null) {
  const message = typeof body?.error === "string" ? body.error : (body?.error?.message || body?.message || `API ${status}`);
  const err = new Error(message);
  err.status = status;
  if (body?.code) err.code = String(body.code);
  // A policy block ({ blocked: true }) carries the counselor's own reply —
  // for an essay-ghostwriting request, the coaching redirect (brainstorm,
  // outline, feedback). It is an answer to show, not a failure to hide
  // behind "Something went wrong".
  if (body?.blocked === true) err.blocked = true;
  if (body?.budget) err.budget = body.budget;
  if (Array.isArray(body?.missing)) err.missing = body.missing;
  const retryAfter = retryAfterFrom(body, headers);
  if (retryAfter != null) err.retryAfterSeconds = retryAfter;
  err.body = body;
  return err;
}

// An OpenRouter 401/403 means the operator's key was refused, not that the
// student's session ended. Treated as a session expiry it set off a hidden
// sign-in on every call (spending the per-IP login limit a classroom shares)
// and a resend that the budget ledger refused as a reused request id.
export function isProviderAuthFailure(errOrBody) {
  const code = String(errOrBody?.code || "");
  return PROVIDER_AUTH_CODES.has(code) || errOrBody?.upstreamStatus === 401 || errOrBody?.upstreamStatus === 403;
}

// Whether a 401 means this student's session is gone. Our own session 401
// carries no code (or a session_* one); a 401 that names the provider is the
// provider's, whatever status an older server forwarded it with.
export function isSessionExpiry(status, body = {}) {
  if (status !== 401) return false;
  if (isProviderAuthFailure(body) || body?.provider) return false;
  const code = String(body?.code || "");
  return !code || /^session_/.test(code);
}

// The same question asked of a Response, for callers that still need its
// body: it reads a clone. A response with no clone (a test stub) counts as
// a session expiry, as every 401 did before.
export async function isSessionExpiryResponse(response) {
  if (response?.status !== 401) return false;
  let body = {};
  try { body = typeof response.clone === "function" ? ((await response.clone().json()) || {}) : {}; } catch { body = {}; }
  return isSessionExpiry(401, body);
}

export function isAbortError(err) {
  return err?.name === "AbortError";
}

// Whether sending the same thing again can help. A request the server cannot
// serve until something changes (budget, consent, configuration, a refused
// key, a malformed request) is not worth a retry.
export function chatErrorRetryable(err) {
  const code = String(err?.code || "");
  if (["monthly_cap_exceeded", "budget_exceeded", "unknown_model_pricing", "grade_required", "consent_required", "openrouter_not_configured", "OPENROUTER_NOT_CONFIGURED", "installation_setup_required"].includes(code)) return false;
  if (isProviderAuthFailure(err)) return false;
  const status = Number(err?.status);
  if (!Number.isFinite(status) || status === 0) return true; // network, timeout
  return status >= 500 || status === 429 || status === 409;
}

export function formatChatError(err, locale = "en-US") {
  const code = String(err?.code || "");
  const status = Number(err?.status) || 0;
  const message = String(err?.message || "");
  if (code === "monthly_cap_exceeded" || code === "budget_exceeded") {
    const remaining = Number(err?.budget?.remainingUsd);
    return pick(Number.isFinite(remaining) && remaining > 0.005 ? COPY.budget_short : COPY.budget_used, locale);
  }
  if (code === "unknown_model_pricing") return pick(COPY.unknown_model_pricing, locale);
  if (code === "grade_required") return pick(COPY.grade_required, locale);
  if (code === "consent_required") return pick(COPY.consent_required, locale);
  if (code === "rate_limited" || status === 429) return pick(COPY.rate_limited, locale, err?.retryAfterSeconds);
  if (/^(openrouter_not_configured|installation_setup_required)$/i.test(code)) return pick(COPY.not_configured, locale);
  if (isProviderAuthFailure(err)) return pick(COPY.provider_auth_failed, locale);
  if (code === "provider_timeout" || code === "client_timeout" || status === 504) return pick(COPY.timeout, locale);
  if (code === "empty_model_reply") return pick(COPY.empty_model_reply, locale);
  if (code === "provider_error" || code === "llm_error") return pick(COPY.provider_error, locale);
  if (code === "duplicate_request_id" || code === "request_id_conflict" || status === 409) return pick(COPY.duplicate, locale);
  if (status === 402) return pick(COPY.budget_used, locale);
  if (isSessionExpiry(status, err?.body || {})) return pick(COPY.session_expired, locale);
  if (status === 403 && /consent/i.test(message)) return pick(COPY.consent_required, locale);
  // Errors without a code: an older server, a network failure, the client's
  // own timeout. The English message is all there is to go on.
  const lower = message.toLowerCase();
  if (status === 413 || lower.includes("api 413") || lower.includes("too large")) return pick(COPY.too_large, locale);
  if (lower.includes("timed out") || lower.includes("took too long")) return pick(COPY.timeout, locale);
  if (lower.includes("rate limit") || lower.includes("too many requests")) return pick(COPY.rate_limited, locale);
  if (lower.includes("failed to fetch") || lower.includes("network")) return pick(COPY.network, locale);
  if (/no api key|not configured|must configure openrouter|missing .*api key/i.test(lower) || status === 503) return pick(COPY.not_configured, locale);
  return pick(chatErrorRetryable(err) ? COPY.generic_retry : COPY.generic_no_retry, locale);
}

// The client's own per-call timeout. Named apart from AbortError so a timeout
// is never shown as the student's Cancel.
export function clientTimeoutError(message = "The model call timed out") {
  const err = new Error(message);
  err.name = "TimeoutError";
  err.code = "client_timeout";
  return err;
}

// The error a Cancel turns into, named as fetch names an aborted request so
// every catch treats both the same.
export function cancelledError() {
  const err = new Error("Cancelled");
  err.name = "AbortError";
  return err;
}
