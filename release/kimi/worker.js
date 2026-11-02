import{stripTypeScriptTypes as e}from"node:module";import{parentPort as t,workerData as n}from"node:worker_threads";import r from"node:vm";function i(t){return`"use strict";\n${e(`async function __ptcProgram() {\n${t}\n}`,{mode:`strip`})}\n;globalThis.__ptcProgram = __ptcProgram;`}function a(e){let t=[],n=`run_code`,a=/* @__PURE__ */ new Map,o=1,s=null,c=[];e.onFrame(r=>{if(r.kind===`init`)t=r.bindingNames,n=r.surface,e.post({kind:`ready`});else if(r.kind===`reset`){s=null;for(let{reject:e}of a.values())e(/* @__PURE__ */ Error(`run reset：worker 被复用`));a=/* @__PURE__ */ new Map,e.post({kind:`ready`})}else if(r.kind===`result`){let e=a.get(r.callId);if(!e)return;if(a.delete(r.callId),r.ok){let t;try{t=JSON.stringify(r.value??null)}catch{t=void 0}t===void 0?e.reject(/* @__PURE__ */ Error(`binding 返回值不可 JSON 序列化（如循环引用）`)):e.resolve(t)}else e.reject(Error(r.error))}else r.kind!==`cancel`&&u(r.code,r.id,r.args)});function l(){return`"use strict";
(function () {
var __bridge = globalThis.__ptcCall;
var __emit = globalThis.__ptcConsole;
var __args = JSON.parse(globalThis.__ptcArgsJson);
// contextified 全局属性不可 delete（vm 限制）但可写——置 undefined 即脱手，桥只剩序言闭包可达
globalThis.__ptcCall = undefined;
globalThis.__ptcConsole = undefined;
globalThis.__ptcArgsJson = undefined;
function __ptcFmt(v) {
  if (typeof v === "string") return v;
  try { var s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
}
function __ptcJoin(values) {
  var out = [];
  for (var i = 0; i < values.length; i++) out.push(__ptcFmt(values[i]));
  return out.join(" ");
}
var __ptcTools = {};
__PTC_NAMES__.forEach(function (name) {
  __ptcTools[name] = function (args) {
    return new Promise(function (resolve, reject) {
      __bridge(name, JSON.stringify(args === undefined ? null : args)).then(function (json) {
        var value;
        try { value = JSON.parse(json); } catch (e) { reject(e); return; }
        resolve(value);
      }, reject);
    });
  };
});
globalThis.tools = Object.freeze(__ptcTools);
globalThis.console = Object.freeze({
  log: function () { __emit("log", __ptcJoin(arguments)); },
  info: function () { __emit("info", __ptcJoin(arguments)); },
  warn: function () { __emit("warn", __ptcJoin(arguments)); },
  error: function () { __emit("error", __ptcJoin(arguments)); },
  debug: function () { __emit("debug", __ptcJoin(arguments)); }
});
globalThis.args = Object.freeze(__args);
if (__PTC_WORKFLOW__) {
  globalThis.workflow = Object.freeze({
    log: function () { __emit("log", __ptcJoin(arguments)); },
    phase: function (name) { __emit("log", "— phase: " + name + " —"); },
    parallel: function (items) { return Promise.allSettled(items.map(function (run) { return run(); })); },
    pipeline: function (items, step) {
      var results = [];
      return items.reduce(function (chain, item, index) {
        return chain.then(function () { return Promise.resolve(step(item, index)).then(function (r) { results.push(r); }); });
      }, Promise.resolve()).then(function () { return results; });
    }
  });
}
})();
`.replace(/__PTC_NAMES__/g,()=>JSON.stringify(t)).replace(/__PTC_WORKFLOW__/g,()=>n===`workflow`?`true`:`false`)}async function u(t,n,i){s=n,c=[];let l=(t,r)=>{c.push(r),e.post({kind:`log`,runId:n,level:t,text:r})},u=await f(t,r.createContext({__ptcArgsJson:JSON.stringify(i??{}),__ptcCall(t,n){if(s===null)return Promise.reject(/* @__PURE__ */ Error(`run 已结束：reset 后不再接受工具调用`));let r=null;try{r=JSON.parse(n)}catch{return Promise.reject(/* @__PURE__ */ Error(`工具参数不是合法 JSON`))}let i=new Promise((n,i)=>{let c=o++;a.set(c,{resolve:n,reject:i}),e.post({kind:`call`,runId:s??``,callId:c,name:t,args:r})});return i.catch(()=>{}),i},__ptcConsole(e,t){l(e,String(t))}}));e.post({kind:`settled`,runId:n,outcome:u})}function d(e){return e instanceof Error||e&&typeof e==`object`&&typeof e.message==`string`?e.message:String(e)}async function f(e,t){try{r.runInContext(l(),t,{filename:`ptc_preamble.js`}),r.runInContext(i(e),t,{filename:`run_code.js`});let n=await t.__ptcProgram.call(t);if(n===void 0)return{status:`fulfilled`,value:{$void:!0},logs:c};let a=JSON.stringify(n);return a===void 0?{status:`rejected`,error:`程序返回值不可序列化`,logs:c}:{status:`fulfilled`,value:JSON.parse(a),logs:c}}catch(e){return{status:`rejected`,error:d(e),logs:c}}}}if(!t)throw Error(`worker-entry 只能在 worker 线程里加载`);Object.freeze(n),a({post:e=>t.postMessage(e),onFrame:e=>t.on(`message`,t=>e(t))});export{};
//# sourceMappingURL=worker.js.map