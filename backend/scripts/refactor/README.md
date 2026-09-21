# Refactoring tools

AST tools (espree + eslint-scope, both already in node_modules through
eslint) that split the large files: server.js and App.jsx on 2026-09-16,
then the rest of both, routes/ec.js and the 1,300-line domain modules on
2026-09-20. Run them from anywhere; paths resolve from the script's own
location. Each has a dry run; pass --apply to write. Every tool moves text
verbatim and refuses rather than guesses: read the refusal, move the thing
it names first (or with it), and run it again.

Reading a module before moving anything:

- `module-graph.mjs <file> [--min N] [--json out.json]` — every top-level
  statement with the module bindings it declares, reads and assigns. The
  "reads X, which stays" refusals below come from this picture.
- `route-families.mjs [/api/prefix …]` — for each `app.<verb>("/api/<family>…")`
  family in server.js: route count, lines, the server bindings it uses,
  whether it assigns any.

Moving code:

- `extract-module.mjs --file <module> --out <new> (--names a,b | --range A-B)…`
  — moves top-level declarations into a new sibling module. Only a closed
  set moves: what a moved statement reads must be an import or move with
  it, so the new module never imports the old one back. The old module
  imports what it still reads and re-exports what it used to export, so its
  importers do not change. Work bottom layer first (shared helpers, then
  what uses them).
- `extract-helpers.mjs --out server/<area>.js --names f1,f2,…` — the same
  for server.js helpers that read server state: a reference to a server
  binding becomes `deps.<name>` (the routeDeps getters), the module holds
  `deps` in one variable set by `bind<Area>(routeDeps)`, and server.js
  calls the bind functions right under routeDeps, above everything else.
- `wrap-statements.mjs --out server/x.js --name fn --from L1 --to L2 [--append]`
  — for boot-time STATEMENTS in server.js (timers, job registration, a mount
  block): they become `export function fn(deps)` and `fn(routeDeps);` stays
  where the run was, so what runs when does not change. Lines inside a
  multi-line template literal are not re-indented.
- `extract-routes.mjs [api/family …]` — moves route families into
  routes/<family>.js as `register<Family>Routes(app, deps)`. Run once for
  all families (it writes routeDeps).
- `split-route-module.mjs --file routes/x.js --out routes/x-part.js --name XPart --from L --to 99999`
  — splits the tail of a register function into a register function of its
  own. Split last segment first and the registration order (what Express
  matches by) is unchanged.
- `extract-screen.mjs --tag main --nth N --name X --props xProps` — moves
  the Nth JSX element of that tag inside App() into src/X.jsx: App()
  bindings become props passed as one object, module-level helpers only it
  uses move with it, helpers both sides use go to src/app-shared.js.
  Refuses if the element writes an outer binding.
- `extract-callback.mjs --out handlers.js --names send,handleLogin` — moves
  the bodies of App()'s `useCallback` handlers into a module as
  `name(ctx, ...params)`; App keeps the hook and its dependency array and
  passes the render's bindings as `ctx`.

- `regroup-app.mjs --names a,b (--before x | --after x)` — brings a
  concern's scattered declarations inside App() together. Never moves an
  effect; moves a declaration only when what it reads while rendering is
  declared above the new place and every render-time reference to it sits
  below.
- `extract-hook.mjs --name useX (--first a --last b | --from L1 --to L2)` —
  moves a CONTIGUOUS run of App()'s statements into src/hooks/useX.js as
  `useX(ctx)`, the call staying where the run was, and fails if the sequence
  of effects changed. Refuses a run that reads an App binding declared after
  it, assigns one it does not own, or holds JSX. Regroup first, then extract.
- `move-modules.mjs --map map.json [--log rewrites.txt]` — moves files
  into folders with `git mv` and rewrites every relative path literal that
  names them (imports, dynamic imports, `new URL`, a test's
  `path.resolve(__dirname, "../x.js")`) in every tracked module. Paths built
  from segments off `__dirname` are listed, not rewritten: fix those by
  hand. Strings made only of dots and slashes are never touched — the first
  version rewrote `host.split(".")` to `split("..")` in every moved file,
  which the test suite caught; read the `--log` output before applying.

Cleaning up after a move:

- `prune-imports.mjs` — drops the import specifiers server.js no longer
  references; an emptied declaration stays as a bare import.
- `prune-bare-imports.mjs` — drops those bare imports from server.js once a
  module under routes/ or server/ imports the same file itself.
- `prune-app-imports.mjs <file>` — drops unused import specifiers in one
  module (JSX component names count as uses).
- `undef-check.mjs <file …>` — unresolved identifiers per module, the check
  to run after any move.

Source-text tests read the code through `tests/helpers/server-source.mjs`
(server.js + routes/ + server/, `deps.` normalized away) and
`tests/helpers/frontend-source.mjs` (every module under frontend/src), so a
pin survives a move. A test that reads one module by name needs the new
module added beside it.
