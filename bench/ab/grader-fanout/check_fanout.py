"""扇出题验收（隐藏判分用；跑完才拷进工作区）。

只做客观判定，不看措辞质量：
  1. 六个模块各一张接口卡（docs/pkgcards/<模块名>.md）
  2. 每张卡：模块名 / 代码行数 / 职责 / 全部公开函数的参数名
  3. 汇总表 docs/pkgcards/index.md：六行、按字典序、代码行数正确、有合计行

代码行数的口径与题面写死的完全一致：去掉空行 + 去掉整行注释（strip 后以 # 开头），其余都算（含 docstring 行）。
"""

import ast
import json
import pathlib
import re

ROOT = pathlib.Path.cwd()  # 驱动以工作区为 cwd 跑本脚本——按文件位置推根目录会找错地方（判分脚本自身误差的头号来源）
CARDS = ROOT / "docs" / "pkgcards"


def find_modules_dir() -> pathlib.Path | None:
    """包目录自动发现——一份判分器同时服务 pkgkit（6 个包）与 inventory（24 个模块）两题。"""
    for name in ("pkgkit", "inventory"):
        d = ROOT / "src" / name
        if d.is_dir() and any(p.name != "__init__.py" for p in d.glob("*.py")):
            return d
    return None


MODULES_DIR = find_modules_dir()
MODULES = (
    sorted(p.stem for p in MODULES_DIR.glob("*.py") if p.name != "__init__.py")
    if MODULES_DIR
    else []
)

passed = 0
failed = 0
errors = 0
details: list[str] = []


def check(ok: bool, label: str) -> None:
    global passed, failed
    if ok:
        passed += 1
    else:
        failed += 1
        details.append(label)


def code_lines(path: pathlib.Path) -> int:
    """与题面口径一致：去掉空行与整行注释，其余算代码行（含 docstring 行）。"""
    n = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        n += 1
    return n


def public_funcs(path: pathlib.Path) -> list[tuple[str, list[str]]]:
    """模块顶层、不以 _ 开头的 def；类不算函数。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: list[tuple[str, list[str]]] = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and not node.name.startswith("_"):
            args = [a.arg for a in node.args.posonlyargs + node.args.args + node.args.kwonlyargs]
            out.append((node.name, args))
    return out


def field(text: str, name: str) -> str | None:
    """取 `- 字段名：值` 里的值；容忍全角/半角冒号与空行。"""
    m = re.search(rf"^[-*]\s*{re.escape(name)}\s*[:：]\s*(.+)$", text, re.M)
    return m.group(1).strip() if m else None


def split_params(cell: str) -> list[str]:
    return [p.strip() for p in re.split(r"[,，、]", cell) if p.strip()]


def table_rows(text: str) -> list[list[str]]:
    """Markdown 表格的数据行（跳过表头与分隔行）。"""
    rows: list[list[str]] = []
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if not cells or all(set(c) <= set("-: ") for c in cells):
            continue
        rows.append(cells)
    return rows


if not MODULES_DIR:
    errors += 1
    details.append("找不到包目录（src/pkgkit 或 src/inventory）")

for name in MODULES:
    src = MODULES_DIR / f"{name}.py"
    card = CARDS / f"{name}.md"
    if not src.exists():
        errors += 1
        details.append(f"{name}: 源模块不存在")
        continue
    if not card.exists():
        failed += 1
        details.append(f"{name}: 接口卡不存在")
        continue
    text = card.read_text(encoding="utf-8")

    check(field(text, "模块名") == name, f"{name}: 模块名字段不对")

    loc_text = field(text, "代码行数")
    expected_loc = code_lines(src)
    check(
        loc_text is not None and loc_text.strip() == str(expected_loc),
        f"{name}: 代码行数应为 {expected_loc}，实际 {loc_text!r}",
    )

    duty = field(text, "职责")
    check(bool(duty and duty.strip()), f"{name}: 职责字段缺失或为空")

    rows = table_rows(text)
    for fn_name, params in public_funcs(src):
        hit = None
        for cells in rows:
            if cells and cells[0].strip() == fn_name:
                hit = cells
                break
        if hit is None:
            check(False, f"{name}: 函数表缺 {fn_name}")
            continue
        got = set(split_params(hit[1] if len(hit) > 1 else ""))
        check(got == set(params), f"{name}: {fn_name} 参数名应为 {params}，实际 {sorted(got)}")

index = CARDS / "index.md"
if not index.exists():
    failed += 1
    details.append("index.md 不存在")
else:
    text = index.read_text(encoding="utf-8")
    rows = table_rows(text)
    data = [r for r in rows if r and r[0].strip() not in {"模块名", "**合计**", "合计"}]
    names = [r[0].strip() for r in data]
    check(names == sorted(MODULES), f"index.md 模块名应按字典序且齐全：实际 {names}")
    total = 0
    for r in data:
        if not r:
            continue
        name = r[0].strip()
        src = MODULES_DIR / f"{name}.py"
        if not src.exists():
            continue
        expect = code_lines(src)
        try:
            got = int(re.sub(r"[^\d]", "", r[2] if len(r) > 2 else ""))
        except ValueError:
            got = -1
        check(got == expect, f"index.md: {name} 代码行数应为 {expect}，实际 {got}")
        total += expect
    total_rows = [r for r in rows if r and r[0].strip().replace("*", "") == "合计"]
    check(len(total_rows) == 1, "index.md 应有且只有一行合计")
    if total_rows:
        try:
            got = int(re.sub(r"[^\d]", "", total_rows[0][2] if len(total_rows[0]) > 2 else ""))
        except ValueError:
            got = -1
        check(got == total, f"index.md: 合计应为 {total}，实际 {got}")

print(
    json.dumps(
        {"passed": passed, "failed": failed, "error": errors, "details": details},
        ensure_ascii=False,
    )
)
