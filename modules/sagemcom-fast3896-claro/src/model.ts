import type { SagemcomXmoClient, RequestOptions } from "./client.ts";
import type { JsonObject, Reply } from "./protocol.ts";
import { isJson, ProtocolError, record } from "./protocol.ts";
import { catalog } from "./catalog.generated.ts";
import { schemaPath, validateFieldValue } from "./discovery.ts";
import type { SchemaNode } from "./discovery.ts";
import type {
  CanonicalPath,
  ModelPath,
  WritablePath,
  CommandPath,
  ModelValues,
  WritableValues,
  CommandInputs,
  CommandOutputs,
} from "./model.generated.ts";

type ModelValue<P extends ModelPath> = ModelValues[CanonicalPath<P> & keyof ModelValues];
type WriteValue<P extends WritablePath> = WritableValues[CanonicalPath<P> & keyof WritableValues];
type CommandInput<K extends CommandPath> = CommandInputs[CanonicalPath<K> & keyof CommandInputs];
type CommandOutput<K extends CommandPath> = CommandOutputs[CanonicalPath<K> & keyof CommandOutputs];

export interface CommandResult<T> {
  reply: Reply;
  outputs: T[];
}
/** No hidden discovery: this profile is supplied data, generated from the checked firmware inventory. */
export class Fast3896ClaroModel {
  readonly #client: SagemcomXmoClient;
  readonly #nodes = new Map(catalog.nodes.map((n) => [n.path, n]));
  constructor(client: SagemcomXmoClient) {
    this.#client = client;
  }
  get catalog() {
    return structuredClone(catalog);
  }
  #node(path: string): SchemaNode {
    const node = this.#nodes.get(schemaPath(path));
    if (!node)
      throw new TypeError("path is not in this firmware's catalog; use client.read for discovery");
    // Selected ancestors are mandatory for the singular typed API. Raw/readAll handles wildcards.
    for (const ancestor of node.selectors) {
      const segments = path.split("/");
      const count = ancestor.split("/").length;
      if (!segments[count - 1]?.includes("["))
        throw new TypeError("list-element path requires an explicit selector");
    }
    return node;
  }
  async get<P extends ModelPath>(path: P, options?: RequestOptions): Promise<ModelValue<P>> {
    const node = this.#node(path);
    const value = await this.#client.get(path, options);
    validateFieldValue(node, value);
    return value as ModelValue<P>;
  }
  async getAll<P extends ModelPath>(path: P, options?: RequestOptions): Promise<ModelValue<P>[]> {
    const node = this.#node(path);
    const results = await this.#client.readAll(path, undefined, options);
    return results.map((r) => {
      validateFieldValue(node, r.value);
      return r.value as ModelValue<P>;
    });
  }
  set<P extends WritablePath>(
    path: P,
    value: WriteValue<P>,
    options?: RequestOptions,
  ): Promise<Reply> {
    const node = this.#node(path);
    if (!node.flags.value || !node.flags.config)
      throw new TypeError("schema does not advertise a configurable value");
    if (!isJson(value)) throw new TypeError("value must be JSON");
    validateFieldValue(node, value);
    return this.#client.set(path, value, options);
  }
  async command<K extends CommandPath>(
    key: K,
    parameters: CommandInput<K>,
    options?: RequestOptions,
  ): Promise<CommandResult<CommandOutput<K>>> {
    const split = key.lastIndexOf("#");
    const path = key.slice(0, split),
      method = key.slice(split + 1);
    if (split < 1) throw new TypeError("command key needs path#method");
    const node = this.#node(path);
    const command = node.commands.find((c) => c.name === method);
    if (!command) throw new TypeError("command is not advertised at this path");
    if (!record(parameters) || !isJson(parameters))
      throw new TypeError("command parameters must be a JSON object");
    for (const [k, v] of Object.entries(parameters)) {
      const field = command.input.find((f) => f.name === k);
      if (!field) throw new TypeError("unknown command parameter");
      validateFieldValue(field, v);
    }
    const reply = await this.#client.call(path, method, parameters as JsonObject, options);
    const outputs: CommandOutput<K>[] = [];
    for (const callback of reply.actions.flatMap((a) => a.callbacks ?? [])) {
      const output: JsonObject = {};
      for (const field of command.output) {
        const value = callback.parameters?.[field.name];
        if (value === undefined) continue;
        if (!isJson(value)) throw new ProtocolError("non-JSON command output");
        validateFieldValue(field, value);
        Object.defineProperty(output, field.name, { value, enumerable: true });
      }
      outputs.push(output as CommandOutput<K>);
    }
    return { reply, outputs };
  }
}
