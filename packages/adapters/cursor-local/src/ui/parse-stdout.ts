import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { normalizeCursorStreamLine } from "../shared/stream.js";
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

/** Max chars of stdout/stderr to show in run log for shell tool results. */
const SHELL_OUTPUT_TRUNCATE = 2000;

/**
 * Format shell tool result for run log: exit code + stdout/stderr (truncated).
 * If the result is not a shell-shaped object, returns full stringify.
 */
function formatShellToolResultForLog(result: unknown): string {
  const obj = asRecord(result);
  if (!obj) return stringifyUnknown(result);
  const success = asRecord(obj.success);
  if (!success) return stringifyUnknown(result);
  const exitCode = asNumber(success.exitCode, NaN);
  const stdout = readString(success.stdout).trim();
  const stderr = readString(success.stderr).trim();
  const hasShellShape = Number.isFinite(exitCode) || stdout.length > 0 || stderr.length > 0;
  if (!hasShellShape) return stringifyUnknown(result);

  const lines: string[] = [];
  if (Number.isFinite(exitCode)) lines.push(`exit ${exitCode}`);
  if (stdout) {
    const out = stdout.length > SHELL_OUTPUT_TRUNCATE ? stdout.slice(0, SHELL_OUTPUT_TRUNCATE) + "\n... (truncated)" : stdout;
    lines.push("<stdout>");
    lines.push(out);
  }
  if (stderr) {
    const err = stderr.length > SHELL_OUTPUT_TRUNCATE ? stderr.slice(0, SHELL_OUTPUT_TRUNCATE) + "\n... (truncated)" : stderr;
    lines.push("<stderr>");
    lines.push(err);
  }
  return lines.join("\n");
}

/** Return compact input for run log when tool is shell/shellToolCall (command only). */
function compactShellToolInput(rawInput: unknown, payload?: Record<string, unknown>): unknown {
  const cmd = readString(payload?.command ?? asRecord(rawInput)?.command);
  if (cmd) return { command: cmd };
  return rawInput;
}

