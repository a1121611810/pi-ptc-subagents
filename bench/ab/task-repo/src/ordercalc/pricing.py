"""计价：小计、会员折扣、合计。

优惠券的校验与抵扣见 ordercalc.coupons；本模块负责把校验结果折进合计。
"""

from dataclasses import dataclass

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
) -> PriceBreakdown:
    """算合计。

    会员折扣先于优惠券生效；coupon 目前只接受规则，抵扣与否由 ordercalc.coupons 的校验结果决定。
    """
    subtotal = calculate_subtotal(order)
    member_amount = round(subtotal * MEMBER_DISCOUNT_RATE, 2) if member_discount else 0.0
    coupon_amount = 0.0
    rejected: str | None = None
    if coupon is not None:
        # TODO(ordercalc.coupons): 接入优惠券校验后再决定是否抵扣
        rejected = "not_validated"
    total = round(subtotal - member_amount - coupon_amount, 2)
    return PriceBreakdown(
        subtotal=subtotal,
        member_discount=member_amount,
        coupon_discount=coupon_amount,
        total=total,
        rejected_coupon=rejected,
    )
