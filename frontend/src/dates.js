// SQLite's datetime('now') yields "YYYY-MM-DD HH:MM:SS" (UTC, no zone). Safari
// refuses to parse that shape (Invalid Date) while Chrome parses it as LOCAL
// time — so thread timestamps were blank on iOS and shifted by the timezone
// offset elsewhere. Normalize to strict ISO-8601 UTC before Date sees it.
export function serverDateToISO(value) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(String(value || ""));
  return m ? `${m[1]}T${m[2]}Z` : String(value || "");
}

export function formatServerDate(value) {
  const d = new Date(serverDateToISO(value));
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}
