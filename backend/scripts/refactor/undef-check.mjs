// Unresolved identifiers in JSX modules (what a move left undefined).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(pathToFileURL(path.join(B, "package.json")).href);
const espree = require("espree");
const eslintScope = require("eslint-scope");
const KNOWN = new Set(["window", "document", "console", "fetch", "localStorage", "sessionStorage", "navigator", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Promise", "Math", "JSON", "Number", "String", "Array", "Object", "Date", "Error", "Map", "Set", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "crypto", "TextEncoder", "TextDecoder", "URL", "URLSearchParams", "FormData", "Blob", "File", "FileReader", "AbortController", "requestAnimationFrame", "alert", "confirm", "prompt", "atob", "btoa", "Intl", "RegExp", "Symbol", "Uint8Array", "ArrayBuffer", "structuredClone", "queueMicrotask", "location", "history", "performance", "globalThis", "undefined", "NaN", "Infinity", "process", "import", "React", "Response", "Request", "Headers", "MutationObserver", "ResizeObserver", "IntersectionObserver", "CustomEvent", "Event", "KeyboardEvent", "HTMLElement", "Element", "Node", "getComputedStyle", "scrollTo", "matchMedia", "indexedDB", "WebSocket", "EventSource", "Notification", "DOMParser", "XMLSerializer", "Image", "Audio", "speechSynthesis", "SpeechSynthesisUtterance", "webkitSpeechRecognition", "SpeechRecognition", "escape", "unescape", "Function", "Proxy", "Reflect", "WeakMap", "WeakSet", "BigInt", "Float32Array", "Int32Array", "Uint32Array", "DataView", "SharedArrayBuffer", "Atomics", "self", "top", "parent", "open", "close", "print", "devicePixelRatio", "innerWidth", "innerHeight", "screen", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AggregateError", "EvalError", "URIError", "isSecureContext", "origin", "name", "status", "event", "length", "closed", "frames", "external", "chrome", "onerror", "onload", "postMessage", "addEventListener", "removeEventListener", "dispatchEvent", "cancelAnimationFrame", "setImmediate", "clearImmediate", "Buffer", "module", "exports", "require", "__dirname", "__filename", "arguments", "eval", "AbortSignal", "TransformStream", "ReadableStream", "WritableStream", "CompressionStream", "DecompressionStream", "BroadcastChannel", "MessageChannel", "MessagePort", "Worker", "SharedWorker", "ServiceWorker", "caches", "CacheStorage", "Cache", "PerformanceObserver", "reportError", "queueMicrotask", "structuredClone"]);
for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, "utf8");
  const ast = espree.parse(src, { ecmaVersion: 2024, sourceType: "module", range: true, loc: true, ecmaFeatures: { jsx: true } });
  const sm = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: "module" });
  const global = sm.scopes[0];
  const declared = new Set();
  for (const s of sm.scopes) if (s.type === "module") for (const v of s.variables) declared.add(v.name);
  const missing = new Map();
  for (const ref of global.through) {
    const n = ref.identifier.name;
    if (KNOWN.has(n) || declared.has(n)) continue;
    missing.set(n, (missing.get(n) || 0) + 1);
  }
  // JSX component names not declared or imported.
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "JSXOpeningElement" && n.name.type === "JSXIdentifier" && /^[A-Z]/.test(n.name.name) && !declared.has(n.name.name)) missing.set(n.name.name, (missing.get(n.name.name) || 0) + 1);
    for (const key of Object.keys(n)) { if (key === "loc" || key === "range" || key === "parent") continue; const v = n[key]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === "string") walk(v); }
  })(ast);
  console.log(file.split("/").pop() + ":", missing.size ? [...missing].map(([k, c]) => `${k}×${c}`).join(", ") : "clean");
}
