import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { analyzeBudget, ApiError, lookupBudget, savedReport, searchBudgets } from "../func/api";
import type { AnalysisProgress } from "../func/api";
import type { Amount, BudgetIdentity, MonthlyRow, Report } from "../func/types";
import {
  annualDetailRows, annualSummary, balanceForRow, defaultTransactionDates, detailRows, downloadFile, formatCents,
  groupedDetails, money, monthLabel, monthlyCsv, shortMoney, shortMonthLabel,
  sourceLinks, toCents, transactionRows,
} from "../func/report";

type DetailTab = "income_details" | "expense_economic_details" | "expense_program_details";
type LookupState = { code: string; state: "idle" | "loading" | "found" | "missing" | "unavailable"; data: BudgetIdentity | null };

const currentYear = new Date().getFullYear();
const years = Array.from({ length: currentYear - 2017 }, (_, index) => currentYear - index);
const progressSteps: { step: AnalysisProgress["step"]; label: string }[] = [
  { step: "incomes", label: "Доходи OpenBudget" },
  { step: "economic", label: "Видатки за КЕКВ" },
  { step: "programs", label: "Бюджетні програми" },
  { step: "calculation", label: "Обрахунок і звірка" },
  { step: "identity", label: "Назва бюджету" },
  { step: "spending", label: "Платежі Spending" },
  { step: "finish", label: "Формування звіту" },
];

function elapsedLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function Dot({ kind }: { kind: string }) {
  return <i className={`dot ${kind}-dot`} aria-hidden="true" />;
}

function GroupHeading({ number, title, description, id }: { number: string; title: string; description: string; id: string }) {
  return <div className="group-heading"><span className="group-number">{number}</span><div><h3 id={id}>{title}</h3><p>{description}</p></div></div>;
}

function Breakdown({ items, total, kind, empty = "Деталізації за цей місяць немає." }: {
  items: [string, bigint][]; total: Amount; kind: string; empty?: string;
}) {
  if (!items.length) return <div className="breakdown-list">{empty}</div>;
  return <div className="breakdown-list">{items.map(([label, value]) => {
    const share = toCents(total) > 0n ? Number(value) / Number(toCents(total)) * 100 : 0;
    return <div className="breakdown-item" key={label}>
      <div className="breakdown-head"><span>{label}</span><strong>{formatCents(value)}</strong></div>
      <div className="breakdown-track"><span className={`breakdown-fill ${kind}-fill`} style={{ width: `${Math.max(0, Math.min(100, share))}%` }} /></div>
    </div>;
  })}</div>;
}

function Chart({ rows, selected }: { rows: MonthlyRow[]; selected: string }) {
  const maximum = Math.max(1, ...rows.flatMap((row) => [Number(row.income_uah || 0), Number(row.expense_uah || 0)]));
  return <div className="chart" aria-label="Помісячна динаміка">{rows.map((item) =>
    <div className={`chart-row${item.month === selected ? " active" : ""}`} key={item.month}>
      <span>{shortMonthLabel(item.month)}</span>
      <div className="chart-track">{([ ["income", item.income_uah], ["expense", item.expense_uah] ] as [string, Amount][]).map(([kind, value]) =>
        value === null || value === undefined ? null :
          <div key={kind} className={`chart-bar ${kind}`} style={{ width: `${Math.max(0, Math.min(100, Number(value) / maximum * 100))}%` }} />
      )}</div>
      <span className="chart-values">{shortMoney(item.income_uah)} / {shortMoney(item.expense_uah)}</span>
    </div>
  )}</div>;
}

