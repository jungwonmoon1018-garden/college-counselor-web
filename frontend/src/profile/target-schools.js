// The named target-school list the sidebar keeps per account on the device.
// One constant for the cap, read by the hook that adds a school, the
// deadline creator that runs after it, and the sidebar that says the list
// is full. The cap used to live only as slice(0, 8) inside the add: a ninth
// school was cut from the list after the input had cleared and after its
// deadlines had been requested, so the Deadlines panel filled with rows for
// a school the student could not see on the list (ui-9). The chat's
// verified-data block also reads at most eight named schools
// (backend/server/verified-data.js).
export const MAX_TARGET_SCHOOLS = 8;

// Target names are matched without regard to case, as the add's duplicate
// check always has: "rice university" is Rice University.
export function sameTargetSchool(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

export function targetListHas(list, name) {
  return Array.isArray(list) && list.some((s) => sameTargetSchool(s, name));
}
