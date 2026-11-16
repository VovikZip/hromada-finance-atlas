import test from "node:test";
import assert from "node:assert/strict";
import { analyzeBudget, searchBudgets } from "../func/api";
import type { AnalysisProgress } from "../func/api";

const request = {
  budget_code: "2357400000", year: 2026, payer_edrpous: [],
  transactions_start: null, transactions_end: null,
};

function streamedResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }), { headers: { "Content-Type": "application/x-ndjson" } });
}

test("analysis reads progress and result across split network chunks", async () => {
  const originalFetch = globalThis.fetch;
  const progress: AnalysisProgress[] = [];
  globalThis.fetch = async () => streamedResponse([
    '{"type":"progress","step":"incomes","mess',
    'age":"Отримуємо доходи"}\n{"type":"result","report":{"budget_code":"2357400000","year":2026,"monthly":[]}}\n',
  ]);
  try {
    const result = await analyzeBudget(request, (event) => progress.push(event));
    assert.equal(progress[0].step, "incomes");
    assert.equal(result.report.budget_code, "2357400000");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analysis surfaces streamed source errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => streamedResponse(['{"type":"error","message":"OpenBudget недоступний"}\n']);
  try {
    await assert.rejects(analyzeBudget(request, () => {}), /OpenBudget недоступний/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("community search sends an encoded name and reads candidate budgets", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return Response.json({ results: [{
      budget_code: "2357400000", budget_name: "Бюджет Уманської громади",
      directory_url: "https://api.openbudget.gov.ua/items/BUDG", directory_date: "2026-11-16",
    }] });
  };
  try {
    const result = await searchBudgets("Умань");
    assert.match(requestedUrl, /\/api\/budget-search\?q=%D0%A3/);
    assert.equal(result.results[0].budget_code, "2357400000");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analysis explains a missing deployed API instead of showing a JSON parsing error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
  try {
    await assert.rejects(analyzeBudget(request, () => {}), /Серверний API не знайдено/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
