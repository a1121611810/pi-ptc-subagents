"""金额换算：分与元互转。"""


def to_cents(amount: float) -> int:
    """元转分，四舍五入到整分。"""
    return round(amount * 100)


def from_cents(cents: int) -> float:
    """分转元。"""
    return cents / 100


def format_amount(cents: int) -> str:
    """把分格式化成带两位小数的元。"""
    return f"{cents / 100:.2f}"
