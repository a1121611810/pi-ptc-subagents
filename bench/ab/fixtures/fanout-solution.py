"""扇出题参考答案：按题面口径生成各包接口卡 + 汇总表（判分器自检的正例用）。

包目录自动发现（src/pkgkit 或 src/inventory）——一份解法服务 6 包与 24 包两题。
"""

import ast
import pathlib

ROOT = pathlib.Path.cwd()
CARDS = ROOT / "docs" / "pkgcards"


def find_modules_dir():
    for name in ("pkgkit", "inventory"):
        d = ROOT / "src" / name
        if d.is_dir() and any(p.name != "__init__.py" for p in d.glob("*.py")):
            return d
    return None


def code_lines(path: pathlib.Path) -> int:
    n = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        n += 1
    return n


def public_funcs(path: pathlib.Path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and not node.name.startswith("_"):
            args = [a.arg for a in node.args.posonlyargs + node.args.args + node.args.kwonlyargs]
            out.append((node.name, args))
    return out


modules_dir = find_modules_dir()
if modules_dir is None:
    raise SystemExit("找不到包目录（src/pkgkit 或 src/inventory）")
MODULES = sorted(p.stem for p in modules_dir.glob("*.py") if p.name != "__init__.py")

CARDS.mkdir(parents=True, exist_ok=True)
total = 0
rows = []
for name in MODULES:
    src = modules_dir / f"{name}.py"
    loc = code_lines(src)
    total += loc
    duty = f"{name} 模块的工具函数集合。"
    lines = [
        f"# {name}",
        "",
        f"- 模块名：{name}",
        f"- 代码行数：{loc}",
        f"- 职责：{duty}",
        "",
        "| 函数名 | 参数名 |",
        "| --- | --- |",
    ]
    for fn_name, params in public_funcs(src):
        lines.append(f"| {fn_name} | {', '.join(params)} |")
    (CARDS / f"{name}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    rows.append(f"| {name} | {duty} | {loc} |")

index = [
    "| 模块名 | 职责 | 代码行数 |",
    "| --- | --- | --- |",
    *rows,
    f"| **合计** |  | {total} |",
]
(CARDS / "index.md").write_text("\n".join(index) + "\n", encoding="utf-8")
print(f"[fanout-solution] {len(MODULES)} 张卡 + 汇总表已生成，合计 {total} 行")
