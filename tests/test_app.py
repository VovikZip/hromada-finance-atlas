import unittest
import json
import threading
from datetime import date
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import quote
from urllib.request import Request, urlopen

from func.app import Handler, validate_request
from func.hromada_atlas import DataError


class AppValidationTests(unittest.TestCase):
    def test_basic_budget_request(self):
        result = validate_request({'budget_code': '2357400000', 'year': 2026})
        self.assertEqual(result, ('2357400000', 2026, [], None, None))

    def test_spending_request(self):
        result = validate_request({
            'budget_code': '2357400000', 'year': 2026,
            'payer_edrpous': ['04061613'],
            'transactions_start': '2026-10-01', 'transactions_end': '2026-10-31',
        })
        self.assertEqual(result[2:], (['04061613'], date(2026, 10, 1), date(2026, 10, 31)))

    def test_invalid_code(self):
        with self.assertRaises(ValueError):
            validate_request({'budget_code': '235740000', 'year': 2026})

    def test_spending_range_must_match_year(self):
        with self.assertRaises(ValueError):
            validate_request({
                'budget_code': '2357400000', 'year': 2026,
                'payer_edrpous': ['04061613'],
                'transactions_start': '2025-12-01', 'transactions_end': '2025-12-31',
            })

    def test_analyze_endpoint_returns_report(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            request = Request(
                f'http://127.0.0.1:{server.server_address[1]}/api/analyze',
                data=json.dumps({'budget_code': '2357400000', 'year': 2026}).encode(),
                headers={'Content-Type': 'application/json'},
            )
            with patch('func.app.build_report', return_value={'budget_code': '2357400000', 'monthly': []}) as analysis:
                with urlopen(request) as response:
                    result = json.load(response)
            self.assertEqual(result['report']['budget_code'], '2357400000')
            analysis.assert_called_once_with('2357400000', 2026, [], None, None)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)

    def test_stream_endpoint_reports_real_steps_and_result(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            def analysis(*args, progress):
                self.assertEqual(args, ('2357400000', 2026, [], None, None))
                progress('incomes', 'Отримуємо доходи')
                progress('economic', 'Отримуємо видатки')
                return {'budget_code': '2357400000', 'monthly': []}

            request = Request(
                f'http://127.0.0.1:{server.server_address[1]}/api/analyze-stream',
                data=json.dumps({'budget_code': '2357400000', 'year': 2026}).encode(),
                headers={'Content-Type': 'application/json'},
            )
            with patch('func.app.build_report', side_effect=analysis):
                with urlopen(request) as response:
                    self.assertEqual(response.headers.get_content_type(), 'application/x-ndjson')
                    events = [json.loads(line) for line in response]
            self.assertEqual([event['type'] for event in events], ['progress', 'progress', 'result'])
            self.assertEqual(events[0]['step'], 'incomes')
            self.assertEqual(events[-1]['report']['budget_code'], '2357400000')
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)

    def test_stream_endpoint_reports_source_error(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            request = Request(
                f'http://127.0.0.1:{server.server_address[1]}/api/analyze-stream',
                data=json.dumps({'budget_code': '2357400000', 'year': 2026}).encode(),
                headers={'Content-Type': 'application/json'},
            )
            with patch('func.app.build_report', side_effect=DataError('OpenBudget недоступний')):
                with urlopen(request) as response:
                    events = [json.loads(line) for line in response]
            self.assertEqual(events, [{'type': 'error', 'message': 'OpenBudget недоступний'}])
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)

    def test_budget_name_endpoint_returns_official_identity(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with patch('func.app.budget_identity', return_value={
                'budget_name': 'Бюджет Уманської міської територіальної громади',
                'directory_url': 'https://api.openbudget.gov.ua/items/BUDG',
                'directory_date': '2026-11-15',
            }) as lookup:
                with urlopen(f'http://127.0.0.1:{server.server_address[1]}/api/budget-name?code=2357400000') as response:
                    result = json.load(response)
            self.assertEqual(result['budget_name'], 'Бюджет Уманської міської територіальної громади')
            lookup.assert_called_once_with('2357400000')
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)

    def test_budget_search_endpoint_returns_official_candidates(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            candidate = {
                'budget_code': '2357400000',
                'budget_name': 'Бюджет Уманської міської територіальної громади',
                'local_government_name': 'Уманська міська рада',
                'directory_url': 'https://api.openbudget.gov.ua/items/BUDG',
                'directory_date': '2026-11-16',
            }
            with patch('func.app.search_budgets', return_value=[candidate]) as search:
                with urlopen(f'http://127.0.0.1:{server.server_address[1]}/api/budget-search?q={quote("Умань")}') as response:
                    result = json.load(response)
            self.assertEqual(result['results'][0]['budget_code'], '2357400000')
            search.assert_called_once_with('Умань')
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
