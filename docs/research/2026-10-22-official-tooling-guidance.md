# 官方口径：oxlint / oxfmt / vitest 各自对「谁管什么」的官方说法

> 调研日期：2026-10-22。回答 wayfinder 票 #265：**oxlint / oxfmt / vitest 官方对「各自管什么」的说法是什么？官方有没有给出跨工具的优先顺序（一个关注点几个工具都能判时，谁先说）？**
> 方法：一手官方文档逐页取证。先取两家官方的**全量文档索引**（`oxc.rs/llms.txt`、`vitest.dev/llms.txt`），把索引里的每个 `.md` 正文拉下来本地 grep，再对命中的页面逐段读原文。每条断言后面给**实际打开过的 URL**。
> 边界：**只给事实，不替 map 做决定**（票面原话）。本笔记新增这一个文件，不改任何既有文件。
> 仓库快照：`pi-ptc-subagents` HEAD `60078a9`（`feat/routing-engineering`）。本笔记不引用仓库实测数字作为「官方口径」，只在 §5 用来核对仓库已有转述。

## 0. 结论速查

| #   | 问题                                            | 结论                                                                                                                                                                                                                       | 出处                                  |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | 有没有官方跨工具判定顺序？                      | **没有。** 三家官方都没写过「一个关注点几个工具都能判时谁先说」。oxc 给的是**领域边界**，vitest 更是完全不提 oxlint/oxfmt（oxc 文档站 + 15 篇 blog 全扫）                                                                  | §4                                    |
| 2   | 那官方有没有给过任何顺序？                      | **有两条，但都不是本仓要的那条**：① oxlint → ESLint（迁移期，两个 linter 谁先跑）；② `oxlint --fix` → `oxfmt`（agent 编辑回路的**执行顺序**）。**两条都不提 vitest**                                                       | §4.2                                  |
| 3   | oxlint 的类别默认是什么？                       | 默认只开 `correctness`；官方类别共 **7 个**（`correctness` `suspicious` `pedantic` `perf` `style` `restriction` `nursery`），其余默认关                                                                                    | §2.1.1                                |
| 4   | 「style/formatting 归 formatter」是官方说法吗？ | **不是。** 官方把 `style` 定义为 **oxlint 自己的类别**（默认关）。oxfmt 侧的官方线只说「styling 类 lint 规则会与 formatter 冲突 ⇒ 在 linter 里关掉」，说的是**冲突**不是**归属**                                           | §2.1.2 / §2.2.3（并见 §5 的转述核对） |
| 5   | 覆盖率阈值官方推荐开吗？                        | **不推荐，也没默认。** 四个指标在 config reference 里**没有 Default 行**，coverage guide 全文不提 thresholds，`coverage.enabled` 默认 `false`                                                                              | §2.3.2                                |
| 6   | 条件断言归谁（对着本仓 F2）？                   | **两家都开口了**：vitest 提供运行时机制 `expect.assertions` / `expect.hasAssertions`；oxlint 的 `vitest` 插件把「条件里的 expect」定为 **correctness**（默认开），把「要求写 `expect.assertions`」定为 **style**（默认关） | §2.1.3 / §2.3.1                       |
| 7   | oxlint 的 `vitest` 插件默认开吗？               | **默认关**（15 个插件里默认开 4 个：`eslint` `typescript` `unicorn` `oxc`）                                                                                                                                                | §2.1.4                                |
| 8   | `reportUnusedDisableDirectives` 默认值？        | 官方明确：**默认关**（"Reporting unused ignore comments is disabled by default."）                                                                                                                                         | §2.1.5                                |

---

## 1. 方法

### 1.1 取证范围

两家官网都是 VitePress，都给每个页面挂 `rel="alternate" type="text/markdown"` 的 `.md` 正文。本笔记抓的是 `.md` 正文（个别页面先抓 HTML 再抓 `.md`）。

| 官方库              | 全量索引 URL                  | 索引里非规则页数 | 拉到正文的页数 | 备注                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------- | ---------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| oxc（oxlint/oxfmt） | `https://oxc.rs/llms.txt`     | 96               | 73             | 索引里另有 **871 条规则**各自的规则页，本次不逐页抓，改抓规则索引页 `rules.html` 的完整表格并本地解析（见 §1.3）。漏掉的 23 页：15 页 `/docs/learn/*`（parser / TS 编译器内部实现）、7 页 transformer、`what-is-oxc.md`（该页另行单独打开过，见 §1.2）。**另加**：blog 的 RSS 索引 `https://oxc.rs/feeds/blog-en.rss` 的全部 **15 篇**帖子逐篇打开正文（§4.1 第 4 条） |
| vitest              | `https://vitest.dev/llms.txt` | 215              | 215            | 全部抓到                                                                                                                                                                                                                                                                                                                                                               |

### 1.2 逐页打开过、且本笔记引用了原文的 URL

**oxc / oxlint / oxfmt（全部 2026-10-22 打开）**