function parseUserMessage(messageRaw: unknown, ts: string): TranscriptEntry[] {
  if (typeof messageRaw === "string") {
    const text = messageRaw.trim();
    return text ? [{ kind: "user", ts, text }] : [];
  }

  const message = asRecord(messageRaw);
  if (!message) return [];

  const entries: TranscriptEntry[] = [];
  const directText = readString(message.text).trim();
  if (directText) entries.push({ kind: "user", ts, text: directText });

  const content = Array.isArray(message.content) ? message.content : [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = readString(part.type).trim();
    if (type !== "output_text" && type !== "text") continue;
    const text = readString(part.text).trim();
    if (text) entries.push({ kind: "user", ts, text });
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
  if (directText) {
    entries.push({ kind: "assistant", ts, text: directText });
  }

  const content = Array.isArray(message.content) ? message.content : [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = readString(part.type).trim();

    if (type === "output_text" || type === "text") {
      const text = readString(part.text).trim();
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
      const rawInput = part.input ?? part.arguments ?? part.args ?? {};
      const input =
        name === "shellToolCall" || name === "shell"
          ? compactShellToolInput(rawInput, asRecord(rawInput) ?? undefined)
          : rawInput;
      entries.push({
        kind: "tool_call",
        ts,
        name,
        toolUseId:
          readString(part.tool_use_id) ||
          readString(part.toolUseId) ||
          readString(part.call_id) ||
          readString(part.id) ||
          undefined,
        input,
      });
      continue;
    }

    if (type === "tool_result") {
      const toolUseId =
        readString(part.tool_use_id) ||
        readString(part.toolUseId) ||
        readString(part.call_id) ||
        readString(part.id) ||
        "tool_result";
      const rawOutput = part.output ?? part.result ?? part.text;
      const contentText =
        typeof rawOutput === "object" && rawOutput !== null
          ? formatShellToolResultForLog(rawOutput)
          : readString(rawOutput) || stringifyUnknown(rawOutput);
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

function parseCursorToolCallEvent(event: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const subtype = readString(event.subtype).trim().toLowerCase();
  const callId =
    readString(event.call_id) ||
    readString(event.callId) ||
    readString(event.id) ||
    "tool_call";
  const toolCall = asRecord(event.tool_call ?? event.toolCall);
  if (!toolCall) {
    return [{ kind: "system", ts, text: `tool_call${subtype ? ` (${subtype})` : ""}` }];
  }

  const [toolName] = Object.keys(toolCall);
  if (!toolName) {
    return [{ kind: "system", ts, text: `tool_call${subtype ? ` (${subtype})` : ""}` }];
  }
  const payload = asRecord(toolCall[toolName]) ?? {};
  const rawInput = payload.args ?? asRecord(payload.function)?.arguments ?? payload;
  const isShellTool = toolName === "shellToolCall" || toolName === "shell";
  const input = isShellTool ? compactShellToolInput(rawInput, payload) : rawInput;

  if (subtype === "started" || subtype === "start") {
    return [{
      kind: "tool_call",
      ts,
      name: toolName,
      toolUseId: callId,
      input,
    }];
  }

  if (subtype === "completed" || subtype === "complete" || subtype === "finished") {
    const result =
      payload.result ??
      payload.output ??
      payload.error ??
      asRecord(payload.function)?.result ??
      asRecord(payload.function)?.output;
    const isError =
      event.is_error === true ||
      payload.is_error === true ||
      readString(payload.status).toLowerCase() === "error" ||
      readString(payload.status).toLowerCase() === "failed" ||
      readString(payload.status).toLowerCase() === "cancelled" ||
      payload.error !== undefined;
    const content =
      result !== undefined
        ? isShellTool
          ? formatShellToolResultForLog(result)
          : stringifyUnknown(result)
        : `${toolName} completed`;
    return [{
      kind: "tool_result",
      ts,
      toolUseId: callId,
      content,
      isError,
    }];
  }

  return [{
    kind: "system",
    ts,
    text: `tool_call${subtype ? ` (${subtype})` : ""}: ${toolName}`,
  }];
}

export function parseCursorStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const normalized = normalizeCursorStreamLine(line);
  if (!normalized.line) return [];

  const parsed = asRecord(safeJsonParse(normalized.line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: normalized.line }];
  }

  const type = readString(parsed.type);

  if (type === "system") {
    const subtype = readString(parsed.subtype);
    if (subtype === "init") {
      const sessionId =
        readString(parsed.session_id) ||
        readString(parsed.sessionId) ||
        readString(parsed.sessionID);
      return [{ kind: "init", ts, model: readString(parsed.model, "cursor"), sessionId }];
    }
    return [{ kind: "system", ts, text: subtype ? `system: ${subtype}` : "system" }];
  }

  if (type === "assistant") {
    const entries = parseAssistantMessage(parsed.message, ts);
    return entries.length > 0 ? entries : [{ kind: "assistant", ts, text: readString(parsed.result) }];
  }

  if (type === "user") {
    return parseUserMessage(parsed.message, ts);
  }

  if (type === "thinking") {
    const textFromTopLevel = readString(parsed.text);
    const textFromDelta = readString(asRecord(parsed.delta)?.text);
    const text = textFromTopLevel.length > 0 ? textFromTopLevel : textFromDelta;
    const subtype = readString(parsed.subtype).trim().toLowerCase();
    const isDelta = subtype === "delta" || asRecord(parsed.delta) !== null;
    if (!text.trim()) return [];
    return [{ kind: "thinking", ts, text: isDelta ? text : text.trim(), ...(isDelta ? { delta: true } : {}) }];
  }

  if (type === "tool_call") {
    return parseCursorToolCallEvent(parsed, ts);
  }

  if (type === "result") {
    const usage = asRecord(parsed.usage);
    const inputTokens = asNumber(usage?.input_tokens, asNumber(usage?.inputTokens));
    const outputTokens = asNumber(usage?.output_tokens, asNumber(usage?.outputTokens));
    const cachedTokens = asNumber(
      usage?.cached_input_tokens,
      asNumber(usage?.cachedInputTokens, asNumber(usage?.cache_read_input_tokens)),
    );
    const subtype = readString(parsed.subtype, "result");
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors.map((value) => stringifyUnknown(value)).filter(Boolean)
      : [];
    const errorText = readString(parsed.error).trim();
    if (errorText) errors.push(errorText);
    const isError = parsed.is_error === true || subtype === "error" || subtype === "failed";

    return [{
      kind: "result",
      ts,
      text: readString(parsed.result),
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd: asNumber(parsed.total_cost_usd, asNumber(parsed.cost_usd, asNumber(parsed.cost))),
      subtype,
      isError,
      errors,
    }];
  }

  if (type === "error") {
    const message = readString(parsed.message) || stringifyUnknown(parsed.error ?? parsed.detail) || normalized.line;
    return [{ kind: "stderr", ts, text: message }];
  }

  // Compatibility with older stream-json event shapes.
  if (type === "step_start") {
    const sessionId = readString(parsed.sessionID);
    return [{ kind: "system", ts, text: `step started${sessionId ? ` (${sessionId})` : ""}` }];
  }

  if (type === "text") {
    const part = asRecord(parsed.part);
    const text = readString(part?.text).trim();
    if (!text) return [];
    return [{ kind: "assistant", ts, text }];
  }

  if (type === "tool_use") {
    const part = asRecord(parsed.part);
    const toolUseId = readString(part?.callID, readString(part?.id, "tool_use"));
    const toolName = readString(part?.tool, "tool");
    const state = asRecord(part?.state);
    const input = state?.input ?? {};
    const output = readString(state?.output).trim();
    const status = readString(state?.status).trim();
    const exitCode = asNumber(asRecord(state?.metadata)?.exit, NaN);
    const isError =
      status === "failed" ||
      status === "error" ||
      status === "cancelled" ||
      (Number.isFinite(exitCode) && exitCode !== 0);

    const entries: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts,
        name: toolName,
        input,
      },
    ];

    if (status || output) {
      const lines: string[] = [];
      if (status) lines.push(`status: ${status}`);
      if (Number.isFinite(exitCode)) lines.push(`exit: ${exitCode}`);
      if (output) {
        if (lines.length > 0) lines.push("");
        lines.push(output);
      }
      entries.push({
        kind: "tool_result",
        ts,
        toolUseId,
        content: lines.join("\n").trim() || "tool completed",
        isError,
      });
    }

    return entries;
  }

  if (type === "step_finish") {
    const part = asRecord(parsed.part);
    const tokens = asRecord(part?.tokens);
    const cache = asRecord(tokens?.cache);
    const reason = readString(part?.reason);
    return [{
      kind: "result",
      ts,
      text: reason,
      inputTokens: asNumber(tokens?.input),
      outputTokens: asNumber(tokens?.output),
      cachedTokens: asNumber(cache?.read),
      costUsd: asNumber(part?.cost),
      subtype: reason || "step_finish",
      isError: reason === "error" || reason === "failed",
      errors: [],
    }];
  }

  return [{ kind: "stdout", ts, text: normalized.line }];
}
