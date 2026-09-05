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
  });

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
  });
});
