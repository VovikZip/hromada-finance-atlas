import type { Amount, DetailRow, MonthlyRow, Report, TransactionRow } from "./types";

const numberFormat = new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortFormat = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 1 });
const wholeFormat = new Intl.NumberFormat("uk-UA");
const monthFormat = new Intl.DateTimeFormat("uk-UA", { month: "long", year: "numeric" });
const shortMonthFormat = new Intl.DateTimeFormat("uk-UA", { month: "short" });

export function monthDate(value: string): Date {
  return new Date(`${value}-01T12:00:00`);
}

export function monthLabel(value: string): string {
  return monthFormat.format(monthDate(value));
}

export function shortMonthLabel(value: string): string {
  return shortMonthFormat.format(monthDate(value));
}

export function money(value: Amount): string {
  if (value === null || value === undefined || value === "") return "Немає даних";
  return `${numberFormat.format(Number(value))} ₴`;
}

export function shortMoney(value: Amount): string {
  if (value === null || value === undefined || value === "") return "—";
  return `${shortFormat.format(Number(value) / 1_000_000)} млн`;
}

export function toCents(value: Amount): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return 0n;
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] || "").padEnd(2, "0"));
  return match[1] ? -cents : cents;
}

export function formatCents(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const sign = value < 0n ? "−" : "";
  return `${sign}${wholeFormat.format(absolute / 100n)},${String(absolute % 100n).padStart(2, "0")} ₴`;
}

export function balanceForRow(row: MonthlyRow): bigint | null {
  if (row.income_minus_expense_uah !== null && row.income_minus_expense_uah !== undefined) {
    return toCents(row.income_minus_expense_uah);
  }
  if (row.income_uah === null || row.income_uah === undefined ||
      row.expense_uah === null || row.expense_uah === undefined) return null;
  return toCents(row.income_uah) - toCents(row.expense_uah);
}

export function yearTotals(monthly: MonthlyRow[] = []): { income: bigint; expense: bigint } {
  return {
    income: monthly.reduce((total, row) => total + toCents(row.income_uah), 0n),
    expense: monthly.reduce((total, row) => total + toCents(row.expense_uah), 0n),
  };
}

function decimalCents(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function sumPublishedAmounts(values: Amount[]): string | null {
  if (!values.length || values.some((value) => value === null || value === undefined || value === "")) return null;
  return decimalCents(values.reduce<bigint>((sum, value) => sum + toCents(value), 0n));
}

export function annualSummary(monthly: MonthlyRow[], year: number): MonthlyRow | null {
  if (!monthly.length) return null;
  const income = sumPublishedAmounts(monthly.map((row) => row.income_uah));
  const expense = sumPublishedAmounts(monthly.map((row) => row.expense_uah));
  return {
    month: String(year),
    income_uah: income,
    expense_uah: expense,
    income_minus_expense_uah: income !== null && expense !== null
      ? decimalCents(toCents(income) - toCents(expense)) : null,
    tourist_tax_uah: sumPublishedAmounts(monthly.map((row) => row.tourist_tax_uah)),
    program_expense_uah: sumPublishedAmounts(monthly.map((row) => row.program_expense_uah)),
  };
}

export function annualDetailRows(items: DetailRow[] = [], months: string[], year: number): DetailRow[] {
  const publishedMonths = new Set(months);
  const totals = new Map<string, { row: DetailRow; cents: bigint }>();
  for (const item of items) {
    if (!publishedMonths.has(item.month)) continue;
    const previous = totals.get(item.code);
    totals.set(item.code, { row: item, cents: (previous?.cents || 0n) + toCents(item.actual_uah) });
  }
  return [...totals.values()].map(({ row, cents }) => ({
    ...row, month: String(year), actual_uah: decimalCents(cents),
  }));
}

export function groupedDetails(items: DetailRow[] = [], month: string): [string, bigint][] {
  const groups = new Map<string, bigint>();
  for (const item of items) {
    if (item.month !== month) continue;
    const label = item.group || "Без групи";
    groups.set(label, (groups.get(label) || 0n) + toCents(item.actual_uah));
  }
  return [...groups].sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1));
}

export function detailRows(items: DetailRow[] = [], month: string, query = ""): DetailRow[] {
  const normalized = query.trim().toLocaleLowerCase("uk-UA");
  return items.filter((item) => item.month === month)
    .filter((item) => !normalized || `${item.code} ${item.name}`.toLocaleLowerCase("uk-UA").includes(normalized))
    .sort((a, b) => Number(b.actual_uah) - Number(a.actual_uah));
}

export function transactionRows(items: TransactionRow[] = [], query = ""): TransactionRow[] {
  const normalized = query.trim().toLocaleLowerCase("uk-UA");
  return items.filter((item) => !normalized ||
    `${item.recipient_name || ""} ${item.recipient_edrpou || ""} ${item.payment_details || ""} ${item.kekv || ""}`
      .toLocaleLowerCase("uk-UA").includes(normalized));
}

export function sourceLinks(report: Report): [string, string][] {
  const code = String(report.budget_code || "");
  const profile = /^\d{10}$/.test(code)
    ? `https://openbudget.gov.ua/local-budget/${code}/info/profile`
    : "https://openbudget.gov.ua/";
  const entries: [string, string | undefined][] = [
    ["OpenBudget — сторінка цього бюджету", profile],
    ["OpenBudget — офіційний довідник назв бюджетів", report.sources?.openbudget_directory || "https://api.openbudget.gov.ua/items/BUDG"],
    ["OpenBudget — точний CSV-запит доходів", report.sources?.openbudget_incomes],
    ["OpenBudget — точний CSV-запит видатків за КЕКВ", report.sources?.openbudget_expenses_economic],
    ["OpenBudget — точний CSV-запит видатків за програмами", report.sources?.openbudget_expenses_program],
    ["OpenBudget — документація API", "https://api.openbudget.gov.ua/swagger-ui.html"],
  ];
  if (report.coverage?.spending_payer_edrpous?.length) {
    entries.push(["Spending — пошук транзакцій на порталі", "https://spending.gov.ua/new/"]);
    (report.sources?.spending_requests || []).forEach((url, index, urls) => {
      entries.push([`Spending — API-запит ${index + 1} із ${urls.length}`, url]);
    });
  }
  return entries.filter((entry): entry is [string, string] =>
    !!entry[1] && /^https:\/\/(openbudget\.gov\.ua|api\.openbudget\.gov\.ua|spending\.gov\.ua|api\.spending\.gov\.ua)\//.test(entry[1]));
}

export function defaultTransactionDates(year: number): [string, string] {
  const now = new Date();
  const monthIndex = Number(year) === now.getFullYear() ? Math.max(0, now.getMonth() - 1) : 11;
  const lastDay = new Date(Number(year), monthIndex + 1, 0).getDate();
  const month = String(monthIndex + 1).padStart(2, "0");
  return [`${year}-${month}-01`, `${year}-${month}-${String(lastDay).padStart(2, "0")}`];
}

export function downloadFile(name: string, content: string, type: string): void {
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([content], { type }));
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvValue(value: Amount): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function monthlyCsv(report: Report): string {
  const columns = ["month", "income_uah", "expense_uah", "income_minus_expense_uah", "tourist_tax_uah", "program_expense_uah"] as const;
  const rows = [columns.join(";"), ...(report.monthly || []).map((row) => columns.map((column) => csvValue(row[column])).join(";"))];
  return `\ufeff${rows.join("\r\n")}`;
}
