import { formatCrisisReply, isCrisisReplyBody } from "../chat/crisis-lexicon.js";
import { chatErrorFromResponse, formatChatError, isProviderAuthFailure } from "../chat/chat-errors.js";

export const COUNCIL_DECISION_OPTIONS = Object.freeze([
  Object.freeze({ value: "course-selection", label: "Course selection", labelKo: "과목 선택" }),
  Object.freeze({ value: "college-list", label: "College list", labelKo: "대학 목록" }),
  Object.freeze({ value: "ec-strategy", label: "Activity strategy", labelKo: "활동 전략" }),
  Object.freeze({ value: "narrative-arc", label: "Personal narrative", labelKo: "개인 서사" }),
  Object.freeze({ value: "other", label: "Other strategy", labelKo: "기타 전략" }),
]);

const VALID_TYPES = new Set(COUNCIL_DECISION_OPTIONS.map((option) => option.value));

export function reconcileCouncilFailureMessages(messages, clientTurnId, errorText) {
  const prior = Array.isArray(messages) ? messages : [];
  const retained = clientTurnId
    ? prior.filter((message) => message?.clientTurnId !== clientTurnId)
    : prior;
  return [
    ...retained,
    { role: "assistant", content: String(errorText || ""), transient: true },
  ];
}

export function createCouncilPayload(question, decisionType) {
  const text = String(question || "").trim();
  if (!text) throw new Error("A self-contained Council question is required.");
  if (text.length > 2000) throw new Error("Council questions are limited to 2,000 characters.");
  if (!VALID_TYPES.has(decisionType)) throw new Error("Choose a valid Council decision type.");
  return {
    question: text,
    explicit: true,
    auto: false,
    decision_type: decisionType,
  };
}

function decisionLabel(decisionType, locale = "en-US") {
  const option = COUNCIL_DECISION_OPTIONS.find((item) => item.value === decisionType);
  if (!option) return locale === "ko" ? "전략" : "Strategy";
  return locale === "ko" ? option.labelKo : option.label;
}

export function councilThreadTitle(decisionType, locale = "en-US") {
  const label = decisionLabel(decisionType, locale);
  return locale === "ko" ? `전략 위원회: ${label}` : `Strategy Council: ${label}`;
}

export function formatCouncilResult(body = {}, locale = "en-US") {
  // One renderer for every deterministic crisis body (formatCrisisReply in
  // chat/crisis-lexicon.js): the server now writes the resources into `answer`,
  // and a resource list rendered here as well would show every line twice.
  if (isCrisisReplyBody(body)) {
    const ko = locale === "ko";
    return {
      text: formatCrisisReply(body, locale),
      blocked: true,
      crisisSafe: true,
      threadTitle: ko ? "지원 안내" : "Support resources",
      council: false,
    };
  }

  const recommendation = String(body.recommendation || "").trim();
  if (!recommendation) throw new Error("The Strategy Council returned no recommendation.");

  const ko = locale === "ko";
  const parts = [
    ko ? "**전략 위원회 권고안**" : "**Strategy Council recommendation**",
    recommendation,
  ];
  const confidence = Number(body.confidence);
  if (Number.isFinite(confidence)) {
    const percent = Math.round(Math.max(0, Math.min(1, confidence)) * 100);
    parts.push(ko ? `**신뢰도:** ${percent}%` : `**Confidence:** ${percent}%`);
  }

  const dissents = Array.isArray(body.dissents) ? body.dissents : [];
  const visibleDissents = dissents
    .map((item) => (typeof item === "string"
      ? { role: ko ? "검토자" : "Reviewer", text: item.trim() }
      : {
        role: String(item?.from || item?.role || (ko ? "검토자" : "Reviewer")).trim(),
        text: String(item?.text || item?.recommendation || "").trim(),
      }))
    .filter((item) => item.text);
  if (visibleDissents.length) {
    parts.push(ko ? "**남아 있는 이견**" : "**Unresolved dissent**");
    for (const item of visibleDissents) parts.push(`- **${item.role}:** ${item.text}`);
  }

  const citations = [
    ...(Array.isArray(body.citations) ? body.citations : []),
    ...dissents.flatMap((item) => Array.isArray(item?.citations) ? item.citations : []),
  ];
  const validated = citations.filter((item) => item?.validated === true).length;
  parts.push(
    ko
      ? `**검증된 근거 참조:** ${validated}개`
      : `**Validated evidence references:** ${validated}`,
  );

  const actualCost = Number(body.usage?.actual_usd);
  if (Number.isFinite(actualCost)) {
    parts.push(ko ? `**이번 검토 비용:** $${actualCost.toFixed(4)}` : `**Review cost:** $${actualCost.toFixed(4)}`);
  }
  parts.push(
    ko
      ? "_AI가 생성한 자문입니다. 중요한 결정을 내리기 전에 근거를 독립적으로 확인하세요._"
      : "_AI-generated advisory analysis. Verify the evidence independently before making an important decision._",
  );

  return {
    text: parts.join("\n\n"),
    blocked: false,
    council: true,
    threadTitle: councilThreadTitle(body.decision_type, locale),
  };
}

// The client's deadline for one Council run. Four seats run in series, each
// with up to two tries against the adapter's 105-second budget, so a stalled
// provider held a Council turn for many minutes with no way out; a healthy
// run takes well under this.
export const COUNCIL_CLIENT_TIMEOUT_MS = 5 * 60_000;

export function councilTimeoutMessage(locale = "en-US") {
  return locale === "ko"
    ? "전략 위원회 검토가 5분 넘게 걸려서 중단했어요. 질문은 입력창에 다시 넣어 두었어요. 잠시 후 다시 시도하거나 일반 채팅을 사용해 주세요."
    : "The Strategy Council took more than 5 minutes, so the request was stopped. Your question is back in the message box; try again in a little while, or use ordinary chat.";
}

