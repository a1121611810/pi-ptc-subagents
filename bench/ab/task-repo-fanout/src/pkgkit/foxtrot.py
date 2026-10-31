"""数值汇总：求和、均值、中位数。"""


def sum_values(values: list[int]) -> int:
    """求和。"""
    return sum(values)


def mean_value(values: list[int]) -> float:
    """算术平均。"""
    return sum(values) / len(values) if values else 0.0


def median_value(values: list[int]) -> float:
    """中位数。"""
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return float(ordered[mid])
    return (ordered[mid - 1] + ordered[mid]) / 2