| URL                                                                                 | 确立了哪一条                                                                                                                       |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `https://oxc.rs/docs/guide/usage/linter.html`                                       | oxlint 自我定位；"Correctness-focused defaults" 一节的原文；ESLint 迁移两条路径；type-aware 段落；871 条规则                       |
| `https://oxc.rs/docs/guide/usage/linter/config.md`                                  | 7 个类别的官方定义；"By default, Oxlint enables rules in the `correctness` category."；`options.typeAware` 等                      |
| `https://oxc.rs/docs/guide/usage/linter/config-file-reference.md`                   | `options.reportUnusedDisableDirectives` / `respectEslintDisableDirectives` / `typeAware` / `typeCheck`；`env` 全表；`plugins` 枚举 |
| `https://oxc.rs/docs/guide/usage/linter/cli.md`                                     | 7 个类别的 CLI 版定义；`--report-unused-disable-directives`；默认开的插件与 `--*-plugin` 开关                                      |
| `https://oxc.rs/docs/guide/usage/linter/rules.md`                                   | 规则页结构；类别分组说明                                                                                                           |
| `https://oxc.rs/docs/guide/usage/linter/rules.html`                                 | **规则总表**：每条规则的插件、类别、默认是否开启（§1.3 的数据源）                                                                  |
| `https://oxc.rs/docs/guide/usage/linter/plugins.md`                                 | **15 个内置插件的官方默认开关表**；"Correctness rules are enabled by default."                                                     |
| `https://oxc.rs/docs/guide/usage/linter/type-aware.md`                              | type-aware 的定位、tsgolint 分工、覆盖率（59/61）、稳定性 caveat、`--type-check` 可替代 `tsc --noEmit`                             |
| `https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint.md`                     | 与 ESLint 并跑的官方三步法；"run Oxlint first"；`eslint-plugin-oxlint` 的 "reduces duplicate diagnostics"                          |
| `https://oxc.rs/docs/guide/usage/linter/ignore-comments.md`                         | "Reporting unused ignore comments is disabled by default."；"Rule options belong in configuration files."                          |
| `https://oxc.rs/docs/guide/usage/linter/multi-file-analysis.md`                     | 跨文件分析是 first-class capability；`import/no-cycle`                                                                             |
| `https://oxc.rs/docs/guide/usage/linter/rules/vitest/no-conditional-expect.md`      | 条件断言为什么是 correctness（官方理由原文）                                                                                       |
| `https://oxc.rs/docs/guide/usage/linter/rules/vitest/prefer-expect-assertions.md`   | 「每个测试都要写 `expect.assertions`」这条规则的官方定位与理由                                                                     |
| `https://oxc.rs/docs/guide/usage/formatter.html`                                    | oxfmt 自我定位；Prettier 兼容立场；内置 sorting 能力                                                                               |
| `https://oxc.rs/docs/guide/usage/formatter/config.md`                               | oxfmt 配置面；`printWidth` 默认 100 的官方理由；选项优先级（**配置项**优先级）                                                     |
| `https://oxc.rs/docs/guide/usage/formatter/config-file-reference.md`                | oxfmt 全部配置项与默认值（`sortPackageJson` 默认开、`sortImports` 默认关 等）                                                      |
| `https://oxc.rs/docs/guide/usage/formatter/beyond-prettier.md`                      | oxfmt 内置的 4 个插件默认开关；oxfmt 识别 Vitest 的 `.concurrent` 等测试调用语法                                                   |
| `https://oxc.rs/docs/guide/usage/formatter/ignore-files.md`                         | oxfmt 的忽略机制分工（`ignorePatterns` / `.gitignore` / `.prettierignore`）                                                        |
| `https://oxc.rs/docs/guide/usage/formatter/unsupported-features.md`                 | oxfmt 明确不支持的东西（`prettier` 字段、嵌套 `.editorconfig` 等）                                                                 |
| `https://oxc.rs/docs/guide/usage/formatter/migrate-from-prettier.md`                | **formatter 与 linter 分工的官方线**（styling 类 lint 规则会与 Oxfmt 冲突）                                                        |
| `https://oxc.rs/docs/guide/usage/coding-agents.md`                                  | **官方唯一一条 oxlint→oxfmt 的顺序**（agent 编辑回路）                                                                             |
| `https://oxc.rs/docs/guide/what-is-oxc.md`                                          | oxc 的哲学与「You can use each tool on its own, or use them together as one toolchain."                                            |
| `https://oxc.rs/docs/guide/introduction.md`                                         | "Lint: Oxlint / Format: Oxfmt"                                                                                                     |
| `https://oxc.rs/compatibility.html`                                                 | oxc 官方兼容矩阵；页面副标题即 "Oxlint (linting) and Oxfmt (formatting)"                                                           |
| `https://oxc.rs/llms.txt`                                                           | oxc 全量文档索引（否定结论的证据底座，见 §4）                                                                                      |
| `https://oxc.rs/feeds/blog-en.rss`                                                  | oxc 官方 blog 的 RSS 全量索引（15 篇帖子），逐篇打开正文扫跨工具表述（见 §4.1 第 4 条）                                            |
| `https://raw.githubusercontent.com/oxc-project/eslint-plugin-oxlint/main/README.md` | **规则表归属**的官方原文；"Run oxlint before eslint" 小节                                                                          |

**vitest（全部 2026-10-22 打开）**

| URL                                         | 确立了哪一条                                                                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://vitest.dev/guide/why.md`           | vitest 自我定位："Vitest aims to position itself as the Test Runner of choice for Vite projects..."                                                                     |
| `https://vitest.dev/guide/comparisons.md`   | **vitest 唯一的「与别的工具分工」页面，比的全是 test runner**（Jest / Cypress / WebdriverIO / Web Test Runner / uvu / Mocha / Playwright），没有 linter、没有 formatter |
| `https://vitest.dev/guide/coverage.md`      | 覆盖率 provider、`coverage.enabled` 默认 false；**全文不提 thresholds**                                                                                                 |
| `https://vitest.dev/config/coverage.md`     | `coverage.thresholds` 四个指标**无 Default 行**；`perFile`/`autoUpdate`/`100` 的默认值                                                                                  |
| `https://vitest.dev/api/expect.md`          | `expect.assertions` / `expect.hasAssertions` 的官方定义与官方用例注释                                                                                                   |
| `https://vitest.dev/guide/testing-types.md` | `--typecheck` 的定位；"Vitest uses `tsc --noEmit` ... so you can remove these scripts from your pipeline."                                                              |
| `https://vitest.dev/llms.txt`               | vitest 全量文档索引（否定结论的证据底座，见 §4）                                                                                                                        |

### 1.3 全库 grep 的两个补充说明

- **oxc 的规则类别**：871 条规则各自的类别、默认是否开启，取自 `rules.html` 渲染后的表格，本地解析 `<tr>` 取出「规则名 / 插件 / 类别 / 默认开启 / 有无 fix / 引入版本」六列。本笔记只引用其中与本票相关的 8 条（§2.1.3）。
- **vitest 侧的全库 grep**：`oxfmt` 0 命中、`prettier` 0 命中、`biome` 0 命中；`linter` / `eslint` / `oxlint` 各只命中 **2 个文件**，两处都是**指向具体 lint 规则的链接**（§4.3）。

---

## 2. 三家官方各自的「我管什么」

### 2.1 oxlint

#### 2.1.1 自我定位与默认类别

oxlint 官方对自身的定位：

> "Oxlint (`/oʊ-ɛks-lɪnt/`) is a high-performance linter for JavaScript and TypeScript built on the Oxc compiler stack." —— <https://oxc.rs/docs/guide/usage/linter.html>

类别与默认值（官方 config 页）：

> "By default, Oxlint enables rules in the `correctness` category." —— <https://oxc.rs/docs/guide/usage/linter/config.md>

> "Correctness rules are enabled by default." —— <https://oxc.rs/docs/guide/usage/linter/plugins.md>

