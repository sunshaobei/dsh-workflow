/** DSH can wrap tools in another transport. Commit only after every wrapper
 * succeeds, using execution identity for staging and tokens for parent links. */
export function submissionCommit(commit, onError) {
  const staged = new Map(),
    parents = new Map();
  return {
    stage(exec, value) {
      staged.set(exec, value);
    },
    result(exec, result) {
      const values = [
        ...(parents.get(exec.token) ?? []),
        ...(staged.has(exec) ? [staged.get(exec)] : []),
      ];
      staged.delete(exec);
      parents.delete(exec.token);
      if (result.isError || !values.length) return;
      if (exec.parent !== undefined)
        parents.set(exec.parent, [
          ...(parents.get(exec.parent) ?? []),
          ...values,
        ]);
      else
        for (const value of values)
          Promise.resolve()
            .then(() => commit(value))
            .catch(onError);
    },
    clear() {
      staged.clear();
      parents.clear();
    },
  };
}
