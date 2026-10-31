"""优惠券校验与抵扣计算：券码格式 → 有效期 → 门槛 → 叠加 → 券种，按顺序先命中先返回。"""

import logging
import re
from dataclasses import dataclass
from datetime import date, datetime

from .models import CouponRule, Order
from .pricing import calculate_subtotal

logger = logging.getLogger(__name__)

COUPON_CODE_PATTERN = re.compile(r"^[A-Z0-9-]{4,16}$")
PERCENT_KIND = "percent"
FIXED_KIND = "fixed"


@dataclass
class CouponResult:
    """一次优惠券校验的结果。

    valid 为 False 时 reason 是失败原因、discount 恒为 0.0；
    valid 为 True 时 reason 为 None、discount 是可抵扣金额。
    """

    valid: bool
    reason: str | None
    discount: float


def validate_coupon(
    rule: CouponRule,
    order: Order,
    *,
    today: date,
    member_discount: bool = False,
) -> CouponResult:
    """校验优惠券并算出抵扣金额。

    按「券码格式 → 有效期 → 门槛 → 叠加 → 券种」的顺序判定，先命中先返回 reason；
    全部通过时 valid=True、reason=None、discount 为抵扣金额，否则 valid=False、discount=0.0。
    """
    if not isinstance(rule.code, str) or not COUPON_CODE_PATTERN.fullmatch(rule.code):
        logger.debug("coupon rejected: invalid_format, code=%r", rule.code)
        return CouponResult(valid=False, reason="invalid_format", discount=0.0)

    valid_from = _parse_date(rule.valid_from)
    valid_to = _parse_date(rule.valid_to)
    if valid_from is None or valid_to is None:
        # 有效期读不出来就按不通过处理：起始日缺失视为尚未生效，结束日缺失视为已过期
        logger.warning(
            "coupon %s has unreadable validity window: valid_from=%r valid_to=%r",
            rule.code,
            rule.valid_from,
            rule.valid_to,
        )
        reason = "not_yet_valid" if valid_from is None else "expired"
        return CouponResult(valid=False, reason=reason, discount=0.0)

    current = _parse_date(today) or date.today()
    if current < valid_from:
        logger.debug(
            "coupon %s rejected: not_yet_valid, today=%s valid_from=%s",
            rule.code,
            current,
            valid_from,
        )
        return CouponResult(valid=False, reason="not_yet_valid", discount=0.0)
    if current > valid_to:
        logger.debug(
            "coupon %s rejected: expired, today=%s valid_to=%s",
            rule.code,
            current,
            valid_to,
        )
        return CouponResult(valid=False, reason="expired", discount=0.0)

    subtotal = calculate_subtotal(order)
    if subtotal < rule.min_subtotal:
        logger.debug(
            "coupon %s rejected: below_min_subtotal, subtotal=%s min_subtotal=%s",
            rule.code,
            subtotal,
            rule.min_subtotal,
        )
        return CouponResult(valid=False, reason="below_min_subtotal", discount=0.0)

    if member_discount and not rule.stackable:
        logger.debug("coupon %s rejected: not_stackable", rule.code)
        return CouponResult(valid=False, reason="not_stackable", discount=0.0)

    if rule.kind == PERCENT_KIND:
        discount = round(subtotal * rule.value / 100, 2)
    elif rule.kind == FIXED_KIND:
        discount = round(min(rule.value, subtotal), 2)
    else:
        logger.debug("coupon %s rejected: unknown_kind, kind=%r", rule.code, rule.kind)
        return CouponResult(valid=False, reason="unknown_kind", discount=0.0)

    logger.info(
        "coupon %s accepted: kind=%s subtotal=%s discount=%s",
        rule.code,
        rule.kind,
        subtotal,
        discount,
    )
    return CouponResult(valid=True, reason=None, discount=discount)


def _parse_date(value: object) -> date | None:
    """把 date / ISO 日期字符串解析成 date；解析不了就返回 None。"""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        text = value.strip()
        try:
            return date.fromisoformat(text)
        except ValueError:
            try:
                return datetime.strptime(text, "%Y/%m/%d").date()
            except ValueError:
                return None
    return None