**官方类别共 7 个**（CLI 页与 config 页各给一份措辞，两份都列 `perf`）：

| 类别          | config 页措辞                                      | CLI 页措辞                                                         | 默认   |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------ | ------ |
| `correctness` | "Code that is definitely wrong or useless"         | "Code that is outright wrong or useless (default)"                 | **开** |
| `suspicious`  | "Code that is likely to be wrong or useless"       | "Code that is most likely wrong or useless"                        | 关     |
| `pedantic`    | "Extra strict rules that may have false positives" | "Lints which are rather strict or have occasional false positives" | 关     |
| `perf`        | "Rules that aim to improve runtime performance"    | "Code that could be written in a more performant way"              | 关     |
| `style`       | "Idiomatic and consistent style rules"             | "Code that should be written in a more idiomatic way"              | 关     |
| `restriction` | "Rules that ban specific patterns or features"     | "Lints which prevent the use of language and library features"     | 关     |
| `nursery`     | "Rules under development that may change"          | "New lints that are still under development"                       | 关     |

出处：<https://oxc.rs/docs/guide/usage/linter/config.md>、<https://oxc.rs/docs/guide/usage/linter/cli.md>。

官方对**何时启用**各类别的说法只有一句：

> "Oxlint is useful out of the box. By default, it prioritizes high-signal correctness checks. These checks surface code that is incorrect, unsafe, or useless, so teams can adopt Oxlint without excessive noise. **Additional rules can be enabled incrementally as requirements evolve.**" —— <https://oxc.rs/docs/guide/usage/linter.html>

CLI 还有一个 `all` 类别：

> "`all` - All categories listed above except `nursery`. Does not enable plugins automatically." —— <https://oxc.rs/docs/guide/usage/linter/cli.md>

#### 2.1.2 「排版不是 oxlint 的事」—— 官方口径核对

官方把两件事分开说的地方有三处，都**没有**说「style 归 formatter」：

> "Lint: Oxlint / Format: Oxfmt" —— <https://oxc.rs/docs/guide/introduction.md>

> 兼容矩阵页副标题："Check which JavaScript frameworks and file types are supported by Oxlint (**linting**) and Oxfmt (**formatting**)." —— <https://oxc.rs/compatibility.html>

oxc 项目哲学里最接近「边界」的一句：

> "**Correctness with clear boundaries** — Oxc aims to be correct and predictable. When behavior differs from other tools, the differences should be documented. Compatibility is a feature, not an accident." —— <https://oxc.rs/docs/guide/what-is-oxc.md>

**核对结果**：本仓 `docs/agents/review-layers.md:89` 写的是

> `oxlint ↔ oxfmt` | 靠**类别默认**分层：oxlint 官方 "Correctness-focused defaults" —— 默认只查 correctness，style/formatting 归 formatter

- 「"Correctness-focused defaults"」**是官方小节标题**（在 <https://oxc.rs/docs/guide/usage/linter.html>）✔
- 「默认只查 correctness」**有官方原文支撑** ✔
- 「**style/formatting 归 formatter**」**在官方文档里找不到出处** ✘ —— 官方把 `style` 定义成 **oxlint 自己的类别**（默认关），见 §2.1.2 的表。oxfmt 侧唯一的官方分工线说的是**冲突**而非归属（§2.2.3）。

也就是说，这句转述的**前半句是官方口径、后半句是本仓自己的推论**，而且与官方把 `style` 列为 oxlint 类别这一事实相反。

#### 2.1.3 vitest 插件：条件断言的官方归类（对着本仓 F2）

oxlint 内置了 `vitest` 插件（对应 `@vitest/eslint-plugin`），里面直接管住了本仓 F2 那个问题。官方规则页给出的**理由原文**：

> **What it does** — "This rule prevents the use of `expect` in conditional blocks, such as `if` and `catch`."
>
> **Why is this bad?** — "Jest only considers a test to have failed if it throws an error, meaning if calls to assertion functions like `expect` occur in conditional code such as a `catch` statement, **tests can end up passing but not actually test anything**. Additionally, conditionals tend to make tests more brittle and complex..." —— <https://oxc.rs/docs/guide/usage/linter/rules/vitest/no-conditional-expect.md>

> **What it does** — "Enforces that every test has either `expect.assertions(<number>)` or `expect.hasAssertions()` as its first expression."
>
> **Why is this bad?** — "Without explicit assertion counts, tests with asynchronous code, callbacks, or loops **may pass even if some `expect` calls are never reached, silently hiding bugs**." —— <https://oxc.rs/docs/guide/usage/linter/rules/vitest/prefer-expect-assertions.md>

这四条规则在官方规则总表里的**类别与默认状态**（取自 <https://oxc.rs/docs/guide/usage/linter/rules.html>）：

| 规则                              | 类别          | 默认开 | 官方含义                     |
| --------------------------------- | ------------- | ------ | ---------------------------- |
| `vitest/no-conditional-expect`    | `correctness` | 否     | 禁止在条件分支里写 `expect`  |
| `vitest/no-conditional-tests`     | `correctness` | 否     | 禁止条件化地写测试           |
| `vitest/no-conditional-in-test`   | `pedantic`    | 否     | 禁止测试体内部出现条件语句   |
| `vitest/prefer-expect-assertions` | `style`       | 否     | 要求每个测试显式声明断言条数 |

（同族还有 `vitest/expect-expect` = `correctness`、`vitest/valid-expect` = `correctness`、`vitest/no-standalone-expect` = `correctness`。）

> 注：`correctness` 类别本身默认开（§2.1.1），但 `vitest` **插件**默认关（§2.1.4）⇒ 这几条规则在本仓当前配置下**一条都不会跑**。

#### 2.1.4 内置插件与默认开关（官方表）

官方插件表（<https://oxc.rs/docs/guide/usage/linter/plugins.md>）：

| 默认开                                   | 默认关                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `eslint`、`typescript`、`unicorn`、`oxc` | `react`、`react-perf`、`nextjs`、`import`、`jsdoc`、`jsx-a11y`、`node`、`promise`、`jest`、**`vitest`**、`vue` |

共 **15 个**。CLI 页对应地写明 `unicorn` / `oxc` / `typescript` "turned on by default"，`react` "turned off by default"，其余用 `--<name>-plugin` 显式开（<https://oxc.rs/docs/guide/usage/linter/cli.md>）。

oxlint 官方对**插件与类别的关系**的说法：

