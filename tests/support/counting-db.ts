/**
 * Wraps a D1 database and records the SQL of every prepared statement, so
 * tests can count the queries a piece of work issues.
 */
export function countingDb(db: D1Database): { db: D1Database; queries: string[] } {
  const queries: string[] = [];
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          queries.push(sql.replace(/\s+/g, " ").trim());
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: wrapped, queries };
}
