import type { AnalysisResponse, BudgetIdentity, BudgetSearchResponse, SavedReportResponse } from "./types";

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const result: T & { error?: string } = await response.json();
  if (!response.ok) {
    throw new ApiError(result.error || `HTTP ${response.status}`, response.status);
  }
  return result;
}

export async function savedReport(): Promise<SavedReportResponse | null> {
  const response = await fetch("/api/saved");
  if (response.status === 404) return null;
  return readJson<SavedReportResponse>(response);
}

export async function lookupBudget(code: string, signal?: AbortSignal): Promise<BudgetIdentity> {
  const response = await fetch(`/api/budget-name?code=${encodeURIComponent(code)}`, { signal });
  return readJson<BudgetIdentity>(response);
}

export async function searchBudgets(query: string, signal?: AbortSignal): Promise<BudgetSearchResponse> {
  const response = await fetch(`/api/budget-search?q=${encodeURIComponent(query)}`, { signal });
  return readJson<BudgetSearchResponse>(response);
}

export interface AnalysisPayload {
  budget_code: string;
  year: number;
  payer_edrpous: string[];
  transactions_start: string | null;
  transactions_end: string | null;
}

export interface AnalysisProgress {
  step: "incomes" | "economic" | "programs" | "calculation" | "identity" | "spending" | "finish";
  message: string;
}

type AnalysisStreamEvent =
  | ({ type: "progress" } & AnalysisProgress)
  | { type: "result"; report: AnalysisResponse["report"] }
  | { type: "error"; message: string };

export async function analyzeBudget(
  payload: AnalysisPayload, onProgress: (progress: AnalysisProgress) => void, signal?: AbortSignal,
): Promise<AnalysisResponse> {
  const response = await fetch("/api/analyze-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) return readJson<AnalysisResponse>(response);
  if (!response.body) throw new Error("Сервер не надіслав потік стану аналізу.");

  const consume = (line: string): AnalysisResponse | null => {
    if (!line.trim()) return null;
    const event = JSON.parse(line) as AnalysisStreamEvent;
    if (event.type === "progress") onProgress({ step: event.step, message: event.message });
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "result") return { report: event.report };
    return null;
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const result = consume(buffer.slice(0, newline));
      if (result) return result;
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  const result = consume(buffer);
  if (result) return result;
  throw new Error("З’єднання обірвалося до завершення аналізу. Спробуйте ще раз.");
}
