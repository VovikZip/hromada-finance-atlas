"""Monthly local-budget analysis from official Ukrainian open-data APIs.

Python 3.10+, standard library only. Run ``python -m func.hromada_atlas --help``.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import time
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from func.budget_identity import BudgetDirectoryError, budget_identity


OPENBUDGET = "https://api.openbudget.gov.ua/api/public/localBudgetData"
SPENDING = "https://api.spending.gov.ua/api/v2/api/transactions/"
ZERO = Decimal("0")
CENT = Decimal("0.01")
INCOME_GROUPS = {
    "1": "Податкові надходження",
    "2": "Неподаткові надходження",
    "3": "Доходи від операцій з капіталом",
    "4": "Офіційні трансферти",
    "5": "Цільові фонди",
}
EXPENSE_GROUPS = {
    "2": "Поточні видатки",
    "3": "Капітальні видатки",
}
TOURIST_TAX_CODES = {"18030100", "18030200"}


class DataError(Exception):
    """Source data cannot be safely interpreted."""


def fetch(url: str, params: dict[str, str]) -> tuple[bytes, str]:
    full_url = f"{url}?{urlencode(params)}"
    request = Request(full_url, headers={"User-Agent": "HromadaFinanceAtlas/0.1 (public-data research)"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=60) as response:
                return response.read(), full_url
        except (HTTPError, URLError, TimeoutError) as exc:
            if isinstance(exc, HTTPError) and exc.code not in (429, 500, 502, 503, 504):
                raise DataError(f"HTTP {exc.code}: {full_url}") from exc
            if attempt == 2:
                raise DataError(f"API недоступний: {full_url} ({exc})") from exc
            time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def decode_csv(payload: bytes) -> list[dict[str, str]]:
    try:
        content = payload.decode("utf-8-sig")
    except UnicodeDecodeError:
        content = payload.decode("cp1251")
    reader = csv.DictReader(io.StringIO(content), delimiter=";")
    if not reader.fieldnames or "REP_PERIOD" not in reader.fieldnames or "FAKT_AMT" not in reader.fieldnames:
        raise DataError("OpenBudget повернув неочікувані колонки CSV")
    rows = list(reader)
    if not rows:
        raise DataError("OpenBudget повернув порожній CSV")
    return rows


def amount(value: object) -> Decimal:
    cleaned = str(value or "0").replace("\u00a0", "").replace(" ", "").replace(",", ".")
    try:
        result = Decimal(cleaned)
    except InvalidOperation as exc:
        raise DataError(f"Некоректна сума: {value!r}") from exc
    if not result.is_finite():
        raise DataError(f"Некоректна сума: {value!r}")
    return result


def month_of(value: str, year: int) -> str:
    match = re.fullmatch(r"(0[1-9]|1[0-2])\.(\d{4})", value.strip())
    if not match or int(match.group(2)) != year:
        raise DataError(f"Неочікуваний звітний період: {value!r}")
    return f"{year}-{match.group(1)}"


def budget_csv(budget_code: str, year: int, item: str, classification: str | None = None) -> tuple[list[dict[str, str]], str]:
    params = {"budgetCode": budget_code, "budgetItem": item, "period": "MONTH", "year": str(year)}
    if classification:
        params["classificationType"] = classification
    payload, url = fetch(OPENBUDGET, params)
    return decode_csv(payload), url


def cumulative_index(
    rows: list[dict[str, str]], year: int, budget_code: str,
    code_field: str, name_field: str, *, aggregate_program: bool = False,
) -> tuple[dict[tuple[str, str, str], Decimal], dict[str, str]]:
    index: dict[tuple[str, str, str], Decimal] = defaultdict(lambda: ZERO)
    names: dict[str, str] = {}
    for row in rows:
        if row.get("COD_BUDGET") != budget_code:
            raise DataError("CSV містить дані іншого бюджету")
        if aggregate_program and row.get("COD_CONS_EK") != "0000":
            continue  # program total only; detailed KЕКВ would double-count
        month = month_of(row["REP_PERIOD"], year)
        fund = row.get("FUND_TYP", "").strip()
        if fund not in {"T", "C", "S"}:
            raise DataError(f"Невідомий тип фонду: {fund!r}")
        code = (row.get(code_field) or "").strip()
        if not code:
            raise DataError(f"Порожній код {code_field}")
        index[(month, fund, code)] += amount(row.get("FAKT_AMT"))
        names[code] = (row.get(name_field) or code).strip()
    if not index:
        raise DataError("Немає рядків фактичного виконання в обраному розрізі")
    return dict(index), names


def validate_funds(index: dict[tuple[str, str, str], Decimal], label: str) -> list[str]:
    warnings = []
    for month, code in sorted({(month, code) for month, _, code in index}):
        total = index.get((month, "T", code))
        if total is None:
            warnings.append(f"{label}: немає фонду T для {month}, код {code}")
            continue
        split = index.get((month, "C", code), ZERO) + index.get((month, "S", code), ZERO)
        if abs(total - split) > CENT:
            warnings.append(f"{label}: T не дорівнює C+S у {month}, код {code}: {total} проти {split}")
    return warnings


def monthly_details(
    index: dict[tuple[str, str, str], Decimal], names: dict[str, str], year: int,
    *, group_names: dict[str, str], group_width: int,
) -> tuple[list[dict[str, object]], list[str]]:
    observed = sorted({month for month, fund, _ in index if fund == "T"})
    if not observed:
        raise DataError("Немає даних загального підсумку T")
    warnings = []
    output = []
    for month in observed:
        month_number = int(month[-2:])
        previous = f"{year}-{month_number - 1:02d}" if month_number > 1 else None
        if previous is not None and previous not in observed:
            warnings.append(f"Немає попереднього місяця для {month}; помісячний факт не обчислено")
            continue
        current_codes = {code for m, fund, code in index if m == month and fund == "T"}
        previous_codes = {code for m, fund, code in index if m == previous and fund == "T"} if previous else set()
        disappeared = previous_codes - current_codes
        for code in sorted(disappeared):
            if index[(previous, "T", code)] != ZERO:
                warnings.append(f"Код {code} був у {previous}, але відсутній у {month}; зміну не виведено")
        for code in sorted(current_codes):
            current = index[(month, "T", code)]
            prior = index.get((previous, "T", code), ZERO) if previous else ZERO
            value = current - prior
            if value < -CENT:
                warnings.append(f"Від'ємна зміна накопиченого факту: {month}, код {code}, {value}")
            prefix = code[:group_width]
            output.append({
                "month": month, "code": code, "name": names.get(code, code),
                "group": group_names.get(prefix, f"Інше ({prefix})"),
                "actual_uah": value,
            })
    return output, warnings


def total_by_month(details: list[dict[str, object]]) -> dict[str, Decimal]:
    totals: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for row in details:
        totals[str(row["month"])] += row["actual_uah"]  # type: ignore[operator]
    return dict(totals)


def date_chunks(start: date, end: date):
    current = start
    while current <= end:
        last = min(current + timedelta(days=6), end)
        yield current, last
        current = last + timedelta(days=1)


def spending_transactions(
    payer_codes: list[str], start: date, end: date, budget_code: str,
    progress: Callable[[str, str], None] | None = None,
) -> tuple[list[dict[str, object]], list[str]]:
    transactions: dict[str, dict[str, object]] = {}
    source_urls = []
    total_requests = len(payer_codes) * len(list(date_chunks(start, end)))
    request_number = 0
    for payer in payer_codes:
        for first, last in date_chunks(start, end):
            request_number += 1
            if progress:
                progress("spending", f"Spending: запит {request_number} із {total_requests} ({first}–{last})")
            payload, url = fetch(SPENDING, {
                "payers_edrpous": payer, "startdate": first.isoformat(), "enddate": last.isoformat(),
            })
            source_urls.append(url)
            try:
                records = json.loads(payload.decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise DataError(f"Spending повернув неочікуваний JSON: {url}") from exc
            if not isinstance(records, list):
                raise DataError(f"Spending повернув не список транзакцій: {url}")
            for record in records:
                if not isinstance(record, dict):
                    continue
                if str(record.get("payer_edrpou") or "").strip() != payer:
                    continue
                reported_budget = str(record.get("budgetCode") or "").strip()
                if reported_budget != budget_code:
                    continue
                transaction_date = str(record.get("trans_date") or "")[:10]
                if not (start.isoformat() <= transaction_date <= end.isoformat()):
                    continue
                transaction_id = str(record.get("id") or "").strip()
                if not transaction_id:
                    continue
                transactions[transaction_id] = {
                    "id": transaction_id, "date": transaction_date,
                    "payer_edrpou": payer, "payer_name": record.get("payer_name") or "",
                    "recipient_edrpou": record.get("recipt_edrpou") or "",
                    "recipient_name": record.get("recipt_name") or "",
                    "amount": amount(record.get("amount")),
                    "currency": record.get("currency") or "",
                    "kekv": record.get("kekv") or "", "kpk": record.get("kpk") or "",
                    "payment_details": record.get("payment_details") or "",
                    "budget_code": reported_budget,
                }
    return sorted(transactions.values(), key=lambda x: (x["date"], x["id"])), source_urls


def serializable(value: object) -> object:
    if isinstance(value, Decimal):
        return format(value.quantize(CENT), "f")
    if isinstance(value, dict):
        return {key: serializable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [serializable(item) for item in value]
    return value


def write_csv(path: Path, rows: list[dict[str, object]], fields: list[str]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, delimiter=";", extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(serializable(row))


def build_report(
    budget_code: str, year: int, payers: list[str], start: date | None, end: date | None,
    *, progress: Callable[[str, str], None] | None = None,
) -> dict[str, object]:
    def report_progress(step: str, message: str) -> None:
        if progress:
            progress(step, message)

    report_progress("incomes", "Отримуємо фактичні доходи з OpenBudget…")
    incomes, income_url = budget_csv(budget_code, year, "INCOMES")
    report_progress("economic", "Отримуємо видатки за економічною класифікацією…")
    economic, economic_url = budget_csv(budget_code, year, "EXPENSES", "ECONOMIC")
    report_progress("programs", "Отримуємо видатки за бюджетними програмами…")
    programs, program_url = budget_csv(budget_code, year, "EXPENSES", "PROGRAM")

    report_progress("calculation", "Рахуємо місячні суми та звіряємо підсумки…")
    income_index, income_names = cumulative_index(incomes, year, budget_code, "COD_INCO", "NAME_INC")
    economic_index, economic_names = cumulative_index(economic, year, budget_code, "COD_CONS_EK", "COD_CONS_EK_NAME")
    program_index, program_names = cumulative_index(
        programs, year, budget_code, "COD_CONS_MB_PK", "COD_CONS_MB_PK_NAME", aggregate_program=True,
    )
    income_detail, income_warnings = monthly_details(income_index, income_names, year, group_names=INCOME_GROUPS, group_width=1)
    economic_detail, economic_warnings = monthly_details(economic_index, economic_names, year, group_names=EXPENSE_GROUPS, group_width=1)
    program_detail, program_warnings = monthly_details(program_index, program_names, year, group_names={}, group_width=4)

    warnings = (
        validate_funds(income_index, "Доходи") + validate_funds(economic_index, "Видатки КЕКВ")
        + validate_funds(program_index, "Видатки за програмами")
        + income_warnings + economic_warnings + program_warnings
    )
    report_progress("identity", "Перевіряємо назву бюджету в офіційному довіднику…")
    try:
        identity = budget_identity(budget_code)
    except BudgetDirectoryError as exc:
        identity = None
        warnings.append(f"Не вдалося підтвердити назву бюджету: {exc}")
    if identity is None and not any("назву бюджету" in warning for warning in warnings):
        warnings.append("Код бюджету відсутній в актуальному довіднику OpenBudget; назву не підтверджено")
    income_totals = total_by_month(income_detail)
    expense_totals = total_by_month(economic_detail)
    program_totals = total_by_month(program_detail)
    months = sorted(set(income_totals) | set(expense_totals) | set(program_totals))
    summary = []
    for month in months:
        income_total = income_totals.get(month)
        expense_total = expense_totals.get(month)
        program_total = program_totals.get(month)
        if expense_total is not None and program_total is not None and abs(expense_total - program_total) > CENT:
            warnings.append(f"{month}: сума видатків КЕКВ {expense_total} не збігається з програмами {program_total}")
        month_number = int(month[-2:])
        previous = f"{year}-{month_number - 1:02d}" if month_number > 1 else None
        for label, index, calculated in (
            ("Доходи", income_index, income_total),
            ("Видатки КЕКВ", economic_index, expense_total),
            ("Видатки за програмами", program_index, program_total),
        ):
            if calculated is None:
                continue
            current_cumulative = sum((value for (m, fund, _), value in index.items() if m == month and fund == "T"), ZERO)
            previous_cumulative = sum((value for (m, fund, _), value in index.items() if m == previous and fund == "T"), ZERO)
            if abs(calculated - (current_cumulative - previous_cumulative)) > CENT:
                warnings.append(f"{label}: деталі {month} не збігаються зі зміною загального факту")
        tourist_tax = sum((row["actual_uah"] for row in income_detail if row["month"] == month and row["code"] in TOURIST_TAX_CODES), ZERO)
        income_minus_expense = income_total - expense_total if income_total is not None and expense_total is not None else None
        summary.append({
            "month": month, "income_uah": income_total, "expense_uah": expense_total,
            "income_minus_expense_uah": income_minus_expense,
            "tourist_tax_uah": tourist_tax,
            "program_expense_uah": program_total,
        })

    transactions: list[dict[str, object]] = []
    spending_urls: list[str] = []
    if payers and start and end:
        report_progress("spending", "Отримуємо окремі платежі зі Spending…")
        transactions, spending_urls = spending_transactions(payers, start, end, budget_code, progress=progress)
    else:
        warnings.append("Spending не запитувався: не вказано ЄДРПОУ платників і діапазон дат")

    report_progress("finish", "Формуємо звіт…")
    return {
        "budget_code": budget_code, "budget_name": identity["budget_name"] if identity else None,
        "local_government_name": identity["local_government_name"] if identity else None,
        "katottg": identity["katottg"] if identity else None,
        "year": year,
        "coverage": {
            "budget_months": months,
            "spending_payer_edrpous": payers,
            "spending_dates": [start.isoformat(), end.isoformat()] if start and end else None,
            "limitations": [
                "OpenBudget показує виконання бюджету; транзакції Spending не додаються до його підсумків.",
                "Spending охоплює лише зазначених платників, не автоматично всіх установ громади.",
                "Туристичний збір — лише коди 18030100 і 18030200; це не всі доходи від туризму.",
                "Дані комунальних підприємств, закупівельні зобов'язання і фінансування бюджету тут не враховані.",
            ],
        },
        "sources": {
            "openbudget_directory": identity["directory_url"] if identity else "https://api.openbudget.gov.ua/items/BUDG",
            "openbudget_directory_date": identity["directory_date"] if identity else None,
            "openbudget_incomes": income_url,
            "openbudget_expenses_economic": economic_url,
            "openbudget_expenses_program": program_url,
            "spending_requests": spending_urls,
        },
        "monthly": summary,
        "income_details": income_detail,
        "expense_economic_details": economic_detail,
        "expense_program_details": program_detail,
        "transactions": transactions,
        "warnings": warnings,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Помісячний аналіз доходів і видатків бюджету громади")
    parser.add_argument("--budget-code", required=True, help="Код бюджету OpenBudget, наприклад 2357400000 для Умані")
    parser.add_argument("--year", type=int, required=True, help="Звітний рік")
    parser.add_argument("--payer-edrpou", action="append", default=[], help="ЄДРПОУ платника для Spending; повторюйте для кількох")
    parser.add_argument("--transactions-start", type=date.fromisoformat, help="Початок транзакцій, YYYY-MM-DD")
    parser.add_argument("--transactions-end", type=date.fromisoformat, help="Кінець транзакцій, YYYY-MM-DD")
    parser.add_argument("--output-dir", type=Path, default=Path("reports"), help="Папка звіту (типово ./reports)")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"\d{10}", args.budget_code):
        parser.error("--budget-code має містити 10 цифр")
    if args.year < 2018 or args.year > date.today().year:
        parser.error("--year поза допустимим діапазоном")
    if any(not re.fullmatch(r"\d{8}", value) for value in args.payer_edrpou):
        parser.error("кожен --payer-edrpou має містити 8 цифр")
    date_args = (args.transactions_start, args.transactions_end)
    if args.payer_edrpou and (not all(date_args) or args.transactions_start > args.transactions_end):
        parser.error("для Spending задайте коректні --transactions-start і --transactions-end")
    if any(date_args) and (not all(date_args) or not args.payer_edrpou):
        parser.error("дати транзакцій задаються разом із --payer-edrpou")
    if args.transactions_start and (args.transactions_start.year != args.year or args.transactions_end.year != args.year):
        parser.error("діапазон транзакцій повинен бути в межах --year")
    try:
        report = build_report(args.budget_code, args.year, sorted(set(args.payer_edrpou)), *date_args)
        args.output_dir.mkdir(parents=True, exist_ok=True)
        (args.output_dir / "report.json").write_text(
            json.dumps(serializable(report), ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
        write_csv(args.output_dir / "monthly.csv", report["monthly"],
                  ["month", "income_uah", "expense_uah", "income_minus_expense_uah", "tourist_tax_uah", "program_expense_uah"])
        detail_fields = ["month", "code", "name", "group", "actual_uah"]
        for key in ("income_details", "expense_economic_details", "expense_program_details"):
            write_csv(args.output_dir / f"{key}.csv", report[key], detail_fields)
        if args.payer_edrpou:
            write_csv(args.output_dir / "transactions.csv", report["transactions"],
                      ["id", "date", "payer_edrpou", "payer_name", "recipient_edrpou", "recipient_name",
                       "amount", "currency", "kekv", "kpk", "payment_details", "budget_code"])
    except (DataError, OSError) as exc:
        print(f"Помилка: {exc}", file=sys.stderr)
        return 1
    print(f"Бюджет {args.budget_code}, {args.year}: {len(report['monthly'])} місяців; звіт: {args.output_dir.resolve()}")
    print(f"Транзакцій Spending: {len(report['transactions'])}; попереджень: {len(report['warnings'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
