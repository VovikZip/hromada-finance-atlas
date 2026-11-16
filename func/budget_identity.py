"""Resolve budget names from OpenBudget's official BUDG dictionary."""

from __future__ import annotations

import json
import re
import threading
from datetime import date
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DIRECTORY_URL = "https://api.openbudget.gov.ua/items/BUDG"
_lock = threading.Lock()
_cached_date: date | None = None
_cached_budgets: dict[str, dict[str, str]] = {}


class BudgetDirectoryError(Exception):
    """The official budget dictionary could not be loaded."""


def parse_budget_directory(records: object) -> dict[str, dict[str, str]]:
    if not isinstance(records, list):
        raise BudgetDirectoryError("Довідник OpenBudget має неочікуваний формат")
    selected: dict[str, dict[str, str]] = {}
    ambiguous: set[str] = set()
    for record in records:
        if not isinstance(record, dict) or record.get("endDate") is not None:
            continue
        code = str(record.get("codebudg") or "")
        name = str(record.get("namebudg") or "").strip()
        if not re.fullmatch(r"\d{10}", code) or not name:
            continue
        # One budget can have many territory records; cntBudg=1 identifies
        # the budget's own entry rather than its subordinate settlements.
        if record.get("cntBudg") != 1:
            continue
        if code in ambiguous:
            continue
        identity = {
            "budget_name": name,
            "local_government_name": str(record.get("nameLocalGov") or "").strip(),
            "katottg": str(record.get("katottg") or "").strip(),
        }
        previous = selected.get(code)
        if previous and previous["budget_name"] != name:
            # Never choose an arbitrary name when official rows disagree.
            selected.pop(code)
            ambiguous.add(code)
            continue
        selected[code] = identity
    if not selected:
        raise BudgetDirectoryError("Довідник OpenBudget не містить активних бюджетів")
    return selected


def current_budget_directory() -> tuple[dict[str, dict[str, str]], date]:
    """Return active BUDG records and the date of the loaded official snapshot."""
    global _cached_date, _cached_budgets
    today = date.today()
    with _lock:
        if _cached_date != today:
            url = f"{DIRECTORY_URL}?{urlencode({'dateFrom': today.isoformat()})}"
            request = Request(url, headers={"User-Agent": "HromadaFinanceAtlas/0.1 (public-data research)"})
            try:
                with urlopen(request, timeout=45) as response:
                    records = json.load(response)
                budgets = parse_budget_directory(records)
            except (OSError, json.JSONDecodeError) as exc:
                if not _cached_budgets:
                    raise BudgetDirectoryError(f"Довідник OpenBudget недоступний: {exc}") from exc
                # Keep last known names, but report their original snapshot date.
            else:
                _cached_date = today
                _cached_budgets = budgets
        return _cached_budgets.copy(), _cached_date or today


def budget_identity(code: str) -> dict[str, str] | None:
    """Return a current official name, or None for a code absent from BUDG."""
    if not re.fullmatch(r"\d{10}", code):
        raise ValueError("Код бюджету має складатися з 10 цифр")
    budgets, snapshot_date = current_budget_directory()
    identity = budgets.get(code)
    if identity is None:
        return None
    return {
        **identity,
        "directory_url": f"{DIRECTORY_URL}?{urlencode({'dateFrom': snapshot_date.isoformat()})}",
        "profile_url": f"https://openbudget.gov.ua/local-budget/{code}/info/profile",
        "directory_date": snapshot_date.isoformat(),
    }


def search_budgets(query: str, limit: int = 12) -> list[dict[str, str]]:
    """Find candidate budgets by their official budget or council name."""
    query = " ".join(query.casefold().split())
    if not 3 <= len(query) <= 80:
        raise ValueError("Введіть від 3 до 80 символів назви громади")
    # Search by meaningful words, not generic labels shared by all budgets.
    generic = {"бюджет", "громада", "громади", "територіальна", "територіальної",
               "міська", "міської", "селищна", "селищної", "сільська", "сільської", "рада", "ради"}
    words = [word for word in re.findall(r"[\w’'-]+", query) if word not in generic]
    if not words:
        raise ValueError("Додайте власну назву громади, наприклад «Умань»")
    budgets, snapshot_date = current_budget_directory()

    def word_matches(word: str, text: str) -> bool:
        if word in text:
            return True
        stem = word[:-1] if len(word) >= 5 and word.endswith(("ь", "и", "а", "я")) else word
        return len(stem) >= 3 and stem in text

    matches: list[tuple[int, str, dict[str, str]]] = []
    for code, identity in budgets.items():
        name = identity["budget_name"].casefold()
        council = identity["local_government_name"].casefold()
        if not all(word_matches(word, name) or word_matches(word, council) for word in words):
            continue
        rank = 0 if query in council else 1 if query in name else 2
        matches.append((rank, code, identity))
    matches.sort(key=lambda item: (item[0], item[2]["budget_name"], item[1]))
    directory_url = f"{DIRECTORY_URL}?{urlencode({'dateFrom': snapshot_date.isoformat()})}"
    return [
        {"budget_code": code, **identity, "directory_url": directory_url,
         "directory_date": snapshot_date.isoformat(),
         "profile_url": f"https://openbudget.gov.ua/local-budget/{code}/info/profile"}
        for _, code, identity in matches[:limit]
    ]
