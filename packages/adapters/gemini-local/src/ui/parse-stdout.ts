import type { TranscriptEntry } from "@paperclipai/adapter-utils";
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

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function collectTextEntries(messageRaw: unknown, ts: string, kind: "assistant" | "user"): TranscriptEntry[] {
  if (typeof messageRaw === "string") {
    const text = messageRaw.trim();
    return text ? [{ kind, ts, text }] : [];
  }

  const message = asRecord(messageRaw);
  if (!message) return [];

  const entries: TranscriptEntry[] = [];
  const directText = readString(message.text).trim();
  if (directText) entries.push({ kind, ts, text: directText });

  const content = Array.isArray(message.content) ? message.content : [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = readString(part.type).trim();
    if (type !== "output_text" && type !== "text" && type !== "content") continue;
    const text = readString(part.text).trim() || readString(part.content).trim();
    if (text) entries.push({ kind, ts, text });
  }

  return entries;
}

function parseAssistantMessage(messageRaw: unknown, ts: string): TranscriptEntry[] {
  if (typeof messageRaw === "string") {
    const text = messageRaw.trim();
    return text ? [{ kind: "assistant", ts, text }] : [];
  }

  const message = asRecord(messageRaw);
  if (!message) return [];

  const entries: TranscriptEntry[] = [];
  const directText = readString(message.text).trim();
  if (directText) entries.push({ kind: "assistant", ts, text: directText });

  const content = Array.isArray(message.content) ? message.content : [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = readString(part.type).trim();

    if (type === "output_text" || type === "text" || type === "content") {
      const text = readString(part.text).trim() || readString(part.content).trim();
      if (text) entries.push({ kind: "assistant", ts, text });
      continue;
    }

    if (type === "thinking") {
      const text = readString(part.text).trim();
      if (text) entries.push({ kind: "thinking", ts, text });
      continue;
    }

    if (type === "tool_call") {
      const name = readString(part.name, readString(part.tool, "tool"));
      entries.push({
        kind: "tool_call",
        ts,
        name,
        input: part.input ?? part.arguments ?? part.args ?? {},
      });
      continue;
    }

    if (type === "tool_result" || type === "tool_response") {
      const toolUseId =
        readString(part.tool_use_id) ||
        readString(part.toolUseId) ||
        readString(part.call_id) ||
        readString(part.id) ||
        "tool_result";
      const contentText =
        readString(part.output) ||
        readString(part.text) ||
        readString(part.result) ||
        stringifyUnknown(part.output ?? part.result ?? part.text ?? part.response);
      const isError = part.is_error === true || readString(part.status).toLowerCase() === "error";
      entries.push({
        kind: "tool_result",
        ts,
        toolUseId,
        content: contentText,
        isError,
      });
    }
  }

  return entries;
}

function parseTopLevelToolEvent(parsed: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const subtype = readString(parsed.subtype).trim().toLowerCase();
  const callId = readString(parsed.call_id, readString(parsed.callId, readString(parsed.id, "tool_call")));
  const toolCall = asRecord(parsed.tool_call ?? parsed.toolCall);
  if (!toolCall) {
    return [{ kind: "system", ts, text: `tool_call${subtype ? ` (${subtype})` : ""}` }];
  }

  const [toolName] = Object.keys(toolCall);
  if (!toolName) {
    return [{ kind: "system", ts, text: `tool_call${subtype ? ` (${subtype})` : ""}` }];
  }
  const payload = asRecord(toolCall[toolName]) ?? {};

  if (subtype === "started" || subtype === "start") {
    return [{
      kind: "tool_call",
      ts,
      name: toolName,
      input: payload.args ?? payload.input ?? payload.arguments ?? payload,
    }];
  }

  if (subtype === "completed" || subtype === "complete" || subtype === "finished") {
    const result = payload.result ?? payload.output ?? payload.error;
    const isError =
      parsed.is_error === true ||
      payload.is_error === true ||
      payload.error !== undefined ||
      readString(payload.status).toLowerCase() === "error";
    return [{
      kind: "tool_result",
      ts,
      toolUseId: callId,
      content: result !== undefined ? stringifyUnknown(result) : `${toolName} completed`,
      isError,
    }];
  }

  return [{ kind: "system", ts, text: `tool_call${subtype ? ` (${subtype})` : ""}: ${toolName}` }];
}

