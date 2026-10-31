"""宽任务验收（隐藏判分用；跑完才拷进工作区）。

只做客观判定，不看措辞质量：
  1. 每个模块有模块级 docstring
  2. docs/inventory.md 存在、行数齐、模块名按字典序
"""

import ast
import json
import pathlib
import re

ROOT = pathlib.Path.cwd()  # 驱动以工作区为 cwd 跑本脚本——按文件位置推根目录会找错地方（判分脚本自身误差的头号来源）
MODULES_DIR = ROOT / "src" / "inventory"
INVENTORY = ROOT / "docs" / "inventory.md"

modules = sorted(p for p in MODULES_DIR.glob("*.py") if p.name != "__init__.py")
passed = 0
failed = 0
errors = 0
details: list[str] = []

for path in modules:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        doc = ast.get_docstring(tree)
        if doc and doc.strip():
            passed += 1
        else:
            failed += 1
            details.append(f"缺 docstring: {path.name}")
    except SyntaxError as error:
        errors += 1
        details.append(f"语法错误: {path.name}: {error}")

if not INVENTORY.exists():
    failed += 1
    details.append("缺 docs/inventory.md")
else:
    # 只把 "- " 开头的行当条目：Markdown 标题与说明行是正常写法，不该判成格式错
    raw_lines = INVENTORY.read_text(encoding="utf-8").splitlines()
    lines = [line.strip() for line in raw_lines if line.strip().startswith("- ")]
    names = []
    for line in lines:
        body = line[2:]
        # 半角与全角冒号都认：模型中文输出常写「：」，只认半角会造成假失败
        name = re.split(r"[:：]", body, maxsplit=1)[0]
        names.append(name.strip())
    expected = [p.stem for p in modules]
    if len(lines) != len(expected):
        failed += 1
        details.append(f"条目数 {len(lines)} != 模块数 {len(expected)}")
    if names != sorted(names):
        failed += 1
        details.append("条目未按模块名字典序")
    missing = sorted(set(expected) - set(names))
    if missing:
        failed += 1
        details.append(f"缺 {len(missing)} 个模块，例如 {missing[:3]}")
    extra = sorted(set(names) - set(expected))
    if extra:
        failed += 1
        details.append(f"多出 {len(extra)} 个条目，例如 {extra[:3]}")

print(
    json.dumps(
        {
            "passed": passed,
            "failed": failed,
            "error": errors,
            "modules": len(modules),
            "details": details[:20],
        },
        ensure_ascii=False,
    )
)
