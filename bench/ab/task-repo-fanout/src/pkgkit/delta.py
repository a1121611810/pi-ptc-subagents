"""日期处理：解析与加减。"""

from datetime import date, timedelta


def parse_iso_date(text: str) -> date:
    """解析 ISO 日期字符串。"""
    return date.fromisoformat(text)


def add_days(value: date, days: int) -> date:
    """日期加天数。"""
    return value + timedelta(days=days)


def days_between(start: date, end: date) -> int:
    """两个日期相差天数。"""
    return (end - start).days
