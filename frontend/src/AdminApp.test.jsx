import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminApp from "./AdminApp.jsx";

describe("AdminApp", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("bootstraps through the protected same-origin administrator API", async () => {
    fetch.mockImplementation(async (path) => {
      if (path === "/api/admin/status") return { ok:true, json:async()=>({ bootstrapped:false, webDeployment:true }) };
      if (path === "/api/admin/bootstrap") return { ok:true, json:async()=>({ authenticated:true, csrfToken:"web-csrf", recoveryCode:"web-recovery" }) };
      if (path === "/api/admin/secrets/status") return { ok:true, json:async()=>({ webDeployment:true, installationReady:false, encryption:{configured:false,mutable:true}, openrouter:{configured:false}, scorecard:{configured:false} }) };
      if (path === "/api/admin/models") return { ok:true, json:async()=>({ models:{small:"small",medium:"medium",large:"large"}, options:[] }) };
      return { ok:false, json:async()=>({ error:"unexpected request" }) };
    });

    const user = userEvent.setup();
    render(<AdminApp />);
    await screen.findByRole("heading", { name:"Create administrator account" });
    await user.type(screen.getByLabelText("Website setup token"), "deployment-bootstrap-token");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Confirm password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name:"Create administrator" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/admin/bootstrap",
      expect.objectContaining({ headers:expect.objectContaining({ "X-Web-Setup-Token":"deployment-bootstrap-token" }) }),
    ));
    expect(await screen.findByText("web-recovery")).toBeVisible();
    expect(await screen.findByText("Student access stays closed until all three secrets are configured.")).toBeVisible();
  // Typing three long strings through userEvent takes a couple of seconds
  // in jsdom, and vitest 4.1.11 queues each test's steps behind the other
  // files' (its revived lifecycle concurrency limit), so the whole-suite
  // run crossed the 5 s default while the file alone stayed under 3 s.
  }, 20_000);

  it("shows the models the catalog scout found, grouped by price band, with a manual check and dismiss", async () => {
    const ok = (body) => ({ ok:true, json:async()=>body });
    const found = {
      id:"google/gemini-3.8-flash", label:"Google: Gemini 3.8 Flash", discovered:true, tier:"medium", status:"listed",
      firstSeen:"2026-09-05T10:00:00.000Z", createdAt:"2026-08-20T00:00:00.000Z", available:true,
      contextLength:1_000_000, pricing:{ inputPerMTok:0.5, outputPerMTok:3 },
    };
    const page = () => ({
      models:{ small:"google/gemma-4-26b-a4b-it", medium:"deepseek/deepseek-v4-flash-0731", large:"openai/gpt-5.6-luna" },
      options:[
        { id:"google/gemma-4-26b-a4b-it", label:"Google Gemma 4 26B A4B", available:true },
        { id:"deepseek/deepseek-v4-flash-0731", label:"DeepSeek V4 Flash 0731", available:true },
        { id:"openai/gpt-5.6-luna", label:"OpenAI GPT-5.6 Luna", available:true },
        found,
      ],
      candidates:[found],
      catalogScout:{ enabled:true, cadenceDays:14, due:false, nextRunAt:"2026-09-19T10:00:00.000Z", lastRun:{ trigger:"boot", finishedAt:"2026-09-05T10:00:00.000Z", catalogCount:431, eligible:106, added:3 } },
    });
    fetch.mockImplementation(async (path) => {
      if (path === "/api/admin/status") return ok({ bootstrapped:true, webDeployment:true });
      if (path === "/api/admin/login") return ok({ authenticated:true, csrfToken:"web-csrf" });
      if (path === "/api/admin/secrets/status") return ok({ webDeployment:true, installationReady:true, encryption:{configured:true}, openrouter:{configured:true}, scorecard:{configured:true} });
      if (path === "/api/admin/models") return ok(page());
      if (path === "/api/admin/models/scout/run") return ok({ ok:true, summary:{ trigger:"manual", catalogCount:431, eligible:106, added:[] }, ...page() });
      if (path === "/api/admin/models/candidates") return ok({ modelId:"google/gemini-3.8-flash", status:"dismissed" });
      return { ok:false, json:async()=>({ error:"unexpected request" }) };
    });

    const user = userEvent.setup();
    render(<AdminApp />);
    await screen.findByRole("heading", { name:"Administrator sign in" });
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name:"Sign in" }));

    // Each tier picker carries the reviewed group plus one group per price
    // band the scout found something in — the found model is inside it.
    await screen.findByRole("heading", { name:"New models found by the catalog scout" });
    expect(screen.getAllByRole("group", { name:"Reviewed models" })).toHaveLength(3);
    const scoutGroups = screen.getAllByRole("group", { name:"Found by the scout · Mid band · $1 to $6 per 1M tokens" });
    expect(scoutGroups).toHaveLength(3);
    expect(screen.getAllByRole("option", { name:"Google: Gemini 3.8 Flash · found 2026-09-05" })).toHaveLength(3);
    expect(screen.queryByRole("group", { name:/Low band/ })).toBeNull();

    // The review panel: schedule, the model with its facts, dismiss.
    expect(screen.getByText(/Last check: .* \(boot\) · 431 models in the catalog · 106 eligible · 3 new/)).toBeVisible();
    expect(screen.getByText(/Next automatic check: .* \(every 14 days\)/)).toBeVisible();
    expect(screen.getByText("google/gemini-3.8-flash")).toBeVisible();
    expect(screen.getByText("$0.50 in / $3.00 out per 1M tokens · 1000k context · released 2026-08-20 · found 2026-09-05")).toBeVisible();

    await user.click(screen.getByRole("button", { name:"Check the catalog now" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/admin/models/scout/run",
      expect.objectContaining({ method:"POST", headers:expect.objectContaining({ "X-CSRF-Token":"web-csrf" }) }),
    ));
    expect(await screen.findByText("Catalog checked: 431 models, 106 eligible, 0 new.")).toBeVisible();

    await user.click(screen.getByRole("button", { name:"Dismiss google/gemini-3.8-flash" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/admin/models/candidates",
      expect.objectContaining({ method:"POST", body:JSON.stringify({ modelId:"google/gemini-3.8-flash", status:"dismissed" }) }),
    ));
    // Every tier works and the last sweep read its schools: no banner.
    expect(screen.queryByText(/Requests on a tier below are failing/)).toBeNull();
    expect(screen.queryByText(/admissions-policy sweep/)).toBeNull();
  }, 20_000);

  // A tier whose model was dropped from the allowlist, or that OpenRouter no
  // longer lists, failed every student's request with nothing on this page
  // to say why; a sweep or a catalog check that read nothing looked like a
  // normal run two weeks from its next attempt.
  it("names each tier whose model cannot be called, and says when a failed check or sweep retries", async () => {
    const ok = (body) => ({ ok:true, json:async()=>body });
    fetch.mockImplementation(async (path) => {
      if (path === "/api/admin/status") return ok({ bootstrapped:true, webDeployment:true });
      if (path === "/api/admin/login") return ok({ authenticated:true, csrfToken:"web-csrf" });
      if (path === "/api/admin/secrets/status") return ok({ webDeployment:true, installationReady:true, encryption:{configured:true}, openrouter:{configured:true}, scorecard:{configured:true} });
      if (path === "/api/admin/models") return ok({
        models:{ small:"google/gemma-4-26b-a4b-it", medium:"google/gemini-4-flash", large:"openai/gpt-5.6-luna" },
        options:[{ id:"google/gemma-4-26b-a4b-it", label:"Google Gemma 4 26B A4B", available:true }],
        candidates:[],
        tierStatus:{
          small:{ model:"google/gemma-4-26b-a4b-it", status:"ok" },
          medium:{ model:"google/gemini-4-flash", status:"not_in_allowlist" },
          large:{ model:"openai/gpt-5.6-luna", status:"not_in_catalog" },
        },
        catalogScout:{ enabled:true, cadenceDays:14, due:false, nextRunAt:"2026-11-03T11:05:00.000Z", lastRun:{ trigger:"boot", outcome:"failed", finishedAt:"2026-11-03T10:05:00.000Z", catalogCount:0, eligible:0, added:0 } },
      });
      if (path === "/api/admin/policy-scout/status") return ok({
        running:false, cadenceDays:14, nextRunAt:"2026-11-03T11:05:00.000Z", nextRunReason:"retry_after_failure",
        lastAutomaticSweep:{ trigger:"boot", outcome:"failed", finishedAt:"2026-11-03T10:05:00.000Z", schoolsTotal:300, schoolsChecked:0, schoolsFailed:300 },
      });
      return { ok:false, json:async()=>({ error:"unexpected request" }) };
    });

    const user = userEvent.setup();
    render(<AdminApp />);
    await screen.findByRole("heading", { name:"Administrator sign in" });
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name:"Sign in" }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Requests on a tier below are failing. Choose another model for that tier and save.");
    expect(banner).toHaveTextContent("Mid tier: google/gemini-4-flash is no longer on the allowed model list, so every request on this tier is refused.");
    expect(banner).toHaveTextContent("High tier: OpenRouter no longer lists openai/gpt-5.6-luna.");
    expect(banner).not.toHaveTextContent("Low tier");
    expect(await screen.findByText(/The last admissions-policy sweep \(.*\) read none of its 300 schools \(300 failed\)\. It retries on its own: /)).toBeVisible();
    expect(screen.getByText(/The last check could not read OpenRouter's live catalog\. It retries on its own: /)).toBeVisible();
    expect(screen.queryByText(/every 14 days/)).toBeNull();
  }, 20_000);

  // A cold start's 502 on the status request used to read as "no
  // administrator yet" and show the create-administrator form (ui-12).
  it("a failed status request offers a retry, never the create-administrator form", async () => {
    let statusCalls = 0;
    fetch.mockImplementation(async (path) => {
      if (path === "/api/admin/status") {
        statusCalls += 1;
        return statusCalls === 1
          ? { ok:false, status:502, json:async()=>({ error:"Bad gateway" }) }
          : { ok:true, json:async()=>({ bootstrapped:true, webDeployment:true }) };
      }
      return { ok:false, json:async()=>({ error:"unexpected request" }) };
    });

    const user = userEvent.setup();
    render(<AdminApp />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The administrator status could not be loaded");
    expect(screen.queryByRole("heading", { name:"Create administrator account" })).toBeNull();
    expect(screen.queryByLabelText("Confirm password")).toBeNull();

    await user.click(screen.getByRole("button", { name:"Try again" }));
    expect(await screen.findByRole("heading", { name:"Administrator sign in" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(statusCalls).toBe(2);
  }, 20_000);
});
