export type Amount = string | number | null | undefined;

export interface MonthlyRow {
  month: string;
  income_uah?: Amount;
  expense_uah?: Amount;
  income_minus_expense_uah?: Amount;
  tourist_tax_uah?: Amount;
  program_expense_uah?: Amount;
}

export interface DetailRow {
  month: string;
  code: string;
  name: string;
  group?: string;
  actual_uah: Amount;
}

export interface TransactionRow {
  id: string;
  date: string;
  recipient_name?: string;
  recipient_edrpou?: string;
  payment_details?: string;
  kekv?: string;
  amount?: Amount;
  amount_uah?: Amount;
  currency?: string;
}

export interface BudgetIdentity {
  budget_code: string;
  budget_name: string;
  local_government_name?: string;
  katottg?: string;
  directory_url: string;
  directory_date: string;
  profile_url?: string;
}

export interface BudgetSearchResponse {
  results: BudgetIdentity[];
}

export interface ReportSources {
  openbudget_directory?: string;
  openbudget_directory_date?: string | null;
  openbudget_incomes?: string;
  openbudget_expenses_economic?: string;
  openbudget_expenses_program?: string;
  spending_requests?: string[];
}

export interface ReportCoverage {
  spending_payer_edrpous?: string[];
  spending_dates?: string[] | null;
  limitations?: string[];
}

export interface Report {
  budget_code: string;
  budget_name?: string | null;
  local_government_name?: string | null;
  katottg?: string | null;
  year: number;
  monthly: MonthlyRow[];
  income_details?: DetailRow[];
  expense_economic_details?: DetailRow[];
  expense_program_details?: DetailRow[];
  transactions?: TransactionRow[];
  coverage?: ReportCoverage;
  sources?: ReportSources;
  warnings?: string[];
}

export interface SavedReportResponse {
  report: Report;
  saved_at: string;
}

export interface AnalysisResponse {
  report: Report;
}
