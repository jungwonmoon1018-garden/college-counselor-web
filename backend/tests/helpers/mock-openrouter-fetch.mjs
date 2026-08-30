import fs from "node:fs";

const realFetch = globalThis.fetch;
const callLogPath = process.env.TEST_OPENROUTER_CALL_LOG;
const models = [
  "deepseek/deepseek-v4-flash-0731",
  "deepseek/deepseek-v4-pro",
  "anthropic/claude-sonnet-5",
  "google/gemma-4-26b-a4b-it",
  "google/gemma-4-31b-it",
];

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url;

  if (url === "https://openrouter.ai/api/v1/models") {
    return Response.json({
      data: models.map((id) => ({
        id,
        name: id,
        context_length: 32_768,
        pricing: { prompt: "0.0000001", completion: "0.0000002" },
      })),
    });
  }

  if (url === "https://openrouter.ai/api/v1/chat/completions") {
    const body = JSON.parse(String(init.body || "{}"));
    if (callLogPath) fs.appendFileSync(callLogPath, `${JSON.stringify(body)}\n`, "utf8");
    // Transcript-parse requests (identified by their prompt) get valid
    // transcript JSON; everything else gets the auto-name style title reply.
    const isTranscriptParse = JSON.stringify(body.messages || []).includes("Transcript text:");
    const content = isTranscriptParse
      ? JSON.stringify({
        gpa: 3.8,
        years: {
          freshman: [], sophomore: [],
          junior: [{ name: "AP Calculus BC", type: "ap", grade: "A", semester: "full_year" }],
          senior: [], unknown: [],
        },
      })
      : "\"Junior Year Course Plan.\"";
    return Response.json({
      id: "mock-completion",
      model: body.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    });
  }

  if (/^https?:/i.test(String(url || ""))) {
    throw new Error(`Unexpected external request in route integration test: ${url}`);
  }

  return realFetch(input, init);
};
