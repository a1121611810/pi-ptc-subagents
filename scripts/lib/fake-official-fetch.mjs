// 真机专用 shim：把「官方 OCR 端点」换成本地假响应（**零产品改动**）。
//
// 用法：NODE_OPTIONS="--import <本文件绝对路径 file URL>" <主程序>
//   形态：OCR_FAKE_COUNT_FILE（命中计数落盘）· OCR_FAKE_LOAD_FILE（加载/替换日志落盘）
//   假响应固定为「1 页、正文空」——就是官方偶发的那种形态。
//
// 为什么不给产品加「官方地址可注入」的 env 旋钮：entry 与 kimi-mcp 都把官方端点写死，
// 而那个旋钮会扩大「文件发到哪里」的信任边界（多一个能改投文件去向的旋钮）——测试手段
// 不该改产品。子进程继承 NODE_OPTIONS（dispatch 的 engine 透传 process.env），所以
// 父会话与孩子都会命中这里。
//
// ⚠ 为什么要 getter/setter + 看门狗：宿主启动时会**整段替换 globalThis.fetch**（代理版 fetch），
//   单纯的赋值包装会被覆盖掉 ⇒ 拦截失效、真官方被打到。用 getter/setter 装，宿主再赋值时
//   赋值被我们收下（当新底座），包装器始终在最外层。
//
// ⚠ 只在真机脚本的子进程 env 里注入；不进产品、不进发布物。
import { appendFileSync } from "node:fs";

const TARGET = "api.deepseek.com/v1/tools/ocr";
const loadFile = process.env.OCR_FAKE_LOAD_FILE;
const countFile = process.env.OCR_FAKE_COUNT_FILE;

const log = (line) => {
  if (!loadFile) return;
  try {
    appendFileSync(loadFile, line + "\n");
  } catch {
    // 日志写不进去不影响判据
  }
};

log(`pid=${process.pid} argv=${process.argv.slice(0, 3).join(" ")}`);

const fakeBody = JSON.stringify({ id: "ocr-fake", page_count: 1, pages: [{ index: 0, text: "" }] });

// 底座 fetch：宿主换实现时把它留作新底座（不吞掉它的行为，比如代理）
let base = globalThis.fetch;

const wrapper = async (input, init) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input ?? ""));
  if (!url.includes(TARGET)) return base(input, init);
  if (countFile) {
    try {
      appendFileSync(countFile, url + "\n");
    } catch {
      // 计数写不进去不该让被测进程炸掉——判据在脚本侧读文件
    }
  }
  return new Response(fakeBody, { status: 200, headers: { "content-type": "application/json" } });
};

const getter = () => wrapper;
const setter = (value) => {
  base = value;
};
const install = () =>
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    enumerable: false,
    get: getter,
    set: setter,
  });

install();

// 看门狗：宿主若整段重定义了 fetch（绕过 setter），把它包回来并留作新底座
const timer = setInterval(() => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  if (!desc || desc.get !== getter) {
    const current = globalThis.fetch;
    if (typeof current === "function" && current !== wrapper) base = current;
    install();
    log(`fetch 被整段重定义，已包回来 pid=${process.pid}`);
  }
}, 50);
timer.unref?.();

log(`fetch 已包装 pid=${process.pid}`);
