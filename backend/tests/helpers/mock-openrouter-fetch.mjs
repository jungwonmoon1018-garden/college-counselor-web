import fs from "node:fs";

const realFetch = globalThis.fetch;
const callLogPath = process.env.TEST_OPENROUTER_CALL_LOG;
// The catalog carries a creation date (a month ago) and text modalities so
// the model-catalog scout can classify rows. Gemma 4 31B and the last four
// ids are NOT in the packaged tier list: the scout discovers them (small,
// small, medium, large) and must skip the ":batch" routing variant.
const CATALOG_CREATED = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
const models = [
  { id: "deepseek/deepseek-v4-flash-0731" },
  { id: "deepseek/deepseek-v4-pro" },
  { id: "anthropic/claude-sonnet-5" },
  { id: "google/gemma-4-26b-a4b-it" },
  { id: "google/gemma-4-31b-it" },
  { id: "qwen/qwen3.8-flash", prompt: "0.0000001", completion: "0.0000004" },
  { id: "google/gemini-3.8-flash", prompt: "0.0000005", completion: "0.000003" },
  { id: "openai/gpt-6-astra", prompt: "0.000005", completion: "0.000015" },
  { id: "openai/gpt-6-astra:batch", prompt: "0.0000025", completion: "0.0000075" },
];

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url;

  if (url === "https://openrouter.ai/api/v1/models") {
    return Response.json({
      data: models.map((m) => ({
        id: m.id,
        name: m.id,
        context_length: 32_768,
        created: CATALOG_CREATED,
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        pricing: { prompt: m.prompt || "0.0000001", completion: m.completion || "0.0000002" },
      })),
    });
  }

  if (url === "https://openrouter.ai/api/v1/chat/completions") {
    const body = JSON.parse(String(init.body || "{}"));
    if (callLogPath) fs.appendFileSync(callLogPath, `${JSON.stringify(body)}\n`, "utf8");
    // Transcript-parse requests (identified by their prompt) get valid
    // transcript JSON; everything else gets the auto-name style title reply.
    // A test can script the reply by embedding base64 markers in its message:
    // MOCKREPLY:<base64>: is the first answer, MOCKRETRY:<base64>: the answer
    // to the chat route's fidelity-correction retry (identified by the
    // correction text in the wire).
    const wire = JSON.stringify(body.messages || []);
    const isTranscriptParse = wire.includes("Transcript text:");
    const scripted = wire.includes("FIDELITY CORRECTION")
      ? (wire.match(/MOCKRETRY:([A-Za-z0-9+/=]+):/) || wire.match(/MOCKREPLY:([A-Za-z0-9+/=]+):/))
      : wire.match(/MOCKREPLY:([A-Za-z0-9+/=]+):/);
    const content = isTranscriptParse
      ? JSON.stringify({
        gpa: 3.8,
        years: {
          freshman: [], sophomore: [],
          junior: [{ name: "AP Calculus BC", type: "ap", grade: "A", semester: "full_year" }],
          senior: [], unknown: [],
        },
      })
      : scripted
        ? Buffer.from(scripted[1], "base64").toString("utf8")
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

  // College Scorecard API — canned result echoing the requested school name
  // (the picker requires a genuine name match now), so the positioning
  // route's Scorecard fallback can be exercised without the network.
  if (String(url || "").startsWith("https://api.data.gov/ed/collegescorecard/")) {
    const requestedName = new URL(url).searchParams.get("school.name") || "Stony Brook University";
    return Response.json({
      metadata: { total: 1, page: 0 },
      results: [{
        id: 196097,
        "school.name": requestedName,
        "school.state": "NY",
        "school.city": "Testville",
        "school.school_url": "https://www.example-university.edu/",
        "school.ownership": 1,
        "latest.admissions.admission_rate.overall": 0.49,
        "latest.admissions.sat_scores.25th_percentile.critical_reading": 650,
        "latest.admissions.sat_scores.25th_percentile.math": 680,
        "latest.admissions.sat_scores.75th_percentile.critical_reading": 720,
        "latest.admissions.sat_scores.75th_percentile.math": 770,
        "latest.student.size": 17000,
      }],
    });
  }

  // The CDS repository index — return an empty page so live CDS resolution
  // finds nothing and the route exercises its fallbacks.
  if (String(url || "").includes("collegetransitions.com")) {
    return new Response("<html><body></body></html>", { headers: { "Content-Type": "text/html" } });
  }

  if (/^https?:/i.test(String(url || ""))) {
    throw new Error(`Unexpected external request in route integration test: ${url}`);
  }

  return realFetch(input, init);
};
