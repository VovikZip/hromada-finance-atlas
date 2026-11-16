import unittest
from decimal import Decimal
from unittest.mock import patch

from func.hromada_atlas import (
    DataError, INCOME_GROUPS, build_report, cumulative_index, decode_csv, month_of, monthly_details,
    total_by_month, validate_funds,
)


class BudgetTests(unittest.TestCase):
    def test_csv_quoted_semicolon_and_cyrillic(self):
        data = ('REP_PERIOD;FUND_TYP;COD_BUDGET;COD_INCO;NAME_INC;FAKT_AMT\n'
                '01.2026;T;2357400000;18030100;"Туристичний; збір";12.50\n')
        rows = decode_csv(data.encode('utf-8-sig'))
        self.assertEqual(rows[0]['NAME_INC'], 'Туристичний; збір')

    def test_cumulative_monthly_and_funds(self):
        rows = [
            {'REP_PERIOD': period, 'FUND_TYP': fund, 'COD_BUDGET': '2357400000',
             'COD_INCO': '18030100', 'NAME_INC': 'Туристичний збір', 'FAKT_AMT': actual}
            for period, fund, actual in [
                ('01.2026', 'T', '100'), ('01.2026', 'C', '80'), ('01.2026', 'S', '20'),
                ('02.2026', 'T', '150'), ('02.2026', 'C', '120'), ('02.2026', 'S', '30'),
            ]
        ]
        index, names = cumulative_index(rows, 2026, '2357400000', 'COD_INCO', 'NAME_INC')
        details, warnings = monthly_details(index, names, 2026, group_names=INCOME_GROUPS, group_width=1)
        self.assertEqual(warnings, [])
        self.assertEqual(details[0]['group'], 'Податкові надходження')
        self.assertEqual(validate_funds(index, 'Доходи'), [])
        self.assertEqual(total_by_month(details), {'2026-01': Decimal('100'), '2026-02': Decimal('50')})

    def test_missing_previous_month_not_zero(self):
        index = {('2026-02', 'T', '2111'): Decimal('150')}
        details, warnings = monthly_details(index, {'2111': 'Зарплата'}, 2026, group_names={}, group_width=1)
        self.assertEqual(details, [])
        self.assertTrue(warnings)

    def test_disappearing_code_is_flagged(self):
        index = {
            ('2026-01', 'T', '2111'): Decimal('100'),
            ('2026-02', 'T', '2210'): Decimal('20'),
        }
        details, warnings = monthly_details(index, {}, 2026, group_names={}, group_width=1)
        self.assertEqual(total_by_month(details)['2026-02'], Decimal('20'))
        self.assertTrue(any('2111' in warning and 'відсутній' in warning for warning in warnings))

    def test_program_aggregate_only(self):
        rows = [
            {'REP_PERIOD': '01.2026', 'FUND_TYP': 'T', 'COD_BUDGET': '2357400000',
             'COD_CONS_MB_PK': '1010', 'COD_CONS_MB_PK_NAME': 'Програма',
             'COD_CONS_EK': code, 'FAKT_AMT': actual}
            for code, actual in [('0000', '100'), ('2111', '60'), ('2210', '40')]
        ]
        index, _ = cumulative_index(rows, 2026, '2357400000', 'COD_CONS_MB_PK',
                                    'COD_CONS_MB_PK_NAME', aggregate_program=True)
        self.assertEqual(index[('2026-01', 'T', '1010')], Decimal('100'))

    def test_bad_period(self):
        with self.assertRaises(DataError):
            month_of('13.2026', 2026)

    def test_income_classification_group(self):
        self.assertEqual(INCOME_GROUPS['1'], 'Податкові надходження')
        self.assertEqual(INCOME_GROUPS['2'], 'Неподаткові надходження')
        self.assertEqual(INCOME_GROUPS['4'], 'Офіційні трансферти')

    def test_monthly_difference_is_not_cash_balance(self):
        base = {'REP_PERIOD': '01.2026', 'COD_BUDGET': '2357400000'}
        incomes = [dict(base, FUND_TYP=fund, COD_INCO='18030100', NAME_INC='Туристичний збір', FAKT_AMT=value)
                   for fund, value in [('T', '100'), ('C', '100')]]
        expenses = [dict(base, FUND_TYP=fund, COD_CONS_EK='2111', COD_CONS_EK_NAME='Зарплата', FAKT_AMT=value)
                    for fund, value in [('T', '60'), ('C', '60')]]
        programs = [dict(base, FUND_TYP=fund, COD_CONS_MB_PK='1010', COD_CONS_MB_PK_NAME='Програма',
                         COD_CONS_EK='0000', FAKT_AMT=value)
                    for fund, value in [('T', '60'), ('C', '60')]]
        steps = []
        with patch('func.hromada_atlas.budget_identity', return_value={
            'budget_name': 'Бюджет Уманської міської територіальної громади',
            'local_government_name': 'Уманська міська рада',
            'katottg': 'UA71060210000032972',
            'directory_url': 'https://api.openbudget.gov.ua/items/BUDG?dateFrom=2026-11-15',
            'directory_date': '2026-11-15',
        }), patch('func.hromada_atlas.budget_csv', side_effect=[
            (incomes, 'income-url'), (expenses, 'expense-url'), (programs, 'program-url')
        ]):
            report = build_report('2357400000', 2026, [], None, None,
                                  progress=lambda step, message: steps.append(step))
        self.assertEqual(report['monthly'][0]['income_minus_expense_uah'], Decimal('40'))
        self.assertEqual(report['budget_name'], 'Бюджет Уманської міської територіальної громади')
        self.assertEqual(report['sources']['openbudget_directory_date'], '2026-11-15')
        self.assertEqual(steps, ['incomes', 'economic', 'programs', 'calculation', 'identity', 'finish'])


if __name__ == '__main__':
    unittest.main()