// Codes the Council route shares with /api/chat (consent, rate limit,
// provider failures) get the chat copy; the Council's own cases keep theirs.
const SHARED_CODES = new Set(["rate_limited", "provider_error", "provider_auth_failed", "provider_auth_rejected", "auth_rejected", "provider_timeout", "empty_model_reply", "unknown_model_pricing", "grade_required", "openrouter_not_configured", "installation_setup_required", "session_invalid", "request_cancelled"]);

// What the client checks before sending (createCouncilPayload); the server
// refusing one anyway means the question did not arrive as written.
const QUESTION_CODES = new Set(["COUNCIL_QUESTION_INVALID", "COUNCIL_QUESTION_MISSING", "COUNCIL_QUESTION_TOO_LONG"]);

// The Council's own wiring: the explicit-action flag, the decision type,
// the budget plumbing. Nothing the student wrote, and nothing a resend fixes.
const REQUEST_CODES = new Set(["COUNCIL_EXPLICIT_ACTION_REQUIRED", "COUNCIL_DECISION_TYPE_INVALID", "request_failed"]);

const COUNCIL_COPY = {
  outage: {
    en: "The Strategy Council couldn't reach the AI service just now, so it stopped before reviewing your question. It isn't about your profile; try again in a little while.",
    ko: "지금 AI 서비스에 연결할 수 없어서 전략 위원회가 검토를 마치지 못했어요. 학생의 정보가 부족해서가 아니에요. 잠시 후 다시 시도해 주세요.",
  },
  budget: {
    en: "This Strategy Council review does not fit your remaining monthly AI budget. Use ordinary chat or wait for the next budget cycle.",
    ko: "이번 전략 위원회 검토는 남은 월간 AI 예산을 초과합니다. 일반 채팅을 사용하거나 다음 예산 주기를 기다려 주세요.",
  },
  consent: {
    en: "Required AI and data-transfer consent is needed before using Strategy Council.",
    ko: "전략 위원회를 사용하려면 필수 AI 및 데이터 전송 동의가 필요합니다.",
  },
  duplicate: {
    en: "This Strategy Council request was already processed. Check the conversation for its existing result.",
    ko: "이 전략 위원회 요청은 이미 처리되었습니다. 채팅 기록에서 기존 결과를 확인하세요.",
  },
  question: {
    en: "The Strategy Council couldn't read that question. Write it as one question of 2,000 characters or fewer and send it again.",
    ko: "전략 위원회가 이 질문을 읽지 못했어요. 2,000자 이하의 질문 하나로 작성해서 다시 보내 주세요.",
  },
  request: {
    en: "The Strategy Council couldn't process that request. Reload the page and try again; if it keeps happening, let your counselor know.",
    ko: "전략 위원회가 이 요청을 처리하지 못했어요. 페이지를 새로 고친 뒤 다시 시도해 주세요. 계속 문제가 생기면 상담 선생님께 알려 주세요.",
  },
  unavailable: {
    en: "Strategy Council isn't available on this site right now. Ordinary chat still works; please let your counselor know.",
    ko: "지금 이 사이트에서는 전략 위원회를 사용할 수 없어요. 일반 채팅은 계속 사용할 수 있어요. 상담 선생님께 알려 주세요.",
  },
  server: {
    en: "The Strategy Council ran into a problem on the server. Try again in a little while; if it keeps happening, let your counselor know.",
    ko: "전략 위원회 서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요. 계속 문제가 생기면 상담 선생님께 알려 주세요.",
  },
  failed: {
    en: "The Strategy Council request failed.",
    ko: "전략 위원회 요청에 실패했습니다.",
  },
};

const councilCopy = (key, locale) => COUNCIL_COPY[key][locale === "ko" ? "ko" : "en"];

// The route's real shapes: a provider failure is 502/504 with the shared
// code (provider_error, provider_auth_failed, provider_timeout) and
// councilCode COUNCIL_PROVIDER_UNAVAILABLE beside it; a limiter's 429 is
// rate_limited JSON; the Council's own refusals are upper-case codes; a
// blocked question carries the screen's reply. The outage check read `code`
// alone, so the Council's outage copy never showed, and every 400 and 500
// handed a Korean student the server's English.
export function councilErrorMessage(status, body = {}, locale = "en-US", headers = null) {
  const serverMessage = typeof body?.error === "string"
    ? body.error
    : (body?.error?.message || body?.message || "");
  const code = String(body?.code || "");
  const councilCode = String(body?.councilCode || "");
  // A blocked question shows the screen's own reply, as ordinary chat does.
  if (body?.blocked === true && serverMessage) return serverMessage;
  const shared = () => formatChatError(chatErrorFromResponse(status, body, headers), locale);
  // A refused key is the site's to fix, not an outage to wait out.
  if (isProviderAuthFailure(body)) return shared();
  if (councilCode === "COUNCIL_PROVIDER_UNAVAILABLE" || code === "COUNCIL_PROVIDER_UNAVAILABLE") return councilCopy("outage", locale);
  if (SHARED_CODES.has(code) || status === 429 || status === 401) return shared();
  if (QUESTION_CODES.has(code)) return councilCopy("question", locale);
  if (REQUEST_CODES.has(code)) return councilCopy("request", locale);
  if (status === 402) return councilCopy("budget", locale);
  if (status === 403) return councilCopy("consent", locale);
  if (status === 409) return councilCopy("duplicate", locale);
  if (status === 503) return councilCopy("unavailable", locale);
  if (status >= 500) return councilCopy("server", locale);
  if (locale === "ko") return councilCopy("failed", locale);
  return serverMessage || councilCopy("failed", locale);
}
