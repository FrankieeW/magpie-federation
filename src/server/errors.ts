import type { MachineState } from "../shared/api.ts";

export type ErrorState = MachineState | "conflict";

/** An error whose state and message are safe to show the page. */
export class InspectorError extends Error {
  readonly state: ErrorState;
  readonly status: number;

  constructor(state: ErrorState, message: string, status = 502) {
    super(message);
    this.name = "InspectorError";
    this.state = state;
    this.status = status;
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The first line of a process's complaint, short and free of control characters. */
export function firstLine(text: string, max = 300): string {
  const line = text.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? "";
  return line.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}
