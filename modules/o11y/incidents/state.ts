import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface Observation {
  key: string;
  kind: string;
  host: string;
  mount?: string;
  status: "bad" | "healthy" | "unknown";
  critical?: boolean;
  observedAt: number;
  sampleAt?: number;
  detail: Record<string, string | number | boolean | null>;
}

export interface Transition {
  eventId: string;
  incidentId: string;
  action: "Open" | "Closed";
  key: string;
  kind: string;
  host: string;
  mount?: string;
  observedAt: number;
  sampleAt?: number;
  detail: Observation["detail"];
}

export interface IncidentStoreOptions {
  openAfterMs?: number;
  recoverAfterMs?: number;
  maxHealthyGapMs?: number;
  sourceMaxAgeMs?: number;
}

interface State {
  key: string;
  incidentId: string | null;
  lastObservedAt: number;
  lastSampleAt: number | null;
  openAt: number | null;
  openSampleAt: number | null;
  recoverAt: number | null;
  recoverSampleAt: number | null;
}

const applicationId = 0x494e4344;

export class IncidentStore {
  private db: DatabaseSync;
  private options: Required<IncidentStoreOptions>;

  constructor(filename: string, options: IncidentStoreOptions = {}) {
    this.options = {
      openAfterMs: 60_000, recoverAfterMs: 600_000,
      maxHealthyGapMs: 120_000, sourceMaxAgeMs: 300_000, ...options,
    };
    for (const value of Object.values(this.options)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid incident timing option");
    }
    const existed = filename !== ":memory:" && existsSync(filename);
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
      this.transaction(() => {
        const version = this.db.prepare("PRAGMA user_version").get()!.user_version;
        const identity = this.db.prepare("PRAGMA application_id").get()!.application_id;
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
        if (!existed && version === 0 && identity === 0 && tables.length === 0) {
          this.db.exec(`
            CREATE TABLE incidents (
              key TEXT PRIMARY KEY, incidentId TEXT, lastObservedAt INTEGER NOT NULL,
              lastSampleAt INTEGER, openAt INTEGER, openSampleAt INTEGER,
              recoverAt INTEGER, recoverSampleAt INTEGER
            ) STRICT;
            CREATE TABLE outbox (
              eventId TEXT PRIMARY KEY, incidentId TEXT NOT NULL,
              action TEXT NOT NULL CHECK(action IN ('Open', 'Closed')),
              delivery TEXT NOT NULL CHECK(delivery IN ('queued', 'uncertain', 'sent')),
              payload TEXT NOT NULL, attemptedAt INTEGER, checkedAt INTEGER, UNIQUE(incidentId, action)
            ) STRICT;
            PRAGMA application_id = ${applicationId}; PRAGMA user_version = 1;
          `);
        } else if (version !== 1 || identity !== applicationId) {
          throw new Error("unrecognized incident database schema");
        }
        if (this.db.prepare("PRAGMA quick_check").get()!.quick_check !== "ok") {
          throw new Error("corrupt incident database");
        }
        this.db.prepare("SELECT key, incidentId, lastObservedAt, lastSampleAt, openAt, openSampleAt, recoverAt, recoverSampleAt FROM incidents LIMIT 0").all();
        this.db.prepare("SELECT eventId, incidentId, action, delivery, payload, attemptedAt, checkedAt FROM outbox LIMIT 0").all();
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private read(observation: Observation): State | undefined {
    if (!Number.isSafeInteger(observation.observedAt)) throw new Error("invalid observedAt");
    return this.db.prepare("SELECT * FROM incidents WHERE key = ?").get(observation.key) as State | undefined;
  }

  private save(state: State): void {
    this.db.prepare(`INSERT INTO incidents VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        incidentId=excluded.incidentId, lastObservedAt=excluded.lastObservedAt,
        lastSampleAt=excluded.lastSampleAt, openAt=excluded.openAt,
        openSampleAt=excluded.openSampleAt, recoverAt=excluded.recoverAt,
        recoverSampleAt=excluded.recoverSampleAt`).run(
      state.key, state.incidentId, state.lastObservedAt, state.lastSampleAt,
      state.openAt, state.openSampleAt, state.recoverAt, state.recoverSampleAt,
    );
  }

  observe(observation: Observation): Transition | null {
    return this.transaction(() => {
      const previous = this.read(observation);
      if (previous && observation.observedAt <= previous.lastObservedAt) return null;
      const { observedAt, sampleAt } = observation;
      const state: State = previous ? { ...previous } : {
        key: observation.key, incidentId: null, lastObservedAt: observedAt,
        lastSampleAt: null, openAt: null, openSampleAt: null,
        recoverAt: null, recoverSampleAt: null,
      };
      const fresh = sampleAt !== undefined && Number.isSafeInteger(sampleAt)
        && sampleAt <= observedAt + 60_000 && observedAt - sampleAt <= this.options.sourceMaxAgeMs
        && (state.lastSampleAt === null || sampleAt >= state.lastSampleAt);
      const advancing = fresh && (state.lastSampleAt === null || sampleAt! > state.lastSampleAt);
      // Healthy always needs source evidence; invalid supplied timestamps are unknown.
      const status = (sampleAt === undefined && observation.status !== "healthy") || fresh
        ? observation.status : "unknown";
      let action: Transition["action"] | null = null;
      if (status === "unknown") {
        state.openAt = state.openSampleAt = state.recoverAt = state.recoverSampleAt = null;
      } else if (status === "bad") {
        state.recoverAt = state.recoverSampleAt = null;
        if (state.incidentId === null) {
          if (previous && observedAt - previous.lastObservedAt > this.options.maxHealthyGapMs) {
            state.openAt = state.openSampleAt = null;
          }
          if (observation.critical) action = "Open";
          else if (advancing) {
            state.openAt ??= observedAt;
            state.openSampleAt ??= sampleAt!;
            if (observedAt > state.openAt && sampleAt! > state.openSampleAt
              && observedAt - state.openAt >= this.options.openAfterMs
              && sampleAt! - state.openSampleAt >= this.options.openAfterMs) action = "Open";
          }
        }
      } else {
        state.openAt = state.openSampleAt = null;
        if (previous && observedAt - previous.lastObservedAt > this.options.maxHealthyGapMs) {
          state.recoverAt = state.recoverSampleAt = null;
        }
        if (state.incidentId !== null && advancing) {
          state.recoverAt ??= observedAt;
          state.recoverSampleAt ??= sampleAt!;
          // Neither fast evaluations nor fast source timestamps may shorten recovery.
          if (observedAt - state.recoverAt >= this.options.recoverAfterMs
            && sampleAt! - state.recoverSampleAt >= this.options.recoverAfterMs) action = "Closed";
        }
      }
      state.lastObservedAt = observedAt;
      if (fresh) state.lastSampleAt = sampleAt!;
      let transition: Transition | null = null;
      if (action) {
        if (action === "Open") state.incidentId = randomUUID();
        transition = {
          eventId: randomUUID(), incidentId: state.incidentId!, action,
          key: observation.key, kind: observation.kind, host: observation.host,
          ...(observation.mount === undefined ? {} : { mount: observation.mount }),
          observedAt, ...(sampleAt === undefined ? {} : { sampleAt }), detail: observation.detail,
        };
        this.db.prepare("INSERT INTO outbox (eventId, incidentId, action, delivery, payload) VALUES (?, ?, ?, 'queued', ?)").run(
          transition.eventId, transition.incidentId, action, JSON.stringify(transition),
        );
        if (action === "Closed") state.incidentId = null;
        state.openAt = state.openSampleAt = state.recoverAt = state.recoverSampleAt = null;
      }
      this.save(state);
      return transition;
    });
  }

  /** Bootstrap verified upstream opens once; an existing local row always wins. */
  seedOpen(observation: Observation): void {
    this.transaction(() => {
      if (this.read(observation)) return;
      this.save({
        key: observation.key, incidentId: randomUUID(), lastObservedAt: observation.observedAt,
        lastSampleAt: observation.sampleAt !== undefined && Number.isSafeInteger(observation.sampleAt)
          && observation.sampleAt <= observation.observedAt + 60_000
          && observation.observedAt - observation.sampleAt <= this.options.sourceMaxAgeMs
          ? observation.sampleAt : null,
        openAt: null, openSampleAt: null, recoverAt: null, recoverSampleAt: null,
      });
    });
  }

  private events(delivery: "queued" | "uncertain"): Transition[] {
    return this.db.prepare("SELECT payload FROM outbox WHERE delivery = ? ORDER BY CASE WHEN delivery = 'uncertain' THEN coalesce(checkedAt, 0) ELSE rowid END, rowid").all(delivery)
      .map(row => JSON.parse(row.payload as string) as Transition);
  }

  pending(): Transition[] { return this.events("queued"); }

  /** Claim before sending. A second claimant must not send the same event. */
  noteAttempt(eventId: string, now = Date.now()): void {
    const result = this.db.prepare("UPDATE outbox SET delivery = 'uncertain', attemptedAt = ? WHERE eventId = ? AND delivery = 'queued'").run(now, eventId);
    if (result.changes !== 1) throw new Error("event is missing or already attempted");
  }

  acknowledge(eventId: string): void {
    this.db.prepare("UPDATE outbox SET delivery = 'sent' WHERE eventId = ? AND delivery = 'uncertain'").run(eventId);
  }

  uncertain(): Transition[] { return this.events("uncertain"); }

  /** Rotate bounded reconciliation fairly, including across process restarts. */
  noteReconcile(eventId: string, now: number): void {
    this.db.prepare("UPDATE outbox SET checkedAt = ? WHERE eventId = ? AND delivery = 'uncertain'").run(now, eventId);
  }

  /** Conservative limits reserve room for two notifier deliveries per event. */
  deliveryBudget(now: number): number {
    const count = (since: number) => Number(this.db.prepare("SELECT count(*) AS n FROM outbox WHERE attemptedAt >= ?").get(since)!.n);
    return Math.max(0, Math.min(3 - count(now - 60_000), 200 - count(now - 86_400_000)));
  }

  overdue(now: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM outbox WHERE delivery != 'sent' AND coalesce(attemptedAt, json_extract(payload, '$.observedAt')) < ? LIMIT 1").get(now - 900_000);
  }

  close(): void { this.db.close(); }
}
