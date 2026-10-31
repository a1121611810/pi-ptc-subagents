"""现有计价的回归测试。新功能别动这里。"""

import pytest

from ordercalc.models import LineItem, Order
from ordercalc.pricing import calculate_subtotal, calculate_total


def make_order(unit_price: float = 100.0, quantity: int = 2) -> Order:
    return Order(
        order_id="o-1",
        customer_id="c-1",
        items=[LineItem(sku="sku-1", unit_price=unit_price, quantity=quantity)],
    )


def test_subtotal_is_unit_price_times_quantity() -> None:
    assert calculate_subtotal(make_order(100.0, 2)) == 200.0


def test_total_without_discounts() -> None:
    breakdown = calculate_total(make_order())
    assert breakdown.subtotal == 200.0
    assert breakdown.member_discount == 0.0
    assert breakdown.coupon_discount == 0.0
    assert breakdown.total == 200.0


def test_member_discount_applies() -> None:
    breakdown = calculate_total(make_order(), member_discount=True)
    assert breakdown.member_discount == 10.0
    assert breakdown.total == 190.0


@pytest.mark.parametrize(
    ("price", "quantity", "expected"),
    [(10.0, 1, 10.0), (2.5, 4, 10.0), (0.5, 3, 1.5)],
)
def test_subtotal_variants(price: float, quantity: int, expected: float) -> None:
    assert calculate_subtotal(make_order(price, quantity)) == expected
