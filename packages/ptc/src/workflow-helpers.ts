// workflow 面（旧 ADR-0017）：程序内辅助函数。log/phase 是运行作用域的，由 worker 注入；parallel/pipeline 是纯组合子
export interface WorkflowHelpers {
  log: (...args: unknown[]) => void;
  phase: (name: string) => void;
  parallel: <T>(items: readonly (() => Promise<T>)[]) => Promise<T[]>;
  pipeline: <A, B>(
    items: readonly A[],
    step: (item: A, index: number) => Promise<B>,
  ) => Promise<B[]>;
}

export function createWorkflowHelpers(emit: (text: string) => void): WorkflowHelpers {
  return {
    log: (...args) =>
      emit(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
    phase: (name) => emit(`— phase: ${name} —`),
    parallel: (items) => Promise.all(items.map((run) => run())),
    pipeline: (items, step) => {
      const results: unknown[] = [];
      return items
        .reduce(
          (chain, item, index) =>
            chain.then(async () => {
              results.push(await step(item, index));
            }),
          Promise.resolve(),
        )
        .then(() => results as never);
    },
  };
}
