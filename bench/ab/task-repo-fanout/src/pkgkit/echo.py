"""集合处理：分块、去重、分组。"""


def chunked(values: list[int], size: int) -> list[list[int]]:
    """把列表按固定大小切块。"""
    return [values[i : i + size] for i in range(0, len(values), size)]


def dedupe(values: list[int]) -> list[int]:
    """去重并保持首次出现顺序。"""
    seen: set[int] = set()
    out: list[int] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            out.append(value)
    return out


def group_by(values: list[int], key: str) -> dict[str, list[int]]:
    """按奇偶分组。"""
    out: dict[str, list[int]] = {"even": [], "odd": []}
    for value in values:
        out["even" if value % 2 == 0 else "odd"].append(value)
    return out
