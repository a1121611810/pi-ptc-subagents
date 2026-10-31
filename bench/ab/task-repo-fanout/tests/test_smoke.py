"""冒烟测试：确认六个包都能导入。"""

import importlib

import pytest


@pytest.mark.parametrize(
    "module_name",
    [
        "alpha",
        "bravo",
        "charlie",
        "delta",
        "echo",
        "foxtrot",
    ],
)
def test_module_importable(module_name):
    importlib.import_module(f"pkgkit.{module_name}")
