import pc from "picocolors";
import { readString } from "@paperclipai/adapter-utils/value-readers";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const data = asRecord(rec.data);
  const message =
    readString(rec.message) ||
    readString(data?.message) ||
    readString(rec.name) ||
    "";
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function printOpenCodeStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }

  const type = readString(parsed.type);

  if (type === "step_start") {
    const sessionId = readString(parsed.sessionID);
    console.log(pc.blue(`step started${sessionId ? ` (session: ${sessionId})` : ""}`));
    return;
  }

  if (type === "text") {
    const part = asRecord(parsed.part);
    const text = readString(part?.text).trim();
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }

  if (type === "reasoning") {
    const part = asRecord(parsed.part);
    const text = readString(part?.text).trim();
    if (text) console.log(pc.gray(`thinking: ${text}`));
    return;
  }

  if (type === "tool_use") {
    const part = asRecord(parsed.part);
    const tool = readString(part?.tool, "tool");
    const callID = readString(part?.callID);
    const state = asRecord(part?.state);
    const status = readString(state?.status);
    const isError = status === "error";
    const metadata = asRecord(state?.metadata);

    console.log(pc.yellow(`tool_call: ${tool}${callID ? ` (${callID})` : ""}`));

    if (status) {
      const metaParts = [`status=${status}`];
      if (metadata) {
        for (const [key, value] of Object.entries(metadata)) {
          if (value !== undefined && value !== null) metaParts.push(`${key}=${value}`);
        }
      }
      console.log((isError ? pc.red : pc.gray)(`tool_result ${metaParts.join(" ")}`));
    }

    const output = (readString(state?.output) || readString(state?.error)).trim();
    if (output) console.log((isError ? pc.red : pc.gray)(output));
    return;
  }

  if (type === "step_finish") {
    const part = asRecord(parsed.part);
    const tokens = asRecord(part?.tokens);
    const cache = asRecord(tokens?.cache);
    const input = asNumber(tokens?.input, 0);
    const output = asNumber(tokens?.output, 0) + asNumber(tokens?.reasoning, 0);
    const cached = asNumber(cache?.read, 0);
    const cost = asNumber(part?.cost, 0);
    const reason = readString(part?.reason, "step");
    console.log(pc.blue(`step finished: reason=${reason}`));
    console.log(pc.blue(`tokens: in=${input} out=${output} cached=${cached} cost=$${cost.toFixed(6)}`));
    return;
  }

  if (type === "error") {
    const message = errorText(parsed.error ?? parsed.message);
    if (message) console.log(pc.red(`error: ${message}`));
    return;
  }

  console.log(line);
}
