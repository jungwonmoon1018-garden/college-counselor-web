import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { resetSafeStorageMemory, safeGet, safeGetJson, safeRemove, safeSet } from "./safe-storage.js";
import { detectLocale, saveLocale } from "../i18n.js";
import { getLocale, deadlines } from "../api.js";
import { storageApi } from "./vault-storage.js";
import App from "../App.jsx";

// Chrome with site data blocked (and some school-managed devices and in-app
// webviews) throws a SecurityError from the localStorage getter itself.
// Locale detection read it bare during App's first render, so those
// students got the crash page instead of the login screen; api.js's copy
// threw on every call.
function blockStorage() {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() { throw new DOMException("The operation is insecure.", "SecurityError"); },
  });
  return () => {
    if (original) Object.defineProperty(window, "localStorage", original);
    else delete window.localStorage;
  };
}

function setNavigatorLanguage(language) {
  const original = Object.getOwnPropertyDescriptor(window.navigator, "language");
  Object.defineProperty(window.navigator, "language", { configurable: true, get: () => language });
  return () => {
    if (original) Object.defineProperty(window.navigator, "language", original);
    else delete window.navigator.language;
  };
}

// Node 22+ ships its own localStorage global, which shadows jsdom's and
// lacks a backing file under vitest, so these tests use a memory stand-in
// as App.test.jsx does.
function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

describe("safe-storage with working storage", () => {
  beforeEach(() => { vi.stubGlobal("localStorage", memoryStorage()); resetSafeStorageMemory(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("round-trips through localStorage", () => {
    expect(safeSet("k", "v")).toBe(true);
    expect(window.localStorage.getItem("k")).toBe("v");
    expect(safeGet("k")).toBe("v");
    safeRemove("k");
    expect(safeGet("k")).toBeNull();
  });

  it("reads a value another writer changed, not a stale copy", () => {
    safeSet("k", "first");
    window.localStorage.setItem("k", "second");
    expect(safeGet("k")).toBe("second");
  });

  // Storage that still reads but refuses writes (a full quota) held the new
  // value in memory while safeGet went on returning the old stored one, so
  // the API kept sending en-US after the student switched to Korean.
  it("reads a write storage refused ahead of the stale stored value", () => {
    window.localStorage.setItem("cc_locale", "en-US");
    const setItem = window.localStorage.setItem;
    window.localStorage.setItem = () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); };
    expect(safeSet("cc_locale", "ko")).toBe(false);
    expect(safeGet("cc_locale")).toBe("ko");
    expect(getLocale()).toBe("ko");
    // Once a write lands again, storage is the authority once more.
    window.localStorage.setItem = setItem;
    expect(safeSet("cc_locale", "en-US")).toBe(true);
    window.localStorage.setItem("cc_locale", "ko");
    expect(safeGet("cc_locale")).toBe("ko");
  });

  it("returns the fallback for unreadable JSON", () => {
    window.localStorage.setItem("j", "{not json");
    expect(safeGetJson("j", [])).toEqual([]);
    expect(safeGetJson("missing", { a: 1 })).toEqual({ a: 1 });
  });

  it("accepts only a locale the app has strings for", () => {
    window.localStorage.setItem("cc_locale", "fr-FR");
    const restore = setNavigatorLanguage("en-US");
    try {
      expect(detectLocale()).toBe("en-US");
      expect(getLocale()).toBe("en-US");
      expect(saveLocale("fr-FR")).toBe(false);
      saveLocale("ko");
      expect(getLocale()).toBe("ko");
    } finally {
      restore();
    }
  });
});

describe("safe-storage with site data blocked", () => {
  let unblock;
  beforeEach(() => { resetSafeStorageMemory(); unblock = blockStorage(); });
  afterEach(() => { unblock(); cleanup(); vi.unstubAllGlobals(); });

  it("never throws and holds values in memory for the page load", () => {
    expect(() => window.localStorage).toThrow();
    expect(safeGet("k")).toBeNull();
    expect(safeSet("k", "v")).toBe(false);
    expect(safeGet("k")).toBe("v");
    safeRemove("k");
    expect(safeGet("k")).toBeNull();
  });

  it("detects the locale from the browser language instead of throwing", () => {
    const restoreKo = setNavigatorLanguage("ko-KR");
    try {
      expect(detectLocale()).toBe("ko");
    } finally {
      restoreKo();
    }
    const restoreEn = setNavigatorLanguage("en-GB");
    try {
      expect(detectLocale()).toBe("en-US");
      saveLocale("ko");
      expect(detectLocale()).toBe("ko");
    } finally {
      restoreEn();
    }
  });

  it("api calls still go out, carrying the locale", async () => {
    const restore = setNavigatorLanguage("en-US");
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ deadlines: [] }), text: async () => "{}" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await deadlines.list();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain("locale=en-US");
    } finally {
      restore();
    }
  });

  it("the vault wrapper reads, writes and deletes without throwing", async () => {
    await expect(storageApi.set("cv4_x", "blob")).resolves.toBeUndefined();
    expect((await storageApi.get("cv4_x")).value).toBe("blob");
    await storageApi.delete("cv4_x");
    expect((await storageApi.get("cv4_x")).value).toBeNull();
  });

  it("the student app reaches the login screen", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    render(<App />);
    expect(await screen.findByText("Welcome back", {}, { timeout: 15_000 })).toBeVisible();
    expect(screen.queryByText(/Something went wrong/i)).not.toBeInTheDocument();
  }, 20_000);
});

// A source check standing in for a lint rule (the frontend has no eslint):
// every localStorage touch goes through safe-storage.js. App.jsx's locale
// write was the last one outside it and now goes through i18n's saveLocale.
describe("no bare localStorage outside safe-storage", () => {
  const SRC = path.resolve(__dirname, "..");
  const ALLOWED = new Set(["session/safe-storage.js"]);
  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.(js|jsx)$/.test(entry.name) && !/\.test\.(js|jsx)$/.test(entry.name) ? [full] : [];
    });
  }

  it("finds no direct reads or writes", () => {
    const offenders = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (ALLOWED.has(rel)) continue;
      const code = fs.readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter((line) => !/^\s*(\/\/|\*|\{\/\*)/.test(line))
        .join("\n");
      if (/localStorage\s*(\?\.|\.)\s*(getItem|setItem|removeItem|clear)|localStorage\s*\[/.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