function App() {
  const [budgetCode, setBudgetCode] = useState("2357400000");
  const [communityQuery, setCommunityQuery] = useState("");
  const [communityResults, setCommunityResults] = useState<BudgetIdentity[]>([]);
  const [communitySearchState, setCommunitySearchState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [selectedCommunity, setSelectedCommunity] = useState<BudgetIdentity | null>(null);
  const [year, setYear] = useState(currentYear);
  const [payer, setPayer] = useState("");
  const [dateStart, setDateStart] = useState(() => defaultTransactionDates(currentYear)[0]);
  const [dateEnd, setDateEnd] = useState(() => defaultTransactionDates(currentYear)[1]);
  const [report, setReport] = useState<Report | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState("");
  const [periodMode, setPeriodMode] = useState<"month" | "year">("month");
  const [activeTab, setActiveTab] = useState<DetailTab>("income_details");
  const [detailSearch, setDetailSearch] = useState("");
  const [transactionSearch, setTransactionSearch] = useState("");
  const [lookup, setLookup] = useState<LookupState>({ code: "", state: "idle", data: null });
  const [runStatus, setRunStatus] = useState("Оберіть громаду або введіть код бюджету, щоб почати.");
  const [runError, setRunError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress | null>(null);
  const [analysisStartedAt, setAnalysisStartedAt] = useState(0);
  const [lastProgressAt, setLastProgressAt] = useState(0);
  const [progressClock, setProgressClock] = useState(0);
  const [withSpending, setWithSpending] = useState(false);
  const analysisAbort = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setProgressClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    let active = true;
    savedReport().then((result) => {
      if (!active || !result?.report) return;
      const saved = result.report;
      setReport(saved);
      setSavedAt(result.saved_at);
      setBudgetCode(saved.budget_code);
      setYear(saved.year);
      const [start, end] = defaultTransactionDates(saved.year);
      setDateStart(start);
      setDateEnd(end);
      setSelectedMonth(saved.monthly?.at(-1)?.month || "");
      setRunStatus("Показано останній збережений звіт. Натисніть «Провести аналіз», щоб оновити дані.");
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const code = budgetCode.trim();
    if (!/^\d{10}$/.test(code)) {
      setLookup({ code, state: "idle", data: null });
      return;
    }
    const controller = new AbortController();
    setLookup({ code, state: "loading", data: null });
    const timer = setTimeout(() => {
      lookupBudget(code, controller.signal).then((data) => {
        setLookup({ code, state: "found", data });
      }).catch((error) => {
        if (!(error instanceof Error && error.name === "AbortError")) setLookup({ code, state: error instanceof ApiError && error.status === 404 ? "missing" : "unavailable", data: null });
      });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [budgetCode]);

  useEffect(() => {
    const query = communityQuery.trim();
    if (selectedCommunity || query.length < 3) {
      setCommunityResults([]);
      setCommunitySearchState("idle");
      return;
    }
    const controller = new AbortController();
    let active = true;
    setCommunitySearchState("loading");
    const timer = window.setTimeout(() => {
      searchBudgets(query, controller.signal).then(({ results }) => {
        if (!active) return;
        setCommunityResults(results);
        setCommunitySearchState("ready");
      }).catch((error) => {
        if (!active) return;
        if (error instanceof Error && error.name === "AbortError") return;
        setCommunityResults([]);
        setCommunitySearchState("error");
      });
    }, 350);
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [communityQuery, selectedCommunity]);

  const identity: LookupState = lookup.code === budgetCode.trim() ? lookup : { code: "", state: "idle", data: null };
  const shownReport = useMemo(() => {
    if (!report) return null;
    if (identity.state !== "found" || !identity.data || report.budget_code !== identity.code) return report;
    const data = identity.data;
    return { ...report, budget_name: data.budget_name, local_government_name: data.local_government_name,
      katottg: data.katottg, sources: { ...report.sources, openbudget_directory: data.directory_url,
        openbudget_directory_date: data.directory_date } };
  }, [report, identity.state, identity.code, identity.data]);
  const monthly = shownReport?.monthly || [];
  const selectedRow = monthly.find((row) => row.month === selectedMonth) || monthly.at(-1) || null;
  const activeMonth = selectedRow?.month || "";
  const annualRow = useMemo(() => shownReport ? annualSummary(shownReport.monthly, shownReport.year) : null, [shownReport]);
  const annualDetails = useMemo(() => {
    if (!shownReport) return null;
    const months = shownReport.monthly.map((row) => row.month);
    return {
      income_details: annualDetailRows(shownReport.income_details, months, shownReport.year),
      expense_economic_details: annualDetailRows(shownReport.expense_economic_details, months, shownReport.year),
      expense_program_details: annualDetailRows(shownReport.expense_program_details, months, shownReport.year),
    };
  }, [shownReport]);
  const periodRow = periodMode === "year" ? annualRow : selectedRow;
  const periodKey = periodMode === "year" ? String(shownReport?.year || year) : activeMonth;
  const selectedBalance = periodRow ? balanceForRow(periodRow) : null;
  const periodDetails = periodMode === "year" ? annualDetails?.[activeTab] : shownReport?.[activeTab];
  const incomeDetails = periodMode === "year" ? annualDetails?.income_details : shownReport?.income_details;
  const expenseDetails = periodMode === "year" ? annualDetails?.expense_economic_details : shownReport?.expense_economic_details;
  const programDetails = periodMode === "year" ? annualDetails?.expense_program_details : shownReport?.expense_program_details;
  const details = detailRows(periodDetails, periodKey, detailSearch);
  const incomeGroups = groupedDetails(incomeDetails, periodKey);
  const expenseGroups = groupedDetails(expenseDetails, periodKey);
  const topPrograms = (programDetails || [])
    .filter((item) => item.month === periodKey && toCents(item.actual_uah) > 0n)
    .sort((a, b) => Number(b.actual_uah) - Number(a.actual_uah)).slice(0, 5)
    .map((item): [string, bigint] => [`${item.code} · ${item.name}`, toCents(item.actual_uah)]);
  const payers = shownReport?.coverage?.spending_payer_edrpous || [];
  const transactions = transactionRows(shownReport?.transactions, transactionSearch);
  const visibleSteps = withSpending ? progressSteps : progressSteps.filter((item) => item.step !== "spending");
  const currentStepIndex = visibleSteps.findIndex((item) => item.step === analysisProgress?.step);
  const elapsedSeconds = analysisStartedAt ? Math.max(0, Math.floor((progressClock - analysisStartedAt) / 1000)) : 0;
  const sourceIsSlow = busy && lastProgressAt > 0 && progressClock - lastProgressAt >= 30000;
  const communityNeedsSelection = communityQuery.trim().length > 0 && !selectedCommunity;

  function chooseCommunity(community: BudgetIdentity) {
    setSelectedCommunity(community);
    setCommunityQuery(community.local_government_name || community.budget_name);
    setCommunityResults([]);
    setBudgetCode(community.budget_code);
    setRunStatus(`Обрано ${community.budget_name}. Код бюджету підставлено автоматично.`);
    setRunError(false);
  }

  function changeYear(value: string) {
    const selected = Number(value);
    setYear(selected);
    const [start, end] = defaultTransactionDates(selected);
    setDateStart(start);
    setDateEnd(end);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (communityNeedsSelection) {
      setRunStatus("Спочатку оберіть громаду зі списку або очистіть пошук і введіть код вручну.");
      setRunError(true);
      return;
    }
    const trimmedPayer = payer.trim();
    if (trimmedPayer && !/^\d{8}$/.test(trimmedPayer)) {
      setRunStatus("ЄДРПОУ повинен містити 8 цифр.");
      setRunError(true);
      return;
    }
    const controller = new AbortController();
    analysisAbort.current = controller;
    const started = Date.now();
    setAnalysisStartedAt(started);
    setLastProgressAt(started);
    setProgressClock(started);
    setAnalysisProgress(null);
    setWithSpending(Boolean(trimmedPayer));
    setBusy(true);
    setRunError(false);
    setRunStatus("Встановлюємо з’єднання з сервером аналізу…");
    try {
      const result = await analyzeBudget({
        budget_code: budgetCode.trim(), year, payer_edrpous: trimmedPayer ? [trimmedPayer] : [],
        transactions_start: trimmedPayer ? dateStart : null,
        transactions_end: trimmedPayer ? dateEnd : null,
      }, (progress) => {
        setAnalysisProgress(progress);
        setLastProgressAt(Date.now());
        setRunStatus(progress.message);
      }, controller.signal);
      setReport(result.report);
      setSavedAt(null);
      setSelectedMonth(result.report.monthly?.at(-1)?.month || "");
      setDetailSearch("");
      setTransactionSearch("");
      setRunStatus("Аналіз готовий.");
      requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        setRunStatus("Аналіз скасовано. Можна запустити його знову.");
      } else {
        setRunStatus(`Не вдалося провести аналіз: ${error instanceof Error ? error.message : String(error)}`);
        setRunError(true);
      }
    } finally {
      analysisAbort.current = null;
      setBusy(false);
    }
  }

  let codeHelp = "Введіть 10 цифр — покажемо офіційну назву бюджету з довідника OpenBudget.";
  if (identity.state === "loading") codeHelp = "Шукаємо назву в офіційному довіднику OpenBudget…";
  if (identity.state === "found" && identity.data) codeHelp = `За довідником OpenBudget (станом на ${identity.data.directory_date}): ${identity.data.budget_name}`;
  if (identity.state === "missing") codeHelp = "Цей код не знайдено в актуальному довіднику OpenBudget. Перевірте його перед аналізом.";
  if (identity.state === "unavailable") codeHelp = "Зараз не вдалося перевірити назву в OpenBudget. Можна спробувати аналіз за кодом.";
  if (selectedCommunity?.budget_code === budgetCode) codeHelp = `Обрано з довідника OpenBudget (станом на ${selectedCommunity.directory_date}): ${selectedCommunity.budget_name}`;

  return <>
    <header className="topbar" id="top"><div className="shell topbar-inner">
      <a className="brand" href="#top" aria-label="Hromada Finance Atlas — на початок сторінки">
        <span className="brand-mark" aria-hidden="true">H</span>
        <span className="brand-text"><strong>Hromada Finance Atlas</strong><span>Фінансова карта громад</span></span>
      </a>
      <nav className="header-nav" aria-label="Основна навігація">
        {shownReport && <a className="header-results-link" href="#results">Результати</a>}
        <a className="header-action" href="#analysis"><span className="header-action-long">Новий аналіз</span><span className="header-action-short">Аналіз</span><span aria-hidden="true">↗</span></a>
      </nav>
    </div></header>

    <main className="shell">
      <section className="intro"><div>
        <p className="eyebrow">Публічні фінанси • прозорий аналіз</p>
        <h1>Фінанси громади<br /><em>в одному місці.</em></h1>
        <p className="lead">Оберіть бюджет і рік. Сторінка збере офіційні дані про надходження та видатки й покаже їх помісячно.</p>
      </div><div className="intro-note"><span className="note-icon">↗</span><strong>Без ручних таблиць</strong><span>Дані завантажуються безпосередньо з OpenBudget. Платежі Spending — окрема деталізація.</span></div></section>

      <section className="panel form-panel" id="analysis" aria-labelledby="form-title">
        <div className="section-title"><div><p className="eyebrow">Новий запит</p><h2 id="form-title">Запустити аналіз</h2></div><span className="step">01 / Аналіз</span></div>
        <form onSubmit={handleSubmit}>
          <div className="community-search">
            <label htmlFor="community-query">Знайти громаду за назвою</label>
            <input id="community-query" type="search" autoComplete="off" value={communityQuery} disabled={busy}
              onChange={(event) => { setCommunityQuery(event.target.value); setSelectedCommunity(null); setCommunityResults([]); setCommunitySearchState("idle"); }}
              placeholder="Наприклад, Умань або Уманська" aria-describedby="community-help" />
            <small id="community-help" aria-live="polite">
              {selectedCommunity ? `Обрано: ${selectedCommunity.budget_name} · код ${selectedCommunity.budget_code}`
                : communitySearchState === "loading" ? "Шукаємо в офіційному довіднику OpenBudget…"
                : communitySearchState === "error" ? "Довідник зараз недоступний. Можна ввести код бюджету вручну."
                : communitySearchState === "ready" && !communityResults.length ? "Збігів не знайдено. Спробуйте іншу форму назви або введіть код вручну."
                : communityQuery.trim().length > 0 && communityQuery.trim().length < 3 ? "Введіть щонайменше 3 літери назви громади."
                : communityQuery.trim() ? "Оберіть результат зі списку, щоб підставити код бюджету." : "Не знаєте коду? Почніть вводити назву громади (від 3 літер)."}
            </small>
            {communitySearchState === "ready" && communityResults.length > 0 && !selectedCommunity && <div className="community-results">
              <p>Знайдено в <a href="https://api.openbudget.gov.ua/items/BUDG" target="_blank" rel="noopener noreferrer">довіднику OpenBudget ↗</a></p>
              <ul>{communityResults.map((item) => <li key={item.budget_code}><button type="button" onClick={() => chooseCommunity(item)}>
                <strong>{item.budget_name}</strong><span>{item.local_government_name || "Місцеву раду не вказано"}</span><code>{item.budget_code}</code>
              </button></li>)}</ul>
            </div>}
          </div>
          <div className="form-grid">
            <label>Код бюджету громади
              <input value={budgetCode} onChange={(event) => { setBudgetCode(event.target.value); setSelectedCommunity(null); setCommunityQuery(""); }} disabled={busy} inputMode="numeric" pattern="[0-9]{10}" maxLength={10} required aria-describedby="code-help" />
              <small id="code-help" aria-live="polite" className={identity.state === "missing" || identity.state === "unavailable" ? "lookup-error" : ""}>{codeHelp}</small>
            </label>
            <label>Рік
              <select value={year} onChange={(event) => changeYear(event.target.value)}>{years.map((value) => <option key={value} value={value}>{value}</option>)}</select>
              <small>Покажемо лише місяці, вже опубліковані в джерелі.</small>
            </label>
          </div>
          <details className="advanced"><summary><span>Додати окремі платежі зі Spending</span><span className="advanced-hint">необов’язково</span></summary>
            <p>Це деталізація лише за вказаним платником, а не всі платежі громади. Не додаємо їх вдруге до бюджетних видатків.</p>
            <div className="form-grid spending-grid">
              <label>ЄДРПОУ платника<input value={payer} onChange={(event) => setPayer(event.target.value)} inputMode="numeric" placeholder="04061613" maxLength={8} aria-describedby="payer-help" /><small id="payer-help">Виконавчий комітет Уманської міської ради: 04061613</small></label>
              <label>Від<input value={dateStart} onChange={(event) => setDateStart(event.target.value)} type="date" /></label>
              <label>До<input value={dateEnd} onChange={(event) => setDateEnd(event.target.value)} type="date" /></label>
            </div>
          </details>
          <div className="form-footer"><button className="primary-button" disabled={busy || communityNeedsSelection} type="submit">{busy ? "Аналіз триває…" : "Провести аналіз"} <span aria-hidden="true">{busy ? "◌" : "→"}</span></button>{busy && <button className="cancel-button" type="button" onClick={() => analysisAbort.current?.abort()}>Скасувати</button>}{!busy && <span id="run-status" role="status" aria-live="polite" style={{ color: runError ? "#b6523d" : undefined }}>{runStatus}</span>}</div>
          {busy && <div className="analysis-progress" aria-busy="true">
            <div className="analysis-progress-header"><span className="progress-spinner" aria-hidden="true" /><div><strong>Аналіз виконується</strong><p id="run-status" role="status" aria-live="polite">{runStatus}</p></div><span className="progress-time" aria-label={`Час очікування ${elapsedLabel(elapsedSeconds)}`}>{elapsedLabel(elapsedSeconds)}</span></div>
            <ol className="progress-steps" aria-label="Етапи аналізу">{visibleSteps.map((item, index) => <li key={item.step} className={index < currentStepIndex ? "done" : index === currentStepIndex ? "current" : "pending"}><span aria-hidden="true">{index < currentStepIndex ? "✓" : index + 1}</span>{item.label}</li>)}</ol>
            {sourceIsSlow && <p className="progress-slow">Джерело відповідає довше, ніж зазвичай. Запит ще відкритий; можна зачекати або скасувати й повторити пізніше.</p>}
            <p className="progress-note">Етапи надходять із сервера. Відсоток не показуємо, бо швидкість відповіді зовнішніх API непередбачувана.</p>
          </div>}
        </form>
      </section>

      {shownReport && <section ref={resultsRef} id="results" className="results" aria-labelledby="results-title">
        <div className="results-heading"><div><p className="eyebrow">Результати аналізу</p><h2 id="results-title">{shownReport.budget_name || "Фінансова картина"}</h2><p>Код бюджету {shownReport.budget_code} · {shownReport.year} рік · {monthly.length} місяців із доступними даними</p></div>
          <div className="download-actions"><button className="ghost-button" type="button" onClick={() => downloadFile(`hromada-${shownReport.budget_code}-${shownReport.year}-monthly.csv`, monthlyCsv(shownReport), "text/csv;charset=utf-8")}>↓ Помісячний CSV</button><button className="ghost-button" type="button" onClick={() => downloadFile(`hromada-${shownReport.budget_code}-${shownReport.year}.json`, JSON.stringify(shownReport, null, 2), "application/json;charset=utf-8")}>↓ Повний JSON</button></div>
        </div>
        <nav className="result-nav" aria-label="Розділи звіту"><a href="#overview">Огляд</a><a href="#timeline">По місяцях</a><a href="#structure">Структура</a>{payers.length > 0 && <a href="#transactions-section">Платежі</a>}<a href="#sources">Джерела</a></nav>

        <section id="overview" className="result-group" aria-labelledby="overview-title">
          <GroupHeading number="01" id="overview-title" title="Огляд бюджету" description={periodMode === "year" ? "Підсумок за доступні місяці обраного року" : "Основні показники за обраний місяць"} />
          <div className="panel period-panel"><div className="period-controls">
            <div className="period-toggle" role="group" aria-label="Період перегляду">
              <button type="button" className={periodMode === "month" ? "active" : ""} aria-pressed={periodMode === "month"} onClick={() => setPeriodMode("month")}>За місяць</button>
              <button type="button" className={periodMode === "year" ? "active" : ""} aria-pressed={periodMode === "year"} onClick={() => setPeriodMode("year")}>За рік</button>
            </div>
            {periodMode === "month" ? <label className="month-picker">Місяць<select value={activeMonth} onChange={(event) => setSelectedMonth(event.target.value)} aria-label="Оберіть місяць">{monthly.map((item) => <option key={item.month} value={item.month}>{monthLabel(item.month)}</option>)}</select></label>
              : <span className="period-coverage">{shownReport.year} рік · {monthly.length} опублікованих місяців{monthly.length ? ` (${monthly[0].month} — ${monthly.at(-1)?.month})` : ""}</span>}
          </div><span className="data-label">{savedAt ? `Збережений звіт · ${savedAt}` : "Щойно завантажено з API"}</span></div>
          <div className="kpi-grid">
            <article className="kpi"><span className="kpi-label"><Dot kind="income" /> Надходження</span><strong>{money(periodRow?.income_uah)}</strong><small>{periodMode === "year" ? "За опубліковані місяці року" : "Фактичні доходи бюджету за місяць"}</small></article>
            <article className="kpi"><span className="kpi-label"><Dot kind="expense" /> Витрати</span><strong>{money(periodRow?.expense_uah)}</strong><small>{periodMode === "year" ? "За опубліковані місяці року" : "Фактичні видатки бюджету за місяць"}</small></article>
            <article className="kpi balance-kpi"><span className="kpi-label"><Dot kind="balance" /> Залишок*</span><strong className={selectedBalance !== null && selectedBalance < 0n ? "negative" : ""}>{selectedBalance === null ? "Немає даних" : formatCents(selectedBalance)}</strong><small>Надходження мінус витрати</small></article>
          </div>
          <p className="balance-disclaimer">* Це <strong>розрахункова різниця {periodMode === "year" ? "за доступні місяці року" : "за місяць"}</strong>, а не фактичний залишок коштів на рахунках громади. Для справжнього залишку потрібні дані про кошти на початок періоду та операції фінансування.</p>
          <div className="source-strip"><span>Основні суми: <strong>OpenBudget</strong></span><a href={`https://openbudget.gov.ua/local-budget/${shownReport.budget_code}/info/profile`} target="_blank" rel="noopener noreferrer">Відкрити бюджет у першоджерелі ↗</a><a href="#sources">Як перевірити розрахунок ↓</a></div>
        </section>

        <section id="timeline" className="result-group" aria-labelledby="timeline-title">
          <GroupHeading number="02" id="timeline-title" title="Динаміка за місяцями" description="Порівняння надходжень, витрат і розрахункової різниці" />
          <section className="panel chart-panel"><div className="section-title"><h3>Надходження та витрати</h3><div className="legend"><span><Dot kind="income" /> Надходження</span><span><Dot kind="expense" /> Витрати</span></div></div><Chart rows={monthly} selected={periodMode === "month" ? activeMonth : ""} /></section>
          <section className="panel table-panel"><div className="section-title"><h3>Точні суми кожного місяця</h3></div><div className="table-wrap"><table><thead><tr><th>Місяць</th><th className="amount-column">Надходження, грн</th><th className="amount-column">Витрати, грн</th><th className="amount-column">Залишок*, грн</th></tr></thead><tbody>{monthly.map((item) => {
            const balance = balanceForRow(item);
            return <tr key={item.month} className={`month-table-row${periodMode === "month" && item.month === activeMonth ? " selected" : ""}`} tabIndex={0} role="button" aria-label={`Показати деталі за ${monthLabel(item.month)}`} onClick={() => { setSelectedMonth(item.month); setPeriodMode("month"); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedMonth(item.month); setPeriodMode("month"); } }}>
              <td>{monthLabel(item.month)}</td><td className="amount-column">{money(item.income_uah)}</td><td className="amount-column">{money(item.expense_uah)}</td><td className={`amount-column${balance !== null && balance < 0n ? " negative" : ""}`}>{balance === null ? "Немає даних" : formatCents(balance)}</td>
            </tr>;
          })}</tbody></table></div><p className="table-footnote">Натисніть на рядок, щоб перейти до показників цього місяця. Залишок* тут також є лише різницею надходжень і витрат.</p></section>
          <section className="panel year-panel" aria-labelledby="year-title"><div className="section-title"><div><p className="eyebrow">Опублікований період</p><h3 id="year-title">Разом за доступні місяці</h3></div><span className="step">{monthly.length ? `${monthly[0].month} — ${monthly.at(-1)?.month}` : "Немає місяців"}</span></div><div className="year-grid"><div><span>Надходження</span><strong>{money(annualRow?.income_uah)}</strong></div><div><span>Витрати</span><strong>{money(annualRow?.expense_uah)}</strong></div><div><span>Місяців у звіті</span><strong>{monthly.length}</strong></div></div><p className="table-footnote">Підсумовано лише опубліковані місяці; це не затверджений річний план. Якщо за один із них немає суми, річний підсумок не показується як нуль.</p></section>
        </section>

        <section id="structure" className="result-group" aria-labelledby="structure-title">
          <GroupHeading number="03" id="structure-title" title="Структура коштів" description={periodMode === "year" ? `Суми за кодами за ${monthly.length} опублікованих місяців ${shownReport.year} року` : "Звідки надійшли гроші та на що їх витрачено за вибраний місяць"} />
          <div className="breakdown-grid">
            <section className="panel breakdown-panel"><p className="eyebrow">Надходження</p><h3>Групи доходів</h3><Breakdown items={incomeGroups} total={periodRow?.income_uah} kind="income" /><div className="tourism-note"><span>Окремо: туристичний збір</span><strong>{money(periodRow?.tourist_tax_uah)}</strong><small>Коди 18030100 і 18030200; це не весь дохід від туризму.</small></div></section>
            <section className="panel breakdown-panel"><p className="eyebrow">Витрати</p><h3>Поточні й капітальні</h3><Breakdown items={expenseGroups} total={periodRow?.expense_uah} kind="expense" /></section>
            <section className="panel breakdown-panel"><p className="eyebrow">Витрати</p><h3>Найбільші програми</h3><Breakdown items={topPrograms} total={periodRow?.expense_uah} kind="program" empty={periodMode === "year" ? "Програм за доступні місяці немає." : "Програм за цей місяць немає."} /></section>
          </div>
          <section className="panel table-panel"><div className="section-title"><div><p className="eyebrow">Усі статті</p><h3>Деталізація за кодами</h3></div><span className="step">{details.length} рядків</span></div>
            <div className="tabs" role="tablist" aria-label="Категорії даних">{([ ["income_details", "Надходження"], ["expense_economic_details", "Витрати за КЕКВ"], ["expense_program_details", "Бюджетні програми"] ] as [DetailTab, string][]).map(([key, title]) => <button key={key} type="button" className={`tab${activeTab === key ? " active" : ""}`} role="tab" aria-selected={activeTab === key} onClick={() => setActiveTab(key)}>{title}</button>)}</div>
            <div className="table-tools"><label htmlFor="detail-search">Пошук за назвою або кодом</label><input id="detail-search" type="search" value={detailSearch} onChange={(event) => setDetailSearch(event.target.value)} placeholder="Наприклад, туристичний збір або 2111" /></div>
            <div className="table-wrap"><table><thead><tr><th>Код</th><th>Назва</th><th className="amount-column">{periodMode === "year" ? "Сума за доступні місяці, грн" : "Сума за місяць, грн"}</th></tr></thead><tbody>{details.length ? details.map((item, index) => <tr key={`${item.month}-${item.code}-${index}`}><td>{item.code}</td><td>{item.name}</td><td className={`amount-column${Number(item.actual_uah) < 0 ? " negative" : ""}`}>{money(item.actual_uah)}</td></tr>) : <tr><td>—</td><td>{periodMode === "year" ? "За доступні місяці деталізацію не опубліковано" : "За цей місяць деталізацію не опубліковано"}</td><td className="amount-column">—</td></tr>}</tbody></table></div>
            <p className="table-footnote">Від’ємні значення можуть бути коригуваннями у джерелі. Пошук фільтрує лише поточну вкладку й {periodMode === "year" ? "доступні місяці року" : "обраний місяць"}. Річна сума — це підсумок місячних фактів, не сума накопичувальних показників.</p>
          </section>
        </section>

        {payers.length > 0 && <section id="transactions-section" className="result-group" aria-labelledby="transactions-title"><GroupHeading number="04" id="transactions-title" title="Окремі платежі" description="Деталізація Spending за вибраним ЄДРПОУ, окремо від бюджетного підсумку" /><div className="panel table-panel"><div className="section-title"><h3>Транзакції платника</h3><span className="step">{transactionSearch ? `${transactions.length} із ${(shownReport.transactions || []).length}` : transactions.length} платежів</span></div>
          <p className="table-footnote top-note">Платник(и): {payers.join(", ")} · період: {(shownReport.coverage?.spending_dates || []).join(" — ")}. Ці платежі не додаються до бюджетних видатків повторно й можуть бути за місяць, відсутній у бюджетному звіті.</p>
          <div className="table-tools"><label htmlFor="transaction-search">Пошук за одержувачем або призначенням</label><input id="transaction-search" type="search" value={transactionSearch} onChange={(event) => setTransactionSearch(event.target.value)} placeholder="Введіть назву чи слово з призначення" /></div>
          <div className="table-wrap transactions-wrap"><table><thead><tr><th>Дата</th><th>Одержувач / призначення</th><th>КЕКВ</th><th className="amount-column">Сума</th></tr></thead><tbody>{[...transactions].reverse().slice(0, 500).map((item) => <tr key={item.id}><td>{item.date}</td><td>{item.recipient_name || "Одержувача не вказано"}<span className="transaction-detail">{item.payment_details || "Без призначення"}</span></td><td>{item.kekv || "—"}</td><td className="amount-column">{money(item.amount ?? item.amount_uah)} {item.currency && item.currency !== "UAH" ? item.currency : ""}</td></tr>)}</tbody></table></div>
          {transactions.length > 500 && <p className="table-footnote">На сторінці останні 500 платежів із {transactions.length}. Повний перелік є у JSON.</p>}
        </div></section>}

        <section id="sources" className="result-group" aria-labelledby="sources-title"><GroupHeading number="05" id="sources-title" title="Джерела та перевірка" description="Звідки взято цифри і як самостійно їх звірити" /><div className="bottom-grid">
          <section className="panel info-panel"><p className="eyebrow">Першоджерела</p><h3>Офіційні сайти та точні запити</h3><div id="sources-list">{sourceLinks(shownReport).map(([title, url]) => <a key={`${title}-${url}`} className="source-link" href={url} target="_blank" rel="noopener noreferrer">{title} ↗</a>)}</div><p className="source-note">OpenBudget дає бюджетні підсумки. Spending — лише окремі транзакції зазначених платників; вони не додаються до підсумків удруге.</p></section>
          <section className="panel info-panel"><p className="eyebrow">Як рахували</p><h3>Методика й межі</h3><ol className="method-list"><li>Завантажуємо фактичні доходи та видатки за кодом бюджету з OpenBudget.</li><li>Місячний факт = накопичений факт цього місяця мінус накопичений факт попереднього.</li><li>Залишок* = доходи мінус видатки лише за обраний місяць; це не залишок на рахунку.</li><li>Звіряємо фонди та підсумки за бюджетними програмами й КЕКВ.</li></ol><p className="source-note">Що ще не охоплено:</p><ul className="limit-list">{(shownReport.coverage?.limitations || []).map((note) => <li key={note}>{note}</li>)}</ul></section>
        </div><section className="panel info-panel warnings-panel"><p className="eyebrow">Контроль даних</p><h3>Попередження з розрахунків</h3><ul>{(shownReport.warnings?.length ? shownReport.warnings : ["Звірка не виявила попереджень."]).map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}</ul></section></section>
      </section>}
      <footer>Hromada Finance Atlas · Прототип · Джерела наведено в кожному звіті</footer>
    </main>
  </>;
}

export default App;
