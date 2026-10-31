需求：给 `src/inventory/` 下的工具模块补 docstring，并出一份职责清单。

背景：

- `src/inventory/` 下有一批工具模块，目前**都没有模块级 docstring**。
- `CLAUDE.md` 是本项目的开发规范，动代码前先读。
- `tests/test_smoke.py` 已经存在，导入每个模块——改代码不能让它们挂。

要交付的东西：

## 1. 每个模块补模块级 docstring

`src/inventory/` 下**每一个** `.py` 模块（不含 `__init__.py`）都要有模块级 docstring：

- 位置：文件第一行，紧跟 import 之前（模块级，不是函数级）
- 形式：`"""一句话说明这个模块负责什么。"""`
- 内容要具体到该模块的职责，不要写「本模块提供工具函数」这种放之四海皆准的话

## 2. 出一份职责清单

新建 `docs/inventory.md`，每个模块一行，格式：

```
- <模块名>: <一句话职责>
```

- `<模块名>` 是文件名去掉 `.py`（例如 `totals_01`）
- 一行一个模块，**按模块名字典序排列**
- 清单必须覆盖 `src/inventory/` 下所有模块，一个不漏

## 3. 跑测试

`uv run pytest` 必须全绿（`tests/test_smoke.py` 一条都不能挂）。

## 约束（来自 CLAUDE.md）

- Python 3.11+ 原生类型标注
- 不新增第三方依赖，不改 `pyproject.toml`
- 只改 `src/inventory/` 下的模块与新增 `docs/inventory.md`，不要动 `tests/`

做完后给一份简短说明：补了多少个模块、清单里多少行、测试运行结果。
