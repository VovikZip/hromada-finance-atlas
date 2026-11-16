import test from "node:test";
import assert from "node:assert/strict";
import { annualDetailRows, annualSummary, balanceForRow, formatCents, groupedDetails, monthlyCsv, sourceLinks } from "../func/report";

test("monthly difference uses exact cents", () => {
  assert.equal(formatCents(balanceForRow({ month: "2026-01", income_uah: "100.01", expense_uah: "60.00" })!), "40,01 ₴");
  assert.equal(balanceForRow({ month: "2026-01", income_uah: null, expense_uah: "60.00" }), null);
});

test("income groups sum without floating-point rounding", () => {
  const rows = [
    { month: "2026-01", code: "10000000", name: "Податки", group: "Податки", actual_uah: "0.10" },
    { month: "2026-01", code: "10000000", name: "Податки", group: "Податки", actual_uah: "0.20" },
    { month: "2026-02", code: "10000000", name: "Податки", group: "Податки", actual_uah: "2.00" },
  ];
  assert.deepEqual(groupedDetails(rows, "2026-01"), [["Податки", 30n]]);
});

test("annual overview sums published monthly facts exactly", () => {
  const row = annualSummary([
    { month: "2026-01", income_uah: "100.01", expense_uah: "60.00", tourist_tax_uah: "0.10" },
    { month: "2026-02", income_uah: "80.02", expense_uah: "20.01", tourist_tax_uah: "0.20" },
  ], 2026);
  assert.equal(row?.income_uah, "180.03");
  assert.equal(row?.expense_uah, "80.01");
  assert.equal(row?.income_minus_expense_uah, "100.02");
  assert.equal(row?.tourist_tax_uah, "0.30");
  assert.equal(annualSummary([{ month: "2026-01", income_uah: null, expense_uah: "10.00" }], 2026)?.income_uah, null);
});

test("annual code detail combines months but excludes unpublished ones", () => {
  const rows = [
    { month: "2026-01", code: "2111", name: "Заробітна плата", group: "Поточні", actual_uah: "10.10" },
    { month: "2026-02", code: "2111", name: "Заробітна плата", group: "Поточні", actual_uah: "-0.05" },
    { month: "2026-03", code: "2111", name: "Заробітна плата", group: "Поточні", actual_uah: "9.00" },
    { month: "2026-02", code: "2210", name: "Матеріали", group: "Поточні", actual_uah: "2.00" },
  ];
  const annual = annualDetailRows(rows, ["2026-01", "2026-02"], 2026);
  assert.equal(annual.find((item) => item.code === "2111")?.actual_uah, "10.05");
  assert.equal(annual.find((item) => item.code === "2210")?.actual_uah, "2.00");
  assert.ok(annual.every((item) => item.month === "2026"));
});

test("CSV and source links retain the report's code", () => {
  const report = {
    budget_code: "2357400000",
    year: 2026,
    monthly: [{ month: "2026-01", income_uah: "12.00" }],
    sources: { openbudget_incomes: "https://api.openbudget.gov.ua/api/public/localBudgetData?budgetCode=2357400000" },
  };
  assert.match(monthlyCsv(report), /2026-01/);
  assert.match(sourceLinks(report)[0][1], /2357400000/);
});
