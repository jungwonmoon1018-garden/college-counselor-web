import { formatCrisisReply, isCrisisReplyBody } from "../chat/crisis-lexicon.js";
import { chatErrorFromResponse, formatChatError } from "../chat/chat-errors.js";

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
const SHARED_CODES = new Set(["rate_limited", "provider_error", "provider_auth_failed", "provider_auth_rejected", "auth_rejected", "provider_timeout", "empty_model_reply", "unknown_model_pricing", "grade_required", "openrouter_not_configured", "installation_setup_required"]);

export function councilErrorMessage(status, body = {}, locale = "en-US") {
  const ko = locale === "ko";
  const serverMessage = typeof body?.error === "string"
    ? body.error
    : (body?.error?.message || body?.message || "");
  const code = String(body?.code || "");
  if (code === "COUNCIL_PROVIDER_UNAVAILABLE") {
    return ko
      ? "지금 AI 서비스에 연결할 수 없어서 전략 위원회가 검토를 마치지 못했어요. 학생의 정보가 부족해서가 아니에요. 잠시 후 다시 시도해 주세요."
      : "The Strategy Council couldn't reach the AI service just now, so it stopped before reviewing your question. It isn't about your profile; try again in a little while.";
  }
  if (SHARED_CODES.has(code) || status === 429) {
    return formatChatError(chatErrorFromResponse(status, body), locale);
  }
  if (status === 402) {
    return ko
      ? "이번 전략 위원회 검토는 남은 월간 AI 예산을 초과합니다. 일반 채팅을 사용하거나 다음 예산 주기를 기다려 주세요."
      : "This Strategy Council review does not fit your remaining monthly AI budget. Use ordinary chat or wait for the next budget cycle.";
  }
  if (status === 403) {
    return ko
      ? "전략 위원회를 사용하려면 필수 AI 및 데이터 전송 동의가 필요합니다."
      : "Required AI and data-transfer consent is needed before using Strategy Council.";
  }
  if (status === 409) {
    return ko
      ? "이 전략 위원회 요청은 이미 처리되었습니다. 채팅 기록에서 기존 결과를 확인하세요."
      : "This Strategy Council request was already processed. Check the conversation for its existing result.";
  }
  if (status === 503) {
    return ko
      ? "현재 이 기기에서 전략 위원회를 사용할 수 없습니다. 관리자 설정을 확인해 주세요."
      : "Strategy Council is unavailable on this device. Ask the administrator to check its configuration.";
  }
  return serverMessage || (ko ? "전략 위원회 요청에 실패했습니다." : "The Strategy Council request failed.");
}
