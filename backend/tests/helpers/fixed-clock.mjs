// Preloaded with `--import` (or through NODE_OPTIONS, which also reaches a
// route test's spawned server) to run a test file as if today were
// FIXED_NOW, an ISO instant. The clock still ticks from there, so timeouts
// and elapsed-time checks behave; only the calendar moves.
//
// It exists for tests/clock-independence.test.js: the FAFSA tests read the
// real clock and would have turned CI red, and blocked every deploy, on the
// day the only ruleset lapsed (2027-07-01). A test that reads the date must
// pass on any date, and this is how that is proven before the day comes.
// SQLite's own datetime('now') is not moved.
const target = Date.parse(process.env.FIXED_NOW || "");

if (Number.isFinite(target)) {
  const RealDate = Date;
  const offset = target - RealDate.now();
  // A plain function rather than a subclass: `Date()` called without `new`
  // must still answer a string, and a Date made anywhere (a library, a
  // structuredClone) must still pass `instanceof Date`.
  function ShiftedDate(...args) {
    if (!new.target) return new RealDate(RealDate.now() + offset).toString();
    return Reflect.construct(RealDate, args.length ? args : [RealDate.now() + offset], new.target);
  }
  Object.setPrototypeOf(ShiftedDate, RealDate);
  ShiftedDate.prototype = RealDate.prototype;
  ShiftedDate.now = () => RealDate.now() + offset;
  globalThis.Date = ShiftedDate;
}
