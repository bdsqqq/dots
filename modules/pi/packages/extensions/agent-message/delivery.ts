/**
 * when agent mail is shown, starts a run, or waits. kept free of pi and the
 * filesystem so the model checker below drives these exact functions through
 * every interleaving of pi's run and settle lifecycle.
 */

export interface Mail {
  readonly id: string;
}

export interface Mailbox<T extends Mail> {
  /** mailbox files whose id is not in the transcript, oldest first. */
  readonly unacked: readonly T[];
  /** mail ids already in the transcript. */
  readonly persisted: ReadonlySet<string>;
}

export type ReadMailbox<T extends Mail> = () => Mailbox<T>;

/**
 * - `closed`: no session.
 * - `grace`: pi rejects a host's startup prompt while a run is active, so
 *   wakes hold mail until the grace ends or a run settles.
 * - `stopped`: the user aborted. wakes show mail without a run, since
 *   starting one would undo their stop. pi gives extensions no signal for
 *   when its other settle handlers finish, so this lasts until the next run
 *   or a window meant to outlast them; a handler slower than the window
 *   gets main's earlier behavior, where mail could start a run.
 * - `open`: wakes start a run.
 */
export type Phase = "closed" | "grace" | "stopped" | "open";

export interface DeliveryState {
  readonly phase: Phase;
  /**
   * run starters not yet persisted: pi defers runs started during
   * settlement, and wakes must not send those again meanwhile.
   */
  readonly starting: ReadonlySet<string>;
}

export interface Delivery<T extends Mail> {
  readonly state: DeliveryState;
  /** append without starting a run. */
  readonly append: readonly T[];
  /** append and start one run. */
  readonly start?: T;
  readonly error?: unknown;
}

export const closedDelivery: DeliveryState = {
  phase: "closed",
  starting: new Set(),
};

type Action = "hold" | "show" | "start";

const wakeAction: Record<Phase, Action> = {
  closed: "hold",
  grace: "hold",
  stopped: "show",
  open: "start",
};

function unacked<T extends Mail>(
  state: DeliveryState,
  read: ReadMailbox<T>,
): { starting: Set<string>; mail: T[] } {
  const mailbox = read();
  const starting = new Set(
    [...state.starting].filter((id) => !mailbox.persisted.has(id)),
  );
  return {
    starting,
    mail: mailbox.unacked.filter((message) => !starting.has(message.id)),
  };
}

function deliverIdle<T extends Mail>(
  state: DeliveryState,
  idle: boolean,
  action: Action,
  read: ReadMailbox<T>,
): Delivery<T> {
  if (state.phase === "closed" || !idle || action === "hold")
    return { state, append: [] };
  try {
    const { starting, mail } = unacked(state, read);
    // one run per batch: only the last message starts it.
    const start = action === "start" ? mail.pop() : undefined;
    if (start) starting.add(start.id);
    return { state: { ...state, starting }, append: mail, start };
  } catch (error) {
    return { state, append: [], error };
  }
}

/** mail waiting at startup is context for whatever the user does next. */
export function sessionStarted<T extends Mail>(
  idle: boolean,
  read: ReadMailbox<T>,
): Delivery<T> {
  return deliverIdle(
    { phase: "grace", starting: new Set() },
    idle,
    "show",
    read,
  );
}

/** the startup grace or stop window ran out. */
export function windowEnded<T extends Mail>(
  state: DeliveryState,
  idle: boolean,
  read: ReadMailbox<T>,
): Delivery<T> {
  const phase: Phase =
    state.phase === "grace" || state.phase === "stopped" ? "open" : state.phase;
  return deliverIdle({ ...state, phase }, idle, wakeAction[phase], read);
}

/** a watcher event or poll. */
export function woke<T extends Mail>(
  state: DeliveryState,
  idle: boolean,
  read: ReadMailbox<T>,
): Delivery<T> {
  return deliverIdle(state, idle, wakeAction[state.phase], read);
}

/**
 * pi runs a deferred starter after anything queued ahead of it, so the user
 * may have stopped a run in between. false: abort the run before its first
 * request; the mail is still shown. before_agent_start is the earliest hook,
 * and pi may compact first.
 */
