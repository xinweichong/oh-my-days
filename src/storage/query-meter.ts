/**
 * Counts the D1 statements prepared through a database handle. Workers Free
 * allows 50 D1 queries per invocation, and each statement in a batch counts,
 * so work that is optional in a request can check the meter first.
 */
export function meteredDb(db: D1Database): { db: D1Database; used: () => number } {
  let count = 0;
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          count++;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: wrapped, used: () => count };
}
