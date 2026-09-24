// Dependency-free value readers shared by adapter server, UI and CLI code.
// Keep this module free of Node built-ins: adapter UI parsers import it and
// are bundled for the browser.
//
// Note: these intentionally differ from `asString` in `server-utils.ts`, which
// treats an empty string as missing and returns the fallback instead.

/** Returns `value` when it is a string (including ""), otherwise `fallback`. */
export function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Returns the trimmed string when it has non-whitespace content, otherwise null. */
export function readTrimmedNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
