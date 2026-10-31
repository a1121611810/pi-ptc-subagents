"""计价：小计、会员折扣、合计。

优惠券的校验与抵扣见 ordercalc.coupons；本模块负责把校验结果折进合计。
"""

from dataclasses import dataclass
from datetime import date

from .models import CouponRule, Order

MEMBER_DISCOUNT_RATE = 0.05


@dataclass
class PriceBreakdown:
    """一次计价的拆解。"""

    subtotal: float
    member_discount: float
    coupon_discount: float
    total: float
    rejected_coupon: str | None = None


def calculate_subtotal(order: Order) -> float:
    """按明细单价 × 数量求小计。"""
    return round(sum(item.unit_price * item.quantity for item in order.items), 2)


def calculate_total(
    order: Order,
    *,
    member_discount: bool = False,
    coupon: CouponRule | None = None,
    today: date | None = None,
) -> PriceBreakdown:
    """算合计。

    会员折扣先于优惠券生效；coupon 交给 ordercalc.coupons 校验，通过才抵扣，
    不通过则不抵扣并把校验出的 reason 记进 rejected_coupon。today 缺省取当天。
    """
    subtotal = calculate_subtotal(order)
    member_amount = round(subtotal * MEMBER_DISCOUNT_RATE, 2) if member_discount else 0.0
    coupon_amount = 0.0
    rejected: str | None = None
    if coupon is not None:
        # 函数内导入：coupons 依赖本模块的 calculate_subtotal，模块级互相导入会成环
        from .coupons import validate_coupon

        result = validate_coupon(
            coupon,
            order,
            today=today if today is not None else date.today(),
            member_discount=member_discount,
        )
        if result.valid:
            coupon_amount = result.discount
        else:
            rejected = result.reason
    total = round(subtotal - member_amount - coupon_amount, 2)
    return PriceBreakdown(
        subtotal=subtotal,
        member_discount=member_amount,
        coupon_discount=coupon_amount,
        total=total,
        rejected_coupon=rejected,
    )
