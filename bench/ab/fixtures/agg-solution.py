"""归约题参考解：统计每个 .py 的公开函数数，写 docs/stats.md 表格。

只用于判分器自检（bench/ab/self-check.mjs）。格式与题面 task-prompt-agg.md 一致：
两列表格（模块文件名 | 公开函数数），表尾给合计。
"""

import ast
import pathlib

ROOT = pathlib.Path.cwd()
SRC = ROOT / "src" / "inventory"
DOCS = ROOT / "docs"


def count_public(path: pathlib.Path) -> int:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return sum(
        1
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_")
    )


def main() -> None:
    files = sorted(SRC.glob("*.py"))
    counts = [(p.name, count_public(p)) for p in files]
    DOCS.mkdir(exist_ok=True)
    lines = ["| 模块 | 公开函数数 |", "|---|---|"]
    for name, n in counts:
        lines.append(f"| {name} | {n} |")
    lines.append(f"| **合计** | {sum(n for _, n in counts)} |")
    (DOCS / "stats.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"solved: {len(counts)} files, total {sum(n for _, n in counts)}")


if __name__ == "__main__":
    main()
