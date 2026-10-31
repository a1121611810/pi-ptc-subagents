"""验收测试（隐藏判分用；跑完才拷进工作区）。

按 task-prompt.md 里写死的 API 调用。判分口径只有这一份，避免「判分脚本自己出错」。
"""

from datetime import date

import pytest

from ordercalc.coupons import CouponResult, validate_coupon
from ordercalc.models import CouponRule, LineItem, Order
from ordercalc.pricing import calculate_total

TODAY = date(2026, 6, 15)


def make_order(unit_price: float = 100.0, quantity: int = 2) -> Order:
    return Order(
        order_id="o-1",
        customer_id="c-1",
        items=[LineItem(sku="sku-1", unit_price=unit_price, quantity=quantity)],
    )


def make_rule(**overrides) -> CouponRule:
    base = {
        "code": "SAVE10",
        "kind": "percent",
        "value": 10.0,
        "valid_from": "2026-01-01",
        "valid_to": "2026-12-31",
    }
    base.update(overrides)
    return CouponRule(**base)


def test_valid_percent_coupon() -> None:
    result = validate_coupon(make_rule(), make_order(), today=TODAY)
    assert isinstance(result, CouponResult)
    assert result.valid is True
    assert result.reason is None
    assert result.discount == 20.0


def test_valid_fixed_coupon() -> None:
    result = validate_coupon(
        make_rule(kind="fixed", value=50.0), make_order(), today=TODAY
    )
    assert result.valid is True
    assert result.discount == 50.0


def test_fixed_coupon_capped_by_subtotal() -> None:
    result = validate_coupon(
        make_rule(kind="fixed", value=9999.0), make_order(), today=TODAY
    )
    assert result.valid is True
    assert result.discount == 200.0


def test_invalid_format() -> None:
    result = validate_coupon(make_rule(code="bad code!"), make_order(), today=TODAY)
    assert result.valid is False
    assert result.reason == "invalid_format"
    assert result.discount == 0.0


def test_expired() -> None:
    result = validate_coupon(
        make_rule(valid_to="2026-01-31"), make_order(), today=TODAY
    )
    assert result.valid is False
    assert result.reason == "expired"


def test_not_yet_valid() -> None:
    result = validate_coupon(
        make_rule(valid_from="2026-12-01"), make_order(), today=TODAY
    )
    assert result.valid is False
    assert result.reason == "not_yet_valid"


def test_below_min_subtotal() -> None:
    result = validate_coupon(
        make_rule(min_subtotal=500.0), make_order(), today=TODAY
    )
    assert result.valid is False
    assert result.reason == "below_min_subtotal"


def test_not_stackable_with_member_discount() -> None:
    result = validate_coupon(
        make_rule(stackable=False), make_order(), today=TODAY, member_discount=True
    )
    assert result.valid is False
    assert result.reason == "not_stackable"


def test_stackable_ok_with_member_discount() -> None:
    result = validate_coupon(
        make_rule(stackable=True), make_order(), today=TODAY, member_discount=True
    )
    assert result.valid is True


def test_unknown_kind() -> None:
    result = validate_coupon(make_rule(kind="bogo"), make_order(), today=TODAY)
    assert result.valid is False
    assert result.reason == "unknown_kind"


def test_conflict_order_expired_wins_over_min_subtotal() -> None:
    """同时过期且不达门槛：先命中的 reason 优先（有效期在门槛之前）。"""
    result = validate_coupon(
        make_rule(valid_to="2026-01-31", min_subtotal=5000.0),
        make_order(),
        today=TODAY,
    )
    assert result.reason == "expired"


def test_total_applies_valid_coupon() -> None:
    breakdown = calculate_total(make_order(), coupon=make_rule())
    assert breakdown.coupon_discount == 20.0
    assert breakdown.rejected_coupon is None
    assert breakdown.total == 180.0


def test_total_rejects_invalid_coupon() -> None:
    breakdown = calculate_total(make_order(), coupon=make_rule(code="x"))
    assert breakdown.coupon_discount == 0.0
    assert breakdown.rejected_coupon == "invalid_format"
    assert breakdown.total == 200.0


def test_total_coupon_with_member_discount() -> None:
    breakdown = calculate_total(
        make_order(), member_discount=True, coupon=make_rule(stackable=True)
    )
    assert breakdown.member_discount == 10.0
    assert breakdown.coupon_discount == 20.0
    assert breakdown.total == 170.0
