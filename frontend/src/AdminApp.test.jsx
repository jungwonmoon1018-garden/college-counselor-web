import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminApp from "./AdminApp.jsx";

describe("AdminApp", () => {
  let bootstrap;
  let status;

  beforeEach(() => {
    bootstrap = vi.fn().mockResolvedValue({ authenticated:true, csrfToken:"csrf", recoveryCode:"recover-once" });
    status = vi.fn().mockResolvedValue({ secrets:{ encryption:{configured:true}, openrouter:{configured:false}, scorecard:{configured:false} } });
    Object.defineProperty(window, "collegeCounselorDesktop", {
      configurable:true,
      value:{ adminAuth:{ bootstrap, recover:vi.fn() }, adminSecrets:{ status, set:vi.fn(), clear:vi.fn() } },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok:true, json:async()=>({bootstrapped:false}) }));
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("bootstraps through privileged IPC and never posts the password from the renderer", async () => {
    const user = userEvent.setup();
    render(<AdminApp />);
    await screen.findByRole("heading", { name:"Create administrator account" });
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Confirm password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name:"Create administrator" }));

    await waitFor(() => expect(bootstrap).toHaveBeenCalledWith("correct horse battery staple"));
    expect(status).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("recover-once")).toBeVisible();
  });

  it("bootstraps a website through the protected same-origin admin API", async () => {
    Object.defineProperty(window, "collegeCounselorDesktop", { configurable:true, value:undefined });
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
});
