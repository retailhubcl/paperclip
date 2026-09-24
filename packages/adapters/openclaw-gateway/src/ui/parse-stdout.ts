import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { normalizeOpenClawGatewayStreamLine } from "../shared/stream.js";
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

function parseAgentEventLine(line: string, ts: string): TranscriptEntry[] {
  const match = line.match(/^\[openclaw-gateway:event\]\s+run=([^\s]+)\s+stream=([^\s]+)\s+data=(.*)$/s);
  if (!match) return [{ kind: "stdout", ts, text: line }];

  const stream = readString(match[2]).toLowerCase();
  const data = asRecord(safeJsonParse(readString(match[3]).trim()));

  if (stream === "assistant") {
    const delta = readString(data?.delta);
    if (delta.length > 0) {
      return [{ kind: "assistant", ts, text: delta, delta: true }];
    }

    const text = readString(data?.text);
    if (text.length > 0) {
      return [{ kind: "assistant", ts, text }];
    }
    return [];
  }

  if (stream === "error") {
    const message = readString(data?.error) || readString(data?.message);
    return message ? [{ kind: "stderr", ts, text: message }] : [];
  }

  if (stream === "lifecycle") {
    const phase = readString(data?.phase).toLowerCase();
    const message = readString(data?.error) || readString(data?.message);
    if ((phase === "error" || phase === "failed" || phase === "cancelled") && message) {
      return [{ kind: "stderr", ts, text: message }];
    }
  }

  return [];
}

export function parseOpenClawGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const normalized = normalizeOpenClawGatewayStreamLine(line);
  if (normalized.stream === "stderr") {
    return [{ kind: "stderr", ts, text: normalized.line }];
  }

  const trimmed = normalized.line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[openclaw-gateway:event]")) {
    return parseAgentEventLine(trimmed, ts);
  }

  if (trimmed.startsWith("[openclaw-gateway]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[openclaw-gateway\]\s*/, "") }];
  }

  return [{ kind: "stdout", ts, text: normalized.line }];
}
