// routes/ec-research.js — formerly the counselor's /api/ec competition
// search, research cache memory, prestige read and recompute, and component
// cache reset. Split out of routes/ec.js on 2026-09-20.
//
// Every one of those paths is answered 410 by the tombstone in server.js,
// which is registered before this function runs, so the handlers that used
// to live here could never be reached: the administrator account is limited
// to secret configuration and does not read or recompute student activity
// data. They were removed on 2026-11-03 because a fix made here would have
// looked tested and changed nothing in production, and because trimming the
// tombstone list would have silently revived an endpoint that recomputes any
// student's activity vectors on the model budget. tests/misc-tombstones.test.js
// pins both halves: the paths answer 410, and no route module registers a
// tombstoned path. The prestige research the students use runs through
// activities/competition-research.js from the activity routes.
//
// The function stays, empty, so server.js keeps its registration call until
// that call is removed with this file.
export function registerEcResearchRoutes(_app, _deps) {}
