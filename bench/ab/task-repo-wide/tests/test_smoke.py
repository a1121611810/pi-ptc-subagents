"""冒烟测试：确认包能被导入。"""

import importlib

import pytest


@pytest.mark.parametrize(
    "module_name",
    [
        "totals_01",
        "currency_01",
        "dates_01",
        "text_01",
        "collections_01",
        "validation_01",
        "totals_02",
        "currency_02",
        "dates_02",
        "text_02",
        "collections_02",
        "validation_02",
        "totals_03",
        "currency_03",
        "dates_03",
        "text_03",
        "collections_03",
        "validation_03",
        "totals_04",
        "currency_04",
        "dates_04",
        "text_04",
        "collections_04",
        "validation_04",
    ],
)
def test_module_importable(module_name: str) -> None:
    module = importlib.import_module(f"inventory.{module_name}")
    assert module is not None
