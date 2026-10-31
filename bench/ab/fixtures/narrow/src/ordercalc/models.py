"""数据形状：订单、明细、优惠券规则。全部用 dataclass 表达。"""

from dataclasses import dataclass, field


@dataclass
class LineItem:
    """订单里的一条明细。"""

    sku: str
    unit_price: float
    quantity: int


@dataclass
class Order:
    """一张订单。"""

    order_id: str
    customer_id: str
    items: list[LineItem] = field(default_factory=list)
    currency: str = "CNY"


@dataclass
class CouponRule:
    """一张优惠券的规则。校验逻辑见 ordercalc.coupons。"""

    code: str
    kind: str
    value: float
    valid_from: str
    valid_to: str
    min_subtotal: float = 0.0
    stackable: bool = False