> "A plugin is a named group of rules. Enabling a plugin makes its rules available, and **category flags control which rules are enabled and at what severity**." —— <https://oxc.rs/docs/guide/usage/linter/plugins.md>

#### 2.1.5 ESLint 迁移：规则表归属与官方顺序

> "Turn off all rules already supported by [`oxlint`](https://oxc.rs/docs/guide/usage/linter). **The rules are extracted from [here](https://github.com/oxc-project/oxc/blob/main/crates/oxc_linter/src/rules.rs).**" —— <https://raw.githubusercontent.com/oxc-project/eslint-plugin-oxlint/main/README.md>

> "You can use [`eslint-plugin-oxlint`](https://npmx.dev/package/eslint-plugin-oxlint) to disable ESLint rules that are already handled by Oxlint: ...
>
> **This reduces duplicate diagnostics**, can help cut down your linting time considerably, and allows ESLint to focus only on rules that Oxlint does not yet support." —— <https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint.md>

官方给的三步并跑法：

> "A common setup is:
>
> 1. Enable Oxlint for all supported rules
> 2. Keep ESLint for unsupported rules
> 3. Disable overlapping rules in ESLint" —— <https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint.md>

以及那条**唯一带先后词的官方顺序**（两个 linter 之间）：

> "Because Oxlint is significantly faster than ESLint, **it is recommended to run Oxlint first to catch errors early, then fall back to ESLint only if needed.**
>
> ````bash
> oxlint && eslint
> ```" —— <https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint.md>
> ````

`eslint-plugin-oxlint` README 里同样的顺序写在小节标题上：

> "### Run oxlint before eslint
>
> ````json
> { "scripts": { "lint": "oxlint && eslint" } }
> ```" —— <https://raw.githubusercontent.com/oxc-project/eslint-plugin-oxlint/main/README.md>
> ````

#### 2.1.6 type-aware linting：定位与代价

> "Type-aware linting enables rules that rely on TypeScript's type system, such as detecting unhandled promises or unsafe assignments. In Oxlint, type-aware linting is provided by [`tsgolint`](https://github.com/oxc-project/tsgolint)..." —— <https://oxc.rs/docs/guide/usage/linter/type-aware.md>

职责切分：

> "Oxlint separates responsibilities between two components:
>
> - **Oxlint (Rust)** — Handles file traversal, ignore logic, configuration, non-type-aware rules, and reporting.
> - **tsgolint (Go)** — Builds TypeScript programs using [`typescript-go`](...) and executes type-aware rules, returning structured diagnostics to Oxlint." —— 同上

覆盖度与**官方 caveat**：

> "Type-aware linting currently supports **59 out of 61** type-aware rules from typescript-eslint. Rule coverage, performance, and compatibility continue to improve." —— 同上

> "### Stability notes
>
> Type-aware linting:
>
> - **Rule coverage is incomplete (but very close)**
> - **Very large codebases may encounter high memory usage**
> - Performance continues to improve" —— 同上

**与类型检查的边界**（官方说可以替代 `tsc --noEmit`）：

> "Enable type checking to report TypeScript errors alongside lint results: `oxlint --type-aware --type-check` ...
>
> This mode **can replace a separate `tsc --noEmit` step in CI**:
>
> ````bash
> # before
> tsc --noEmit
> oxlint
>
> # after
> oxlint --type-aware --type-check
> ```" —— 同上
> ````

注意 `--type-check` 在 config reference 里被标为实验性：

> "### options.typeCheck — type: `boolean` — Enable **experimental** type checking (includes TypeScript compiler diagnostics)." —— <https://oxc.rs/docs/guide/usage/linter/config-file-reference.md>

#### 2.1.7 相关配置面

> "### options.reportUnusedDisableDirectives — type: `"allow" | "off" | "warn" | "error" | "deny" | integer` — Report unused disable directives (e.g. `// oxlint-disable-line` or `// eslint-disable-line`). ... **Only supported in the root configuration file.**" —— <https://oxc.rs/docs/guide/usage/linter/config-file-reference.md>

默认值在 inline ignore comments 页给了：

> "**Reporting unused ignore comments is disabled by default.** When enabled, Oxlint reports comments such as `// oxlint-disable-line` when no diagnostics would have been reported on that line." —— <https://oxc.rs/docs/guide/usage/linter/ignore-comments.md>

同一页还有本仓 `review-layers.md` 引的那句：

> "Ignore comments can enable or disable rules, but they cannot change rule options. **Rule options belong in configuration files.**" —— 同上

另外：

> "### options.respectEslintDisableDirectives — type: `boolean` — Whether oxlint should respect `eslint-disable*` and `eslint-enable*` directives in addition to its native `oxlint-*` directives. **Defaults to `true`.**" —— <https://oxc.rs/docs/guide/usage/linter/config-file-reference.md>

> "### options.typeAware — type: `boolean` — Enable rules that require type information. Equivalent to passing `--type-aware` on the CLI. **Note that this requires the `oxlint-tsgolint` package to be installed.**" —— 同上

`env` 的官方全表里确实有 `vitest`（"Vitest globals"）与 `node`（"Node.js globals and scoping"）两个环境，另有 `builtin`（"Latest ECMAScript globals, equivalent to es2026."）—— 见同页 `## env` 一节。

### 2.2 oxfmt

#### 2.2.1 自我定位

> "Oxfmt (`/oʊ-ɛks-fɔːr-mæt/`) is a high-performance formatter for the JavaScript ecosystem." —— <https://oxc.rs/docs/guide/usage/formatter.html>

> "Oxfmt is the recommended choice when you want a dedicated formatter with a **Prettier-compatible workflow**, much higher throughput, and built-in sorting features." —— 同上

#### 2.2.2 兼容性立场

> "Oxfmt uses **Prettier's output as its baseline**, so migrating from recent versions of Prettier produces few formatting differences. **Unexpected differences are treated as bugs.** Where Prettier's behavior is a bug or inconsistent across similar cases, **Oxfmt deliberately diverges in favor of correct and consistent output.**" —— <https://oxc.rs/docs/guide/usage/formatter.html>

> "Oxfmt is tested against Prettier's own test suite for each natively supported language." —— 同上

> "`printWidth` — Oxfmt defaults to `printWidth: 100` (Prettier uses 80). Reasons: TypeScript code is longer due to type annotations; Import statements often have many specifiers; Modern screens are wider; **Fewer line breaks mean fewer LLM tokens**." —— <https://oxc.rs/docs/guide/usage/formatter/config.md>

#### 2.2.3 与 linter 的分工：官方只有「冲突」这一句