function readSessionId(parsed: Record<string, unknown>): string {
  return (
    readString(parsed.session_id) ||
    readString(parsed.sessionId) ||
    readString(parsed.sessionID) ||
    readString(parsed.checkpoint_id) ||
    readString(parsed.thread_id)
  );
}

function readUsage(parsed: Record<string, unknown>) {
  const usage = asRecord(parsed.usage) ?? asRecord(parsed.usageMetadata) ?? asRecord(parsed.stats);
  const usageMetadata = asRecord(usage?.usageMetadata);
  const source = usageMetadata ?? usage ?? {};
  return {
    inputTokens: asNumber(source.input_tokens, asNumber(source.inputTokens, asNumber(source.promptTokenCount))),
    outputTokens: asNumber(source.output_tokens, asNumber(source.outputTokens, asNumber(source.candidatesTokenCount))),
    cachedTokens: asNumber(
      source.cached_input_tokens,
      asNumber(source.cachedInputTokens, asNumber(source.cachedContentTokenCount, asNumber(source.cached))),
    ),
  };
}

export function parseGeminiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = readString(parsed.type);

  if (type === "system") {
    const subtype = readString(parsed.subtype);
    if (subtype === "init") {
      const sessionId = readSessionId(parsed);
      return [{ kind: "init", ts, model: readString(parsed.model, "gemini"), sessionId }];
    }
    if (subtype === "error") {
      const text = errorText(parsed.error ?? parsed.message ?? parsed.detail);
      return [{ kind: "stderr", ts, text: text || "error" }];
    }
    return [{ kind: "system", ts, text: `system: ${subtype || "event"}` }];
  }

  if (type === "assistant") {
    return parseAssistantMessage(parsed.message, ts);
  }

  if (type === "user") {
    return collectTextEntries(parsed.message, ts, "user");
  }

  // Gemini CLI v0.38+ stream-json schema:
  // {"type":"message","role":"assistant"|"user","content":"...","delta":?true}
  if (type === "message") {
    const role = readString(parsed.role).trim().toLowerCase();
    if (role === "assistant") {
      return parseAssistantMessage(parsed.content, ts);
    }
    if (role === "user") {
      return collectTextEntries(parsed.content, ts, "user");
    }
    return [];
  }

  if (type === "thinking") {
    const text = readString(parsed.text).trim() || readString(asRecord(parsed.delta)?.text).trim();
    return text ? [{ kind: "thinking", ts, text }] : [];
  }

  if (type === "tool_call") {
    return parseTopLevelToolEvent(parsed, ts);
  }

  if (type === "result") {
    const usage = readUsage(parsed);
    const status = readString(parsed.status).toLowerCase();
    const isError =
      parsed.is_error === true || status === "error" || status === "failed";
    const errors = isError
      ? [errorText(parsed.error ?? parsed.message ?? parsed.result)].filter(Boolean)
      : [];
    return [{
      kind: "result",
      ts,
      text: readString(parsed.result) || readString(parsed.text) || readString(parsed.response),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      costUsd: asNumber(parsed.total_cost_usd, asNumber(parsed.cost_usd, asNumber(parsed.cost))),
      subtype: readString(parsed.subtype, status || "result"),
      isError,
      errors,
    }];
  }

  if (type === "error") {
    const text = errorText(parsed.error ?? parsed.message ?? parsed.detail);
    return [{ kind: "stderr", ts, text: text || "error" }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
