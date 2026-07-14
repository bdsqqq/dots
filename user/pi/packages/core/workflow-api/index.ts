export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type WorkflowAgent = "delegate" | "oracle" | "librarian" | "finder";

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: readonly string[];
  agents?: readonly WorkflowAgent[];
}

export interface DelegateInput {
  readonly prompt: string;
  readonly description: string;
  readonly continueId?: string;
  readonly leafId?: string;
}

export interface OracleInput {
  readonly task: string;
  readonly context?: string;
  readonly files?: readonly string[];
}

export interface LibrarianInput {
  readonly query: string;
  readonly context?: string;
}

export interface FinderInput {
  readonly query: string;
}

export interface WorkflowRecipe<
  Result = string,
  Agent extends WorkflowAgent = WorkflowAgent,
  Input = unknown,
> {
  readonly kind: Agent;
  readonly input: Input;
  readonly __result?: Result;
}

export interface WorkflowAgentOptions {
  label?: string;
}

type PhaseName<Meta extends WorkflowMeta> =
  Meta["phases"] extends readonly (infer Name extends string)[] ? Name : never;

type DeclaredAgent<Meta extends WorkflowMeta> =
  Meta["agents"] extends readonly (infer Agent extends WorkflowAgent)[]
    ? Agent
    : never;

type WorkflowValue = JsonValue | undefined;
type MaybePromise<Value> = Value | Promise<Value>;
type TaskResult<Task> = Task extends (...args: never[]) => infer Result
  ? Awaited<Result>
  : never;

export interface WorkflowContext<Meta extends WorkflowMeta> {
  agent<Result, Agent extends DeclaredAgent<Meta>>(
    recipe: WorkflowRecipe<Result, Agent>,
    options?: WorkflowAgentOptions,
  ): Promise<Result>;
  phase<Name extends PhaseName<Meta>>(name: Name): void;
  phase<Name extends PhaseName<Meta>, Result extends WorkflowValue>(
    name: Name,
    run: () => MaybePromise<Result>,
  ): Promise<Awaited<Result>>;
  parallel<const Tasks extends readonly (() => MaybePromise<WorkflowValue>)[]>(
    tasks: Tasks,
  ): Promise<{ [Index in keyof Tasks]: TaskResult<Tasks[Index]> }>;
  pipeline<Item, A extends WorkflowValue>(
    items: readonly Item[],
    first: (item: Item, index: number) => MaybePromise<A>,
  ): Promise<Awaited<A>[]>;
  pipeline<Item, A extends WorkflowValue, B extends WorkflowValue>(
    items: readonly Item[],
    first: (item: Item, index: number) => MaybePromise<A>,
    second: (item: Awaited<A>, index: number) => MaybePromise<B>,
  ): Promise<Awaited<B>[]>;
  pipeline<
    Item,
    A extends WorkflowValue,
    B extends WorkflowValue,
    C extends WorkflowValue,
  >(
    items: readonly Item[],
    first: (item: Item, index: number) => MaybePromise<A>,
    second: (item: Awaited<A>, index: number) => MaybePromise<B>,
    third: (item: Awaited<B>, index: number) => MaybePromise<C>,
  ): Promise<Awaited<C>[]>;
  pipeline<
    Item,
    A extends WorkflowValue,
    B extends WorkflowValue,
    C extends WorkflowValue,
    D extends WorkflowValue,
  >(
    items: readonly Item[],
    first: (item: Item, index: number) => MaybePromise<A>,
    second: (item: Awaited<A>, index: number) => MaybePromise<B>,
    third: (item: Awaited<B>, index: number) => MaybePromise<C>,
    fourth: (item: Awaited<C>, index: number) => MaybePromise<D>,
  ): Promise<Awaited<D>[]>;
}

export interface WorkflowDefinition<
  Meta extends WorkflowMeta = WorkflowMeta,
  Args = unknown,
  Result extends JsonValue | undefined = JsonValue | undefined,
> {
  readonly meta: Meta;
  readonly parseArgs?: (args: unknown) => Args;
  readonly run: (
    context: WorkflowContext<Meta>,
    args: Args,
  ) => Result | Promise<Result>;
}

interface WorkflowOptions<
  Meta extends WorkflowMeta,
  Args extends WorkflowValue,
  Result extends WorkflowValue,
> {
  parseArgs: (args: unknown) => Args;
  run: WorkflowDefinition<Meta, Args, Result>["run"];
}

interface UnknownArgsWorkflowOptions<
  Meta extends WorkflowMeta,
  Result extends WorkflowValue,
> {
  parseArgs?: undefined;
  run: WorkflowDefinition<Meta, unknown, Result>["run"];
}

function frozenInput<Input extends object>(input: Input): Readonly<Input> {
  const copy = { ...input } as Input;
  for (const [key, value] of Object.entries(copy)) {
    if (Array.isArray(value))
      (copy as Record<string, unknown>)[key] = Object.freeze([...value]);
  }
  return Object.freeze(copy);
}

function recipe<Agent extends WorkflowAgent, Input extends object>(
  kind: Agent,
  input: Input,
): WorkflowRecipe<string, Agent, Readonly<Input>> {
  return Object.freeze({ kind, input: frozenInput(input) });
}

export function delegate(
  input: DelegateInput,
): WorkflowRecipe<string, "delegate", DelegateInput> {
  return recipe("delegate", input);
}

export function oracle(
  input: OracleInput,
): WorkflowRecipe<string, "oracle", OracleInput> {
  return recipe("oracle", input);
}

export function librarian(
  input: LibrarianInput,
): WorkflowRecipe<string, "librarian", LibrarianInput> {
  return recipe("librarian", input);
}

export function finder(
  input: FinderInput,
): WorkflowRecipe<string, "finder", FinderInput> {
  return recipe("finder", input);
}

export function defineWorkflow<
  const Meta extends WorkflowMeta,
  Args extends WorkflowValue,
  Result extends WorkflowValue = WorkflowValue,
>(
  meta: Meta,
  options: WorkflowOptions<Meta, Args, Result>,
): WorkflowDefinition<Meta, Args, Result>;
export function defineWorkflow<
  const Meta extends WorkflowMeta,
  Result extends WorkflowValue = WorkflowValue,
>(
  meta: Meta,
  options: UnknownArgsWorkflowOptions<Meta, Result>,
): WorkflowDefinition<Meta, unknown, Result>;
export function defineWorkflow(
  meta: WorkflowMeta,
  options: {
    parseArgs?: (args: unknown) => unknown;
    run: WorkflowDefinition<WorkflowMeta>["run"];
  },
): WorkflowDefinition<WorkflowMeta> {
  const frozenMeta = Object.freeze({
    ...meta,
    ...(meta.phases ? { phases: Object.freeze([...meta.phases]) } : {}),
    ...(meta.agents ? { agents: Object.freeze([...meta.agents]) } : {}),
  });
  return Object.freeze({
    meta: frozenMeta,
    ...(options.parseArgs ? { parseArgs: options.parseArgs } : {}),
    run: options.run,
  });
}