oxfmt 全部官方页面里**没有**一句「style 归 formatter」这类归属宣告。唯一涉及 linter 分工的原话在 Prettier 迁移页：

> "### Update lint rules
>
> Remove `eslint-plugin-prettier` if present. If needed, it can be replaced by a `oxfmt --check` job in your CI pipelines.
>
> Note that if you intend to continue using ESLint, you _should_ keep or add [`eslint-config-prettier`](https://github.com/prettier/eslint-config-prettier) to **disable styling-related ESLint rules that might conflict with Oxfmt**. `eslint-config-prettier` is different from `eslint-plugin-prettier`, as it has no new lint rules. It is only a config.
>
> Also, consider migrating to [Oxlint](../linter.md)." —— <https://oxc.rs/docs/guide/usage/formatter/migrate-from-prettier.md>

即：**官方说的是「styling 类 lint 规则与 formatter 会冲突 ⇒ 在 linter 侧关掉」**，主语是冲突，不是归属。这条线没有说「lint 不该管 style」——它说的是两边都留着会打架。

#### 2.2.4 配置面与「哪些文件该被格式化」

配置面完整清单与默认值在 <https://oxc.rs/docs/guide/usage/formatter/config-file-reference.md>；官方 config 页的「最常用字段」摘要：

> "`printWidth`: Line width limit (default: 100) / `tabWidth`: Spaces per indentation level (default: 2) / `useTabs` (default: false) / `semi` (default: true) / `singleQuote` (default: false) / `trailingComma` (default: "all") / `ignorePatterns`: Glob patterns to exclude from formatting / `sortImports` (**disabled by default**) / `sortTailwindcss` (**disabled by default**) / `sortPackageJson` (**enabled by default**)" —— <https://oxc.rs/docs/guide/usage/formatter/config.md>

**哪些文件该/不该被格式化**，官方有明确说法：

> "## Ignore files — Oxfmt provides several ways to exclude files from formatting.
>
> | Mechanism                           | Scope                 |
> | ----------------------------------- | --------------------- |
> | CLI paths with `!` prefix           | Global                |
> | `.prettierignore` / `--ignore-path` | Global                |
> | `ignorePatterns` in config          | Scoped to that config | " —— <https://oxc.rs/docs/guide/usage/formatter/ignore-files.md> |

同页要点：

> "`ignorePatterns` ... Uses `.gitignore` syntax; Paths are resolved relative to the directory containing the Oxfmt config file; Formatter-specific and independent of Git. **Files matching `ignorePatterns` cannot be formatted, even if explicitly specified.**" —— 同上

> "Ignored by default: `.git`, `.svn`, `.jj`, `node_modules`"；"Lock files — `package-lock.json`, `pnpm-lock.yaml`, etc. are **always ignored**." —— 同上

oxfmt 明确**不支持**的东西：

> "## Configuration limitations — Not currently supported: `prettier` field in `package.json`; Nested `.editorconfig` in sub directories; `experimentalTernaries` option" —— <https://oxc.rs/docs/guide/usage/formatter/unsupported-features.md>

oxfmt 内置的 4 个 sorting 能力及默认开关：

> "`sortImports` (Disabled by default) / `sortTailwindcss` (Disabled by default) / `sortPackageJson` (**Enabled by default**) / `jsdoc` (Disabled by default)" —— <https://oxc.rs/docs/guide/usage/formatter/beyond-prettier.md>

oxfmt 对**仓库该怎么组织格式与 lint 的关注点**，官方没有给结构性建议；只给了「Prettier 迁移」的目录（config / CI / git hooks / lint rules / `.git-blame-ignore-revs` / `ignorePatterns`），见 <https://oxc.rs/docs/guide/usage/formatter/migrate-from-prettier.md>。

### 2.3 vitest

#### 2.3.1 自我定位与职责边界

> "**Vitest aims to position itself as the Test Runner of choice for Vite projects, and as a solid alternative even for projects not using Vite.**" —— <https://vitest.dev/guide/why.md>

> "It is a test runner that uses the same configuration as your app (through `vite.config.js`), sharing a common transformation pipeline during dev, build, and test time." —— 同上

vitest 唯一一页讲「与别的工具分工」的，是 `/guide/comparisons`，标题就是 **"Comparisons with Other Test Runners"** —— 里面比的是 Jest / Cypress / WebdriverIO / Web Test Runner / uvu / Mocha / Playwright，**全部是 test runner**，没有 linter、没有 formatter（<https://vitest.dev/guide/comparisons.md>）。

vitest 唯一给出的跨工具分工式表述也发生在 test runner 之间：

> "If you'd like to use Cypress, we suggest using Vitest for all headless logic in your application and Cypress for all browser-based logic." —— 同上

**条件断言（对着本仓 F2）** —— 官方机制与官方用例注释：

> "## expect.assertions — **Type:** `(count: number) => void`
>
> After the test has passed or failed verify that a certain number of assertions was called during a test. A useful case would be to check if an asynchronous code was called." —— <https://vitest.dev/api/expect.md>

> "## expect.hasAssertions — **Type:** `() => void`
>
> After the test has passed or failed verify that at least one assertion was called during a test. A useful case would be to check if an asynchronous code was called." —— 同上

vitest 官方示例里的那句注释，正是本仓 F2 的原话：

> ````ts
> test('callback was called', async () => {
>   expect.hasAssertions()
>   onSelect((data) => {
>     // should be called on select
>     expect(data).toBeTruthy()
>   })
>   // if not awaited, test will fail
>   // **if you don't have expect.hasAssertions(), test will pass**
>   await select(3)
> })
> ``` —— 同上
> ````

vitest **没有**说「应该给每个测试都写 `expect.assertions`」——那是 oxlint 的 `vitest/prefer-expect-assertions`（`style` 类别，默认关，见 §2.1.3）。vitest 只是提供了机制。

#### 2.3.2 覆盖率阈值：官方不推荐、也没有默认

- `coverage.enabled`：

> "## coverage.enabled — **Type:** `boolean` — **Default:** `false`" —— <https://vitest.dev/config/coverage.md>

- 四个阈值指标，官方 config reference 里**没有 Default 行**：

> "### coverage.thresholds.lines — **Type:** `number`"（无 Default） / "### coverage.thresholds.functions — **Type:** `number`"（无 Default） / "### coverage.thresholds.branches — **Type:** `number`"（无 Default） / "### coverage.thresholds.statements — **Type:** `number`"（无 Default） —— <https://vitest.dev/config/coverage.md>

对照同页**有**默认值的项（`perFile` = `false`、`autoUpdate` = `false`、`100` = `false`、glob 模式 = `undefined`）—— 四个指标没写默认 ⇒ **官方默认是不设阈值**。

- 官方 coverage guide（<https://vitest.dev/guide/coverage.md>）**全文没有出现 thresholds**，也没有任何「建议开阈值」的话。该页唯一的 "recommended" 是关于 `coverage.include` 模式的写法。

- vitest 官方的**唯一**阈值相关口径是**语义**（不是推荐）：

> "If a threshold is set to a positive number, it will be interpreted as the minimum percentage of coverage required. ... If a threshold is set to a negative number, it will be treated as the maximum number of uncovered items allowed." —— <https://vitest.dev/config/coverage.md>

#### 2.3.3 类型检查的定位

> "Vitest allows you to write tests for your types, using `expectTypeOf` or `assertType` syntaxes." —— <https://vitest.dev/guide/testing-types.md>

> "Under the hood Vitest calls `tsc` or `vue-tsc`, depending on your config, and parses results." —— 同上

> "Vitest uses `tsc --noEmit` or `vue-tsc --noEmit`, depending on your configuration, **so you can remove these scripts from your pipeline.**" —— 同上

⚠️ 这句的语境是**类型测试**（`*.test-d.ts`），不是全仓类型检查。它与 oxlint 的 `--type-check`（"can replace a separate `tsc --noEmit` step in CI"）**不是同一件事**，只是恰好都提到可以撤掉 `tsc --noEmit`。

---

## 3. 「谁管什么」矩阵

图例：**● 官方 owner**（官方明确把这条关注点划给它）/ **◐ 可兼顾但非主责**（官方声明能兼顾，但没说这是它的主要职责）/ **○ 不是它的活**（官方把它划给别人，或明确说不该由它管）/ **— 官方未表态**（该工具的官方文档里找不到任何相关说法）。

| 关注点                                                       | oxlint                                                                                                                                                                   | oxfmt                                                            | vitest                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 排版 / formatting                                            | ○ —— "Lint: Oxlint / Format: Oxfmt"                                                                                                                                      | ● —— "is a high-performance formatter"                           | — 全库 grep 0 命中（oxfmt / prettier / biome）                                             |
| lint 规则（correctness / suspicious）                        | ● —— "By default, Oxlint enables rules in the `correctness` category."                                                                                                   | ○                                                                | —                                                                                          |
| lint 规则（style / pedantic / restriction / perf / nursery） | ● **但默认关** —— `style` 是 oxlint 自己的类别                                                                                                                           | ○ —— 官方线只说 styling 类 lint 规则「会与 Oxfmt 冲突」          | —                                                                                          |
| type-aware lint（依赖类型信息的规则）                        | ● —— tsgolint 提供，59/61 覆盖，"Rule coverage is incomplete"                                                                                                            | ○                                                                | —                                                                                          |
| 类型错误（type errors）                                      | ◐ **可承担**（实验性 `--type-check`，"can replace a separate `tsc --noEmit` step in CI"）                                                                                | ○                                                                | ◐ **可承担**（`--typecheck` 调 `tsc --noEmit`，定位是**类型测试**）                        |
| 测试断言（运行时行为）                                       | ◐ **部分** —— `vitest` 插件的静态规则（`valid-expect` 等），**插件默认关**                                                                                               | ○                                                                | ● —— `expect` API 是它的正主                                                               |
| 条件 / 环境依赖断言（F2）                                    | ● **有明确归类** —— `vitest/no-conditional-expect` = `correctness`（默认开类别）；`vitest/prefer-expect-assertions` = `style`（默认关）                                  | ○                                                                | ● **有机制** —— `expect.assertions` / `expect.hasAssertions`；官方未说「必须每个测试都写」 |
| 覆盖率阈值                                                   | —                                                                                                                                                                        | —                                                                | ● **有机制、但可选、无默认、官方不推荐开**；`coverage.enabled` 默认 `false`                |
| 跨文件死代码 / 循环依赖                                      | ● **部分** —— multi-file analysis 是 first-class capability，`import/no-cycle`；**「死代码」本身官方未表态**（oxc 的 dead-code elimination 属于 minifier，不在这三者内） | ○                                                                | —                                                                                          |
| 外部链接（dead link）                                        | —                                                                                                                                                                        | —                                                                | —                                                                                          |
| package manifest 形状（package.json）                        | —                                                                                                                                                                        | ● **部分** —— `sortPackageJson` **默认开**（只管排序，不管语义） | —                                                                                          |
| 谁拥有 lint 规则表                                           | ● —— "The rules are extracted from [here](.../rules.rs)"                                                                                                                 | ○                                                                | — —— vitest 提供 `eslint-plugin-vitest`，oxlint 把它做成原生 `vitest` 插件                 |

**矩阵读法**：`—` 的行是**三家都不表态**的关注点。本仓 map 里的「补足依赖」层（外链检查、package manifest 语义等）**没有任何官方依据**——它们不是「某家官方不管所以归补足」，而是**三家官方从头到尾没谈过**。这一层是仓库自己的分类。

---

## 4. 关键问题：有没有官方的跨工具判定顺序？

### 4.1 答案：没有

**oxlint / oxfmt / vitest 官方都没有给出「一个关注点几个工具都能判时，谁先说」的判定顺序。** 官方给的是**领域边界**（oxlint = linting，oxfmt = formatting，vitest = test runner），组合方式留给项目自己定。

否定结论的证据（全部来自实际抓取 + 本地 grep）：

1. **oxc 侧全量扫描**：<https://oxc.rs/llms.txt> 列出 oxc 全站文档页；其中 96 个非规则页全部拉正文本地 grep（73 页取到，漏的 23 页是 `/docs/learn/*` parser 内部实现页、transformer 页、`what-is-oxc.md`——后者另行单独打开过），外加 871 条规则的索引页表格。
   - 全部 "precedence" 命中都是**配置项**优先级，无一例外：`"CLI flags take precedence when both CLI and config values are present."`（<https://oxc.rs/docs/guide/usage/linter/config.md>）、`"the later one takes precedence"`（<https://oxc.rs/docs/guide/usage/formatter/config.md>）。**没有一处是「工具」优先级。**
2. **oxc 文档里的 "vitest" 全部命中**（11 个文件）只有三种上下文：oxlint 的 `vitest` 插件（规则页 / CLI / config）、oxfmt 识别 Vitest 测试调用语法（`beyond-prettier.md` 里的 `.concurrent` / `.sequential` / `.fails` / `.shuffle` / `bench`）、以及 contributor 文档。**oxc 从未把 vitest 当成一个与 oxlint/oxfmt 平级的工具来谈，更没有把三者排成一条链。**
3. **vitest 侧全量扫描**：<https://vitest.dev/llms.txt> 的 215 页全部拉正文本地 grep。
   - `oxfmt` **0 命中**、`prettier` **0 命中**、`biome` **0 命中**。
   - `linter` / `eslint` / `oxlint` 各只命中 **2 个文件**，两处都是**指向具体 lint 规则的链接**：
     > "If you want to enforce a consistent choice across your codebase, the [`consistent-test-it`](...) ESLint rule (also available in [oxlint](...)) can help with that." —— <https://vitest.dev/guide/learn/writing-tests.md>
     > "To catch `.only` even earlier, the [`no-focused-tests`](...) ESLint rule (also available in [oxlint](...)) can flag it in your editor before you commit." —— <https://vitest.dev/guide/filtering.md>
   - 即：vitest 只在**两个具体风格/编辑器反馈问题**上指了个 lint 规则，既没说分工，也没说顺序。
4. **oxc 官方 blog 全量扫描**：<https://oxc.rs/feeds/blog-en.rss> 列出 blog 全部 **15 篇**帖子（Oxlint GA / Import Plugin / Transformer / v0.10 / Minifier / Beta / v1.0 Stable / Type-Aware Preview / JS Plugins Preview / **Oxfmt Alpha** / Type-Aware Alpha / **Oxfmt Beta** / JS Plugins Alpha / Type-Aware Linting Stable / React Compiler Support）。逐篇打开正文扫：
   - 其中 **10 篇**正文里 `vitest` / `oxfmt` / `precedence` 三个词**全部 0 命中**；
   - 两篇 oxfmt 帖（Alpha / Beta）正文**没有一句提到 oxlint**（只在导航栏出现），唯一的 lint 相关句子是 "Update lint-staged to use `oxfmt --no-error-on-unmatched-pattern`"；
   - 全 blog 语料里 **唯一** 的 "precedence" 出现在 Type-Aware Linting Stable："Both options are root-only, and **CLI flags take precedence**." —— 又是**配置项**优先级。
   - ⇒ **oxc 的 blog 也没有跨工具判定顺序。**

### 4.2 但确实存在两条官方顺序 —— 两条都不是本仓要的那条

**顺序 A：oxlint → ESLint（迁移期，两个 linter 谁先跑）**

> "Because Oxlint is significantly faster than ESLint, **it is recommended to run Oxlint first to catch errors early, then fall back to ESLint only if needed.**" —— <https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint.md>

> "**Run Oxlint first, then run ESLint with overlapping rules disabled.** This keeps CI fast while you migrate." —— <https://oxc.rs/docs/guide/usage/linter.html>

> "### Run oxlint before eslint" —— <https://raw.githubusercontent.com/oxc-project/eslint-plugin-oxlint/main/README.md>

作用域：**同一种关注点（lint 规则）被两个工具覆盖时**，快的那个先跑、慢的兜底。

**顺序 B：`oxlint --fix` → `oxfmt`（agent 编辑回路的**执行顺序**）**

> "## Linting and formatting
>
> - After making code changes, run `npx oxlint --fix`, then run `npx oxfmt`.
> - Before finishing, run `npx oxlint --deny-warnings --format=agent`." —— <https://oxc.rs/docs/guide/usage/coding-agents.md>

Claude Code hook 的同一条：

> `"command": "file=$(jq -r '.tool_input.file_path'); npx oxlint --fix --no-error-on-unmatched-pattern \"$file\"; npx oxfmt --no-error-on-unmatched-pattern \"$file\""` —— 同上

作用域：**改完代码后先修 lint 再格式化**（理由很直白：lint 的 fix 会改代码，改完再格式化才不会把格式弄脏）。这是**流水线的执行先后**，不是「一个关注点归谁判」。

**两条顺序的共同点（决定了它们不能直接充当本仓的判定顺序）**：

- 都是**执行顺序**（先跑谁），不是**判定归属**（谁说了算）；
- 都不提 **vitest**；
- 顺序 A 的两个工具是**同一种关注点的两个实现**（rule 重叠），顺序 B 的两个工具**关注点本来就不重叠**（lint vs format），所以 B 其实**不构成「重叠时谁先判」的先例**。

### 4.3 一句话回答

> 官方没有给出跨工具的判定顺序。oxc 给的是**领域边界**（oxlint 管 lint、oxfmt 管 format）和两条**局部执行顺序**（oxlint→ESLint、oxlint--fix→oxfmt）；vitest 完全不谈 linter/formatter。**「一个关注点几个工具都能判时谁先说」在官方口径里是空白，落在项目自己身上。**

---

## 5. 这些官方线对本仓 open question 意味着什么（不是决定）

本节只做两件事：(a) 标出**官方口径支持什么**；(b) 标出**哪些是本仓自己的选择、无官方背书**。**不下结论。**

### 5.1 官方口径支持得住的

| 本仓 map 的待定项        | 官方口径支撑                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「格式归 oxfmt」         | ✔ 官方三处独立佐证：<https://oxc.rs/docs/guide/introduction.md>、<https://oxc.rs/compatibility.html>、oxfmt 自述页。**归属清楚。**                                      |
| 「lint 规则归 oxlint」   | ✔ 官方自述 + 类别默认 + 规则表归属（`rules.rs`）三处佐证。**归属清楚。**                                                                                                |
| 「测试行为归 vitest」    | ✔ 官方自述 + `expect` API + `expect.assertions` / `hasAssertions` 机制。**归属清楚。**                                                                                  |
| 「条件断言」这条关注点   | ✔ **两家都有官方说法**：vitest 给运行时机制；oxlint 把「条件里的 expect」定为 `correctness`、把「要求显式声明断言数」定为 `style`。**这是本仓 F2 最硬的一条外部依据。** |
| 「lint fix 先于 format」 | ✔ 官方有明确顺序（`oxlint --fix` → `oxfmt`，§4.2 顺序 B）。**这是唯一一条官方给的、跨两个工具的执行顺序。**                                                             |

### 5.2 官方没说的（本仓必须自己决定的部分）

| 本仓 map 的待定项                                          | 官方口径状态                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **完整的判定顺序（vitest → oxlint → oxfmt → … → 判断层）** | ✘ **官方没有这条链。** map #258 的六层顺序与 #256 的五步顺序，**两者都不是官方口径**，是本仓自己的设计。本票拿不到「哪一条对」的支持，只能拿到「官方不参与裁决」这个事实                                                                                                                                                |
| 「判断层 / 人工 / OCR 评审」放在哪一层                     | ✘ 三家官方文档里**没有出现过** judge / review / human-review 层的概念（oxc 的 `coding-agents.md` 讲的是让 agent 跑 lint/format，不是让 agent 评审）                                                                                                                                                                     |
| 「补足依赖」层                                             | ✘ 矩阵里 `—` 的行（外链、package manifest 语义、跨文件死代码语义）**三家都不表态**。这一层的存在是仓库自己的分类                                                                                                                                                                                                        |
| 「style 归 formatter」                                     | ✘ **官方不这么说**（§2.1.2）。官方把 `style` 定义为 oxlint 的类别（默认关）。仓库若要沿用「style 归 formatter」，得自己说明这是**关掉 linter 的 style 类别**的选择，而不是官方分工                                                                                                                                      |
| 「vitest 插件该不该进主干」                                | ✘ 官方只给默认开关（`vitest` 插件**默认关**）与规则类别（`correctness` / `style`），**没有**「该不该开」的推荐。oxlint 的 `plugins.md` 只说 "It is **strongly recommended** to use a config file to enable plugins"（配置方式，不是选哪些）                                                                             |
| 「覆盖率阈值该开多少」                                     | ✘ 官方**无默认、无推荐**（§2.3.2）。阈值取值是纯项目决策                                                                                                                                                                                                                                                                |
| 「type-aware 该不该开」                                    | ✘ 官方给的是**代价形态**（需装 `oxlint-tsgolint`、"Very large codebases may encounter high memory usage"、覆盖 59/61）**不是推荐值**。官方唯一的相关表述是「`--type-aware --type-check` 可替代 `tsc --noEmit`」                                                                                                         |
| 「type 错误归 oxlint 还是 vitest」                         | ⚠ **两家都声明可承担，且都提到能撤掉 `tsc --noEmit`**（oxlint: "can replace a separate `tsc --noEmit` step in CI"；vitest: "you can remove these scripts from your pipeline"）。但 vitest 的 `--typecheck` 官方定位是**类型测试**，oxlint 的 `--type-check` 官方标 **experimental**。官方**没有**说谁该负责全仓类型错误 |

### 5.3 三条「官方线 ⇒ 本仓现状」的具体提醒（供 map 参考，非决定）

1. **`review-layers.md:89` 的转述需要改口径**（§2.1.2）：`"Correctness-focused defaults"` 是官方小节标题，「默认只查 correctness」有原文；但「**style/formatting 归 formatter**」没有官方出处，且与官方把 `style` 列为 oxlint 类别这一事实相反。官方可引的原话是 oxfmt 迁移页那句「styling 类 lint 规则会与 Oxfmt 冲突 ⇒ 在 linter 里关掉」。
2. **官方类别是 7 个不是 6 个**：`perf` 在 CLI 页与 config 页都在（§2.1.1）。若 map 的 spec 要列类别，别漏。
3. **oxlint 的 `vitest` 插件默认关**（§2.1.4），且它里面的条件断言规则分属两个类别（`correctness` / `style`）。若 map 要把 F2 的守卫挂在 oxlint 侧，「挂哪条规则」与「开不开 vitest 插件」是两个独立决定，官方都没替本仓做。

---

## 6. 未能取证

| 想查的                                                       | 结果                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| oxc 是否有「oxlint vs oxfmt」专页                            | **没有**。全量索引 <https://oxc.rs/llms.txt> 里没有这样一页；最接近的是 <https://oxc.rs/docs/guide/usage/coding-agents.md>（agent 怎么跑这两个工具），不是「谁管什么」                                                                              |
| oxc blog 里有没有跨工具分工的帖子                            | **已查，没有。**<https://oxc.rs/feeds/blog-en.rss> 列出全部 15 篇，逐篇打开正文扫过（§4.1 第 4 条）：10 篇 0 命中，两篇 oxfmt 帖正文不提 oxlint，全 blog 唯一的 "precedence" 是 "CLI flags take precedence"（配置项优先级）                         |
| vitest 的 `typecheck` 指南页                                 | **404**。<https://vitest.dev/guide/typecheck.md> 不存在；类型测试的实际指南是 <https://vitest.dev/guide/testing-types.md>                                                                                                                           |
| oxlint 各类别的**官方 severity 默认值**（`warn` vs `error`） | **官方文档未给**。<https://oxc.rs/docs/guide/usage/linter/config-file-reference.md> 的 `categories.*` 小节是空的（只有标题、无类型无默认），只有 `correctness` 一句 "By default, Oxlint enables rules in the `correctness` category." 没说 severity |
| oxlint 插件在 `correctness` 之外类别的默认 severity          | **官方文档未给**。规则总表（<https://oxc.rs/docs/guide/usage/linter/rules.html>）给的是「默认是否开启」，不给 severity                                                                                                                              |
| vitest 官方对「覆盖率阈值」的推荐                            | **没有**。全库 grep 无 "recommend thresholds" 类表述；coverage guide 全文不提 thresholds（§2.3.2）                                                                                                                                                  |
| oxc 官方对「lint 规则与 formatter 规则的边界」               | **没有明确的边界宣告**。最接近的是 oxfmt 迁移页的「styling 类 lint 规则会与 Oxfmt 冲突」（§2.2.3），主语是冲突不是归属                                                                                                                              |
| oxc 文档里 15 页 `/docs/learn/*`、7 页 transformer           | 未抓正文（与本票问题无关：parser / TS 编译器内部实现、构建期转换）。**不影响** §4.1 的结论，因为这些页面里不含工具优先级表述，但严格说是未覆盖面                                                                                                    |
| vitest 侧「第三方 lint / formatter 推荐清单」                | **没有**。<https://vitest.dev/guide/comparisons.md> 只比 test runner；全库 0 命中 prettier / biome                                                                                                                                                  |
| oxlint 对 `expect.assertions` 的推荐强度                     | 官方有规则（`vitest/prefer-expect-assertions`，`style` 类、默认关），但**没有**「所有测试都必须写」的硬性表述——那是规则的语义，不是 oxlint 的推荐措辞                                                                                               |
