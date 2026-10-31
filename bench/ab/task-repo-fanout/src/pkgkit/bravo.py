"""文本清洗：去空白与大小写归一。"""


def strip_spaces(text: str) -> str:
    """去掉首尾空白。"""
    return text.strip()


def collapse_spaces(text: str) -> str:
    """把连续空白压成一个空格。"""
    return " ".join(text.split())


def title_case(text: str) -> str:
    """按空格分词后首字母大写。"""
    return " ".join(word.capitalize() for word in text.split())
