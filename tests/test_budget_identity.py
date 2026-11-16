import unittest
from datetime import date
from unittest.mock import patch

from func.budget_identity import BudgetDirectoryError, parse_budget_directory, search_budgets


class BudgetIdentityTests(unittest.TestCase):
    def test_chooses_budget_record_not_subordinate_settlement(self):
        records = [
            {'codebudg': '2357400000', 'namebudg': 'Бюджет громади', 'cntBudg': 1,
             'nameLocalGov': 'Міська рада', 'katottg': 'UA123', 'endDate': None},
            {'codebudg': '2357400000', 'namebudg': 'Бюджет громади', 'cntBudg': 0,
             'nameLocalGov': 'Міська рада', 'katottg': 'UA456', 'endDate': None},
            {'codebudg': '2357600000', 'namebudg': 'Історичний бюджет', 'cntBudg': 1,
             'endDate': '2023-12-31'},
        ]
        result = parse_budget_directory(records)
        self.assertEqual(result['2357400000']['katottg'], 'UA123')
        self.assertNotIn('2357600000', result)

    def test_rejects_empty_or_malformed_directory(self):
        with self.assertRaises(BudgetDirectoryError):
            parse_budget_directory([])
        with self.assertRaises(BudgetDirectoryError):
            parse_budget_directory({'codebudg': '2357400000'})

    def test_conflicting_names_do_not_hide_other_budgets(self):
        records = [
            {'codebudg': '2357400000', 'namebudg': 'Назва А', 'cntBudg': 1, 'endDate': None},
            {'codebudg': '2357400000', 'namebudg': 'Назва Б', 'cntBudg': 1, 'endDate': None},
            {'codebudg': '2357600000', 'namebudg': 'Бюджет Черкас', 'cntBudg': 1, 'endDate': None},
        ]
        result = parse_budget_directory(records)
        self.assertNotIn('2357400000', result)
        self.assertEqual(result['2357600000']['budget_name'], 'Бюджет Черкас')

    def test_search_finds_uman_by_city_and_council_form(self):
        budgets = {
            '2357400000': {
                'budget_name': 'Бюджет Уманської міської територіальної громади',
                'local_government_name': 'Уманська міська рада', 'katottg': 'UA71060210000032972',
            },
            '2357600000': {
                'budget_name': 'Бюджет Черкаської міської територіальної громади',
                'local_government_name': 'Черкаська міська рада', 'katottg': 'UA000',
            },
        }
        with patch('func.budget_identity.current_budget_directory', return_value=(budgets, date(2026, 11, 16))):
            for query in ('Умань', 'Уманська міська громада'):
                results = search_budgets(query)
                self.assertEqual([item['budget_code'] for item in results], ['2357400000'])
                self.assertEqual(results[0]['directory_date'], '2026-11-16')
            with self.assertRaises(ValueError):
                search_budgets('громада')


if __name__ == '__main__':
    unittest.main()
