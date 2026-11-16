"""Keep Vercel's file-based routes wired to the tested local API."""

from pathlib import Path
from runpy import run_path
from unittest import TestCase

from func.app import Handler


ROOT = Path(__file__).resolve().parent.parent


class VercelEntrypointTests(TestCase):
    def test_api_routes_export_the_existing_handler(self) -> None:
        for name in ("budget_name", "budget_search", "analyze_stream"):
            with self.subTest(route=name):
                namespace = run_path(str(ROOT / "api" / f"{name}.py"))
                self.assertTrue(issubclass(namespace["handler"], Handler))
