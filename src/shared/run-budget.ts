/**
 * What one invocation may still spend (ADR 0009). Workers Free allows 50 D1
 * queries per invocation, each statement in a batch counting, and 50
 * subrequests (Google and Telegram calls). A scheduled run checks its budget
 * before each unit of work and leaves what doesn't fit for the next minute;
 * the work is durable, so waiting loses nothing.
 */

export interface Cost {
  queries: number;
  calls: number;
}

/** Workers Free per-invocation limits. */
export const FREE_INVOCATION_LIMITS: Cost = { queries: 50, calls: 50 };

/**
 * Held back from every check, so the run can always record that it finished
 * (one query) and release what it claimed.
 */
export const RESERVE: Cost = { queries: 3, calls: 1 };

/**
 * The most each unit of work spends, measured in tests (`tests/jobs/run-budget.test.ts`)
 * with room to spare. A unit starts only if the budget still covers it.
 */
export const UNIT_COSTS = {
  /** One incoming update (a message or button press) and its reply. */
  inboxUpdate: { queries: 30, calls: 6 },
  /** One user's agenda, evening preview, and up to 8 due reminders. */
  reminderPass: { queries: 40, calls: 9 },
  /** One outgoing Telegram message. */
  delivery: { queries: 3, calls: 1 },
  /** One calendar write, with its verification read and a token refresh. */
  operation: { queries: 12, calls: 4 },
  /** Claiming a calendar to sync; each page is budgeted separately (`SYNC_PAGE_COST`). */
  syncClaim: { queries: 2, calls: 0 },
  /** One user's horizon (the events themselves are counted before writing). */
  horizon: { queries: 6, calls: 4 },
  /** One user's calendar list. */
  calendarList: { queries: 12, calls: 2 },
  /** Five-minute maintenance besides calendar lists and the command menu. */
  maintenance: { queries: 12, calls: 2 },
  /** The command menu check, and re-registering it when it changed. */
  commandMenu: { queries: 3, calls: 2 },
  /** Thirty-minute cleanup. */
  cleanup: { queries: 15, calls: 0 },
} as const satisfies Record<string, Cost>;

export class RunBudget {
  private queries = 0;
  private calls = 0;

  constructor(private readonly limits: Cost = FREE_INVOCATION_LIMITS) {}

  /** Counts every statement prepared through it: a batch counts each one. */
  wrapDb(db: D1Database): D1Database {
    return new Proxy(db, {
      get: (target, prop, receiver) => {
        if (prop === "prepare") {
          return (sql: string) => {
            this.queries++;
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Counts every outgoing request, including ones that fail. */
  wrapFetch(fetchImpl: typeof fetch): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      this.calls++;
      return fetchImpl(input, init);
    }) as typeof fetch;
  }

  used(): Cost {
    return { queries: this.queries, calls: this.calls };
  }

  /** Whether work costing up to this much still fits, keeping the reserve. */
  allows(cost: Partial<Cost>): boolean {
    return (
      this.queries + (cost.queries ?? 0) <= this.limits.queries - RESERVE.queries &&
      this.calls + (cost.calls ?? 0) <= this.limits.calls - RESERVE.calls
    );
  }

  /** Queries left for one unit after the reserve (never negative). */
  queriesLeft(): number {
    return Math.max(0, this.limits.queries - RESERVE.queries - this.queries);
  }
}

/** For work that is not budgeted (tests, and paths with their own bounds). */
export function fits(budget: RunBudget | undefined, cost: Partial<Cost>): boolean {
  return budget ? budget.allows(cost) : true;
}
