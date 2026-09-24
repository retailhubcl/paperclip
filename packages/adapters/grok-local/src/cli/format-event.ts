import pc from "picocolors";
import { readString } from "@paperclipai/adapter-utils/value-readers";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function printGrokStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const type = readString(parsed.type).trim();
  if (type === "thought") {
    const text = readString(parsed.data);
    if (text) console.log(pc.gray(`thinking: ${text}`));
    return;
  }

  if (type === "text") {
    const text = readString(parsed.data);
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }

  if (type === "end") {
    const stopReason = readString(parsed.stopReason);
    const sessionId = readString(parsed.sessionId);
    const details = [stopReason ? `stopReason=${stopReason}` : "", sessionId ? `session=${sessionId}` : ""]
      .filter(Boolean)
      .join(" ");
    console.log(pc.blue(`Grok run completed${details ? ` (${details})` : ""}`));
    return;
  }

  if (type === "error") {
    const text =
      readString(parsed.data) ||
      readString(parsed.message) ||
      readString(parsed.error) ||
      "Grok error";
    console.log(pc.red(`error: ${text}`));
    return;
  }

  const payload = asRecord(parsed);
  console.log(pc.gray(`event: ${type || "unknown"} ${payload ? JSON.stringify(payload) : line}`));
}
