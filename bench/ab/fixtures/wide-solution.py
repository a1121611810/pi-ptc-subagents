"""宽题参考解：给每个模块加模块级 docstring + 写 docs/inventory.md 清单。

只用于判分器自检（bench/ab/self-check.mjs），不是模型可见物。
格式必须与题面 task-prompt-wide.md 一致：`- <模块名>: <一句话职责>`，按字典序。
"""

import pathlib

ROOT = pathlib.Path.cwd()
SRC = ROOT / "src" / "inventory"
DOCS = ROOT / "docs"


def module_summary(path: pathlib.Path) -> str:
    """从模块里的函数名拼一句职责（自检用，不需要多漂亮）。"""
    names = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("def ") and not line.startswith("def _"):
            names.append(line[4:].split("(")[0])
    return "提供 " + "、".join(names[:3]) + " 等函数"


def main() -> None:
    modules = sorted(p for p in SRC.glob("*.py") if p.name != "__init__.py")
    for path in modules:
        text = path.read_text(encoding="utf-8")
        if not text.lstrip().startswith('"""'):
            path.write_text(f'"""{module_summary(path)}。"""\n\n' + text, encoding="utf-8")
    DOCS.mkdir(exist_ok=True)
    lines = ["# 职责清单", ""]
    for path in modules:
        lines.append(f"- {path.stem}: {module_summary(path)}")
    (DOCS / "inventory.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"solved: {len(modules)} modules")


if __name__ == "__main__":
    main()
