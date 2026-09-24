import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { readString } from "@paperclipai/adapter-utils/value-readers";

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pickToolUseId(parsed: Record<string, unknown>): string {
  return (
    readString(parsed.toolCallId) ||
    readString(parsed.toolUseId) ||
    readString(parsed.id)
  );
}

function statusText(parsed: Record<string, unknown>): string {
  const text = readString(parsed.text).trim();
  const tag = readString(parsed.tag).trim();
  const used = asNumber(parsed.used, -1);
  const size = asNumber(parsed.size, -1);
  const parts: string[] = [];
  if (text) parts.push(text);
  if (tag && !text) parts.push(tag);
  if (used >= 0 && size > 0) parts.push(`(${used}/${size} ctx)`);
  return parts.join(" ") || tag || "status";
}

export function parseAcpxStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = parseJson(line);
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const type = readString(parsed.type);
  if (type === "acpx.session") {
    const agent = readString(parsed.agent, "acpx");
    const mode = readString(parsed.mode);
    const permissionMode = readString(parsed.permissionMode);
    const tail = [mode, permissionMode].filter(Boolean).join(" / ");
    return [{
      kind: "init",
      ts,
      model: tail ? `${agent} (${tail})` : agent,
      sessionId:
        readString(parsed.acpSessionId) ||
        readString(parsed.sessionId) ||
        readString(parsed.runtimeSessionName),
    }];
  }

  if (type === "acpx.text_delta") {
    const text = readString(parsed.text);
    if (!text) return [];
    const channel = readString(parsed.channel) || readString(parsed.stream);
    return [{
      kind: channel === "thought" || channel === "thinking" ? "thinking" : "assistant",
      ts,
      text,
      delta: true,
    }];
  }

  if (type === "acpx.tool_call") {
    const status = readString(parsed.status);
    const text = readString(parsed.text);
    const name = readString(parsed.name, "acp_tool");
    const toolUseId = pickToolUseId(parsed);
    const input =
      parsed.input !== undefined
        ? parsed.input
        : text || status
          ? { ...(text ? { text } : {}), ...(status ? { status } : {}) }
          : {};
    const entries: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts,
        name,
        toolUseId: toolUseId || undefined,
        input,
      },
    ];
    if (status === "completed" || status === "failed" || status === "cancelled") {
      entries.push({
        kind: "tool_result",
        ts,
        toolUseId: toolUseId || name,
        toolName: name,
        content: text || status,
        isError: status !== "completed",
      });
    }
    return entries;
  }

  if (type === "acpx.tool_result") {
    return [{
      kind: "tool_result",
      ts,
      toolUseId: pickToolUseId(parsed) || readString(parsed.name, "acp_tool"),
      toolName: readString(parsed.name) || undefined,
      content: stringify(parsed.content ?? parsed.output ?? parsed.error),
      isError: parsed.isError === true || parsed.error !== undefined,
    }];
  }

  if (type === "acpx.status") {
    return [{ kind: "system", ts, text: statusText(parsed) }];
  }

  if (type === "acpx.result") {
    return [{
      kind: "result",
      ts,
      text: readString(parsed.summary, readString(parsed.stopReason, readString(parsed.text))),
      inputTokens: asNumber(parsed.inputTokens),
      outputTokens: asNumber(parsed.outputTokens),
      cachedTokens: asNumber(parsed.cachedTokens),
      costUsd: asNumber(parsed.costUsd),
      subtype: readString(parsed.subtype, readString(parsed.stopReason, "acpx.result")),
      isError: parsed.isError === true,
      errors: Array.isArray(parsed.errors)
        ? parsed.errors.map((error) => stringify(error)).filter(Boolean)
        : [],
    }];
  }

  if (type === "acpx.error") {
    return [{ kind: "stderr", ts, text: readString(parsed.message, line) }];
  }

  if (type.startsWith("acpx.")) {
    return [{ kind: "system", ts, text: readString(parsed.message, type) }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
