import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { applyTurnBoundary, createTurnBoundaryState, type TurnBoundaryState } from "../shared/turn-boundary.js";
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

function extractErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return "";
  return readString(record.message) || readString(record.detail) || readString(record.code);
}

function parseLineInternal(
  line: string,
  ts: string,
  thoughtBoundary: TurnBoundaryState,
): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = readString(parsed.type).trim();

  if (type === "thought") {
    const text = readString(parsed.data);
    if (!text) return [];
    return [{ kind: "thinking", ts, text: applyTurnBoundary(thoughtBoundary, text), delta: true }];
  }

  if (type === "text") {
    const text = readString(parsed.data);
    if (!text) return [];
    return [{ kind: "assistant", ts, text, delta: true }];
  }

  if (type === "error") {
    const text = readString(parsed.data) || readString(parsed.message) || extractErrorText(parsed.error);
    return text ? [{ kind: "stderr", ts, text }] : [{ kind: "stderr", ts, text: "Grok error" }];
  }

  if (type === "end") {
    const stopReason = readString(parsed.stopReason).trim();
    const sessionId = readString(parsed.sessionId).trim();
    const parts = [
      stopReason ? `stop_reason=${stopReason}` : "",
      sessionId ? `session=${sessionId}` : "",
    ].filter(Boolean);
    return [{ kind: "system", ts, text: parts.join(" ") || "run completed" }];
  }

  return [{ kind: "system", ts, text: `event: ${type || "unknown"}` }];
}

export function createGrokStdoutParser() {
  let thoughtBoundary = createTurnBoundaryState();
  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      return parseLineInternal(line, ts, thoughtBoundary);
    },
    reset() {
      thoughtBoundary = createTurnBoundaryState();
    },
  };
}

// Stateless fallback for callers that haven't migrated to the stateful factory.
// Without state, consecutive thought chunks at reasoning-turn boundaries can
// still appear merged; prefer createGrokStdoutParser for live transcripts.
export function parseGrokStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseLineInternal(line, ts, createTurnBoundaryState());
}