export function starterMayRun(state: DeliveryState): boolean {
  return state.phase === "open";
}

export function agentStarted(state: DeliveryState): DeliveryState {
  const phase: Phase = state.phase === "stopped" ? "open" : state.phase;
  return { ...state, phase };
}

/** pi won't continue past an error or abort, so only completed turns take mail. */
export function turnEnded<T extends Mail>(
  state: DeliveryState,
  completed: boolean,
  read: ReadMailbox<T>,
): Delivery<T> {
  if (!completed || state.phase === "closed") return { state, append: [] };
  try {
    const { starting, mail } = unacked(state, read);
    return { state: { ...state, starting }, append: mail };
  } catch (error) {
    return { state, append: [], error };
  }
}

/** a settled run leaves no startup prompt to protect. */
export function agentSettled<T extends Mail>(
  state: DeliveryState,
  aborted: boolean,
  idle: boolean,
  read: ReadMailbox<T>,
): Delivery<T> {
  const phase: Phase =
    state.phase === "closed" ? "closed" : aborted ? "stopped" : "open";
  return deliverIdle({ ...state, phase }, idle, wakeAction[phase], read);
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  /**
   * pi's run lifecycle as agent-session.js implements it: isIdle() is true
   * once a run ends, before any agent_settled handler runs; a run started
   * during settlement is deferred until every handler returns; pi then
   * starts the next deferred action synchronously, so nothing interleaves
   * before it, and the rest follow that run's own settlement; a triggered
   * send while streaming becomes a steer.
   */
  type Settling = { stage: "before" | "ours" | "after"; aborted: boolean };
  type Deferred = { kind: "mail"; id: string } | { kind: "prompt" };

  interface World {
    ext: DeliveryState;
    runActive: boolean;
    turns: number;
    settling?: Settling;
    deferred: Deferred[];
    draining: Deferred[];
    posted: string[];
    transcript: string[];
    /** awaiting the host's startup prompt; pi rejects it while a run is active. */
    hostPromptPending: boolean;
    /** ids present when the user stopped a run, until they prompt again. */
    stopped?: string[];
    budget: { posts: number; aborts: number; prompts: number; turns: number };
  }

  interface Variant {
    sessionStarted: typeof sessionStarted;
    windowEnded: typeof windowEnded;
    woke: typeof woke;
    agentStarted: typeof agentStarted;
    starterMayRun: typeof starterMayRun;
    turnEnded: typeof turnEnded;
    agentSettled: typeof agentSettled;
  }

  const real: Variant = {
    sessionStarted,
    windowEnded,
    woke,
    agentStarted,
    starterMayRun,
    turnEnded,
    agentSettled,
  };

  class Violation extends Error {}

  const read =
    (w: World): ReadMailbox<Mail> =>
    () => ({
      unacked: w.posted
        .filter((id) => !w.transcript.includes(id))
        .map((id) => ({ id })),
      persisted: new Set(w.transcript),
    });

  function persist(w: World, id: string): void {
    if (w.transcript.includes(id)) throw new Violation(`${id} delivered twice`);
    w.transcript.push(id);
  }

  function startRun(w: World, v: Variant, starter?: string): void {
    const aborted = starter !== undefined && !v.starterMayRun(w.ext);
    if (starter && !aborted && w.stopped?.includes(starter))
      throw new Violation(`${starter} started a run the user had stopped`);
    w.runActive = true;
    w.turns = 0;
    w.ext = v.agentStarted(w.ext);
    if (starter) persist(w, starter);
    if (aborted) endRun(w, true);
  }

  function apply(w: World, v: Variant, d: Delivery<Mail>): void {
    w.ext = d.state;
    for (const m of d.append) {
      if (w.runActive) throw new Violation(`${m.id} appended mid-turn`);
      persist(w, m.id);
    }
    if (!d.start) return;
    if (w.runActive)
      throw new Violation(`${d.start.id} entered pi's steering queue`);
    if (w.settling) w.deferred.push({ kind: "mail", id: d.start.id });
    else startRun(w, v, d.start.id);
  }

  const idle = (w: World) => !w.runActive;

  function userPrompt(w: World, v: Variant): void {
    if (w.hostPromptPending && w.runActive)
      throw new Violation("mail made pi reject the startup prompt");
    w.hostPromptPending = false;
    w.stopped = undefined;
    if (w.settling) w.deferred.push({ kind: "prompt" });
    else startRun(w, v);
  }

  function endRun(w: World, aborted: boolean): void {
    w.runActive = false;
    w.settling = { stage: "before", aborted };
  }

  type Step = { label: string; run: (w: World, v: Variant) => void };

  function steps(w: World): Step[] {
    const out: Step[] = [
      {
        label: "wake",
        run: (w, v) => {
          const d = v.woke(w.ext, idle(w), read(w));
          apply(w, v, d);
          // a stopped user still sees mail as it arrives.
          if (d.state.phase === "stopped" && idle(w)) {
            const hidden = read(w)().unacked.filter(
              (m) => !d.state.starting.has(m.id),
            );
            if (hidden.length)
              throw new Violation(
                `${hidden[0]!.id} hidden from a stopped session`,
              );
          }
        },
      },
    ];
    // the windows are timed to outlast the host's startup prompt and pi's
    // settle handlers; that timing is an assumption, not something checked.
    if (
      (w.ext.phase === "grace" && !w.hostPromptPending) ||
      (w.ext.phase === "stopped" && !w.settling)
    )
      out.push({
        label: `${w.ext.phase} window ends`,
        run: (w, v) => {
          w.stopped = undefined;
          apply(w, v, v.windowEnded(w.ext, idle(w), read(w)));
        },
      });
    if (w.budget.posts > 0)
      out.push({
        label: "post",
        run: (w) => {
          const id = `m${w.posted.length}`;
          w.posted.push(id);
          w.budget.posts--;
          w.stopped?.push(id);
        },
      });
    // the host submits its startup prompt whenever startup finishes.
    if (w.hostPromptPending)
      out.push({
        label: "host has no startup prompt",
        run: (w) => {
          w.hostPromptPending = false;
        },
      });
    if (w.budget.prompts > 0 && (w.hostPromptPending || !w.runActive))
      out.push({
        label: "user prompts",
        run: (w, v) => {
          w.budget.prompts--;
          userPrompt(w, v);
        },
      });
    if (w.runActive) {
      if (w.budget.aborts > 0)
        out.push({
          label: "user aborts",
          run: (w) => {
            w.budget.aborts--;
            w.stopped = [...w.posted];
            endRun(w, true);
          },
        });
      for (const completed of [true, false])
        for (const more of completed && w.turns < w.budget.turns
          ? [true, false]
          : [false])
          out.push({
            label: `turn ${completed ? "completes" : "errors"}${more ? ", model continues" : ""}`,
            run: (w, v) => {
              const d = v.turnEnded(w.ext, completed, read(w));
              w.ext = d.state;
              for (const m of d.append) persist(w, m.id);
              w.turns++;
              if (!more && d.append.length === 0) endRun(w, false);
            },
          });
    }
    const settling = w.settling;
    if (settling)
      out.push({
        label: `settle handler ${settling.stage}`,
        run: (w, v) => {
          if (settling.stage === "before")
            w.settling = { ...settling, stage: "ours" };
          else if (settling.stage === "ours") {
            apply(
              w,
              v,
              v.agentSettled(w.ext, settling.aborted, idle(w), read(w)),
            );
            w.settling = { ...settling, stage: "after" };
          } else {
            w.settling = undefined;
            w.draining = [...w.deferred.splice(0), ...w.draining];
            const action = w.draining.shift();
            if (action?.kind === "prompt") userPrompt(w, v);
            else if (action) startRun(w, v, action.id);
          }
        },
      });
    return out;
  }

  /** every message ends up in the transcript once nothing else can happen. */
  function quiesce(w: World, v: Variant): void {
    if (w.runActive || w.settling || w.ext.phase !== "open") return;
    apply(w, v, v.woke(w.ext, idle(w), read(w)));
    for (;;) {
      if (w.runActive) endRun(w, false);
      const next = steps(w).find((s) => s.label.startsWith("settle"));
      if (!next) break;
      next.run(w, v);
    }
    const lost = w.posted.filter((id) => !w.transcript.includes(id));
    if (lost.length) throw new Violation(`${lost.join(", ")} never delivered`);
  }

  const clone = (w: World): World => ({
    ...w,
    ext: { ...w.ext, starting: new Set(w.ext.starting) },
    deferred: [...w.deferred],
    draining: [...w.draining],
    posted: [...w.posted],
    transcript: [...w.transcript],
    stopped: w.stopped && [...w.stopped],
    budget: { ...w.budget },
  });

  const key = (w: World) =>
    JSON.stringify({
      ...w,
      ext: { ...w.ext, starting: [...w.ext.starting].sort() },
    });

  /** breadth-first, so a counterexample is a shortest trace. */
  function check(
    v: Variant,
    budget: World["budget"],
  ): { states: number; trace?: string[]; error?: string } {
    const initial: World = {
      ext: closedDelivery,
      runActive: false,
      turns: 0,
      deferred: [],
      draining: [],
      posted: [],
      transcript: [],
      hostPromptPending: true,
      budget: { ...budget },
    };
    const seen = new Set<string>();
    const queue: { world: World; trace: string[] }[] = [];
    for (const backlog of [0, 1]) {
      const w = clone(initial);
      for (let i = 0; i < backlog; i++) {
        w.posted.push(`m${w.posted.length}`);
        w.budget.posts--;
      }
      const trace = backlog ? ["post", "session starts"] : ["session starts"];
      try {
        apply(w, v, v.sessionStarted(idle(w), read(w)));
      } catch (error) {
        return { states: 0, trace, error: String(error) };
      }
      queue.push({ world: w, trace });
    }
    while (queue.length) {
      const { world, trace } = queue.shift()!;
      const k = key(world);
      if (seen.has(k)) continue;
      seen.add(k);
      try {
        quiesce(clone(world), v);
      } catch (error) {
        if (!(error instanceof Violation)) throw error;
        return {
          states: seen.size,
          trace: [...trace, "(quiesce)"],
          error: error.message,
        };
      }
      for (const step of steps(world)) {
        const next = clone(world);
        try {
          step.run(next, v);
        } catch (error) {
          if (!(error instanceof Violation)) throw error;
          return {
            states: seen.size,
            trace: [...trace, step.label],
            error: error.message,
          };
        }
        queue.push({ world: next, trace: [...trace, step.label] });
      }
    }
    return { states: seen.size };
  }

  const BUDGET = { posts: 3, aborts: 1, prompts: 2, turns: 2 };

  /** each removes the guard a past fix added; the checker must reject it. */
  const pastBugs: [string, string, Variant][] = [
    [
      "20db80d7",
      "re-sending on abort restarted the run",
      {
        ...real,
        agentSettled: (s, _aborted, i, r) => agentSettled(s, false, i, r),
      },
    ],
    [
      "91e48854",
      "mail arriving at startup raced the first prompt, which pi rejected as busy",
      {
        ...real,
        sessionStarted: (i, r) => windowEnded(sessionStarted(i, r).state, i, r),
      },
    ],
    [
      "d05119cf",
      "a run started for mail the user had just stopped",
      { ...real, starterMayRun: () => true },
    ],
    [
      "2b1e11db",
      "a starter deferred by settlement was sent again by the watcher",
      {
        ...real,
        woke: (s, i, r) => woke({ ...s, starting: new Set() }, i, r),
      },
    ],
  ];

  describe("agent-message delivery model", () => {
    it("holds every invariant across all bounded interleavings", () => {
      const result = check(real, BUDGET);
      expect(result.error, result.trace?.join(" → ")).toBeUndefined();
      expect(result.states).toBeGreaterThan(1_000);
    });

    it.each(pastBugs)("replays %s: %s", (_commit, _bug, variant) => {
      expect(check(variant, BUDGET).error).toBeDefined();
    });
  });
}
