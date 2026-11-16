"""Tiny local browser UI for Hromada Finance Atlas (no dependencies)."""

from __future__ import annotations

import argparse
import json
import mimetypes
import re
import threading
import webbrowser
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from func.budget_identity import BudgetDirectoryError, budget_identity, search_budgets
from func.hromada_atlas import DataError, build_report, serializable


ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"


def validate_request(data: object) -> tuple[str, int, list[str], date | None, date | None]:
    if not isinstance(data, dict):
        raise ValueError("Очікується JSON-об’єкт")
    budget_code = str(data.get("budget_code") or "").strip()
    if not re.fullmatch(r"\d{10}", budget_code):
        raise ValueError("Код бюджету має складатися з 10 цифр")
    try:
        year = int(data.get("year"))
    except (ValueError, TypeError) as exc:
        raise ValueError("Оберіть рік") from exc
    if not 2018 <= year <= date.today().year:
        raise ValueError("Рік поза доступним діапазоном")
    raw_payers = data.get("payer_edrpous") or []
    if not isinstance(raw_payers, list) or any(not isinstance(payer, str) for payer in raw_payers):
        raise ValueError("ЄДРПОУ мають бути списком")
    payers = sorted(set(payer.strip() for payer in raw_payers if payer.strip()))
    if any(not re.fullmatch(r"\d{8}", payer) for payer in payers):
        raise ValueError("ЄДРПОУ платника має складатися з 8 цифр")
    start_raw = str(data.get("transactions_start") or "").strip()
    end_raw = str(data.get("transactions_end") or "").strip()
    if payers:
        if not start_raw or not end_raw:
            raise ValueError("Для транзакцій вкажіть початок і кінець періоду")
        try:
            start, end = date.fromisoformat(start_raw), date.fromisoformat(end_raw)
        except ValueError as exc:
            raise ValueError("Дати мають бути у форматі РРРР-ММ-ДД") from exc
        if start > end or start.year != year or end.year != year:
            raise ValueError("Період транзакцій має бути в межах обраного року")
        if (end - start).days > 92:
            raise ValueError("За один запит оберіть не більше 93 днів транзакцій")
    else:
        start = end = None
    return budget_code, year, payers, start, end


class Handler(BaseHTTPRequestHandler):
    def send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, value: object, status: int = 200) -> None:
        body = json.dumps(serializable(value), ensure_ascii=False).encode("utf-8")
        self.send_bytes(body, "application/json; charset=utf-8", status)

    def send_stream_event(self, value: object) -> None:
        line = (json.dumps(serializable(value), ensure_ascii=False) + "\n").encode("utf-8")
        self.wfile.write(line)
        self.wfile.flush()

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path
        if path == "/api/saved":
            reports = list((ROOT / "reports").glob("*/report.json"))
            if not reports:
                self.send_json({"error": "Немає збереженого звіту"}, 404)
                return
            latest = max(reports, key=lambda item: item.stat().st_mtime)
            try:
                report = json.loads(latest.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                self.send_json({"error": "Не вдалося прочитати збережений звіт"}, 500)
                return
            self.send_json({"report": report, "saved_at": date.fromtimestamp(latest.stat().st_mtime).isoformat()})
            return
        if path == "/api/budget-name":
            code = parse_qs(parsed.query).get("code", [""])[0]
            try:
                identity = budget_identity(code)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            except BudgetDirectoryError as exc:
                self.send_json({"error": str(exc)}, 502)
                return
            if identity is None:
                self.send_json({"error": "Код не знайдено в актуальному довіднику місцевих бюджетів OpenBudget"}, 404)
                return
            self.send_json({"budget_code": code, **identity})
            return
        if path == "/api/budget-search":
            query = parse_qs(parsed.query).get("q", [""])[0]
            try:
                results = search_budgets(query)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            except BudgetDirectoryError as exc:
                self.send_json({"error": str(exc)}, 502)
                return
            self.send_json({"results": results})
            return
        if path == "/" or path.startswith("/assets/"):
            asset = DIST / ("index.html" if path == "/" else path.lstrip("/"))
            if not asset.resolve().is_relative_to(DIST.resolve()) or not asset.is_file():
                self.send_json({"error": "Збірку React не знайдено. Виконайте npm run build."}, 404)
                return
            content_type = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
            self.send_bytes(asset.read_bytes(), f"{content_type}; charset=utf-8" if content_type.startswith(("text/", "application/javascript")) else content_type)
            return
        self.send_json({"error": "Сторінку не знайдено"}, 404)

    def do_POST(self) -> None:
        if self.path not in {"/api/analyze", "/api/analyze-stream"}:
            self.send_json({"error": "Сторінку не знайдено"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384:
                raise ValueError("Некоректний розмір запиту")
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            args = validate_request(body)
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)
            return
        if self.path == "/api/analyze-stream":
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                report = build_report(
                    *args, progress=lambda step, message: self.send_stream_event(
                        {"type": "progress", "step": step, "message": message},
                    ),
                )
                self.send_stream_event({"type": "result", "report": report})
            except (BrokenPipeError, ConnectionResetError):
                return
            except (DataError, OSError) as exc:
                try:
                    self.send_stream_event({"type": "error", "message": str(exc)})
                except (BrokenPipeError, ConnectionResetError):
                    pass
            return
        try:
            report = build_report(*args)
        except (DataError, OSError) as exc:
            self.send_json({"error": str(exc)}, 502)
            return
        self.send_json({"report": report})

    def log_message(self, format: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Локальна сторінка Hromada Finance Atlas")
    parser.add_argument("--port", type=int, default=0, help="Порт; типово обирається автоматично")
    parser.add_argument("--no-browser", action="store_true", help="Не відкривати браузер автоматично")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Hromada Finance Atlas: {url}", flush=True)
    print("Щоб зупинити сервер, закрийте це вікно або натисніть Ctrl+C.", flush=True)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
