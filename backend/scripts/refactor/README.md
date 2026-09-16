# Refactoring tools

One-off AST tools (espree + eslint-scope, both already in node_modules
through eslint) used on 2026-09-16 to split server.js and App.jsx. Run
them from anywhere; paths resolve from the script's own location. Each has
a dry run; pass --apply to write.

- `route-families.mjs [/api/prefix …]` — for each `app.<verb>("/api/<family>…")`
  family in server.js: route count, lines, the server bindings it uses,
  whether it assigns any.
- `extract-routes.mjs [--apply] [api/family …]` — moves families into
  routes/<family>.js as `register<Family>Routes(app, deps)`, rewriting
  references to server bindings as `deps.<name>` and re-importing imports;
  server.js gets a `routeDeps` object of live getters and the register
  calls before the health route. Run once for all families (a second run
  would add a second routeDeps).
- `prune-imports.mjs` — drops the import specifiers server.js no longer
  references (eslint's no-unused-vars decides); an emptied declaration
  stays as a bare import for its side effects.
- `extract-screen.mjs [--apply] --tag main --nth N --name X --props xProps`
  — moves the Nth JSX element of that tag inside App() into src/X.jsx:
  App() bindings (and bindings of blocks that enclose the element) become
  props passed as one object, module-level helpers only it uses move with
  it, helpers both sides use go to src/app-shared.js. Refuses if the
  element writes an outer binding.
- `prune-app-imports.mjs <file.jsx>` — drops unused import specifiers in a
  JSX module (JSX component names count as uses).
- `undef-check.mjs <file.jsx …>` — unresolved identifiers per module, the
  check to run after any move.
