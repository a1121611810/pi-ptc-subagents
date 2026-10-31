"""检查 docs/stats.md 的模块×公开函数数量表是否与真实值一致。

真实值 = src/inventory/*.py 里模块顶层的公开 def（名字不以 _ 开头）。
只认 Markdown 表格行（以 | 开头且能解析出模块名与数字）——标题行、分隔行、合计行一律不算条目。
"""
import ast
import json
import re
from pathlib import Path

ROOT = Path.cwd()
SRC = ROOT / "src" / "inventory"
STATS = ROOT / "docs" / "stats.md"

ROW = re.compile(r"^\|?\s*`?([A-Za-z0-9_.\-]+\.py)`?\s*\|\s*(\d+)\s*\|?\s*$")

def public_functions(path: Path) -> int:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return sum(
        1
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_")
    )


def main() -> None:
    truth = {p.name: public_functions(p) for p in sorted(SRC.glob("*.py"))}
    passed, failed, details = 0, 0, []

    if not STATS.exists():
        print(json.dumps({"passed": 0, "failed": 1, "error": 0, "details": ["缺 docs/stats.md"]}))
        return

    reported = {}
    for line in STATS.read_text(encoding="utf-8").splitlines():
        m = ROW.match(line.strip())
        if m:
            reported[m.group(1)] = int(m.group(2))

    for name, count in truth.items():
        if name not in reported:
            failed += 1
            details.append(f"缺模块 {name}")
        elif reported[name] != count:
            failed += 1
            details.append(f"{name} 数量错：报 {reported[name]}，实 {count}")
        else:
            passed += 1

    for name in reported:
        if name not in truth:
            failed += 1
            details.append(f"多出模块 {name}")

    total = sum(truth.values())
    body = STATS.read_text(encoding="utf-8")
    if not re.search(rf"\b{total}\b", body):
        failed += 1
        details.append(f"合计数 {total} 没出现")

    print(
        json.dumps(
            {"passed": passed, "failed": failed, "error": 0, "details": details, "modules": len(truth)},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
