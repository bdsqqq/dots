import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { WorkflowAgent, WorkflowMeta } from "@bds_pi/workflow-api";

const WORKFLOW_MODULE = "@bds_pi/workflow";
const API_CANDIDATES = [
  new URL("../../core/workflow-api/index.ts", import.meta.url),
  new URL("../core/workflow-api.d.ts", import.meta.url),
  new URL("./core/workflow-api.d.ts", import.meta.url),
];
const API_URL = API_CANDIDATES.find((candidate) =>
  existsSync(fileURLToPath(candidate)),
);
if (!API_URL)
  throw new Error("workflow authoring API declarations are missing");
const API_PATH = fileURLToPath(API_URL);
const API_SOURCE = readFileSync(API_PATH, "utf8");
const MAX_DECLARED_PHASES = 64;
const MAX_PHASE_NAME_BYTES = 256;
const AGENTS = new Set<WorkflowAgent>([
  "delegate",
  "oracle",
  "librarian",
  "finder",
  "codeReview",
  "lookAt",
  "readSession",
  "readWebPage",
]);

export interface CompiledWorkflowMeta {
  name: string;
  description: string;
  phases?: string[];
  agents?: WorkflowAgent[];
}

export interface CompiledWorkflow {
  code: string;
  meta: CompiledWorkflowMeta;
  hash: string;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  )
    expression = expression.expression;
  return expression;
}

function staticString(expression: ts.Expression, field: string): string {
  const value = unwrapExpression(expression);
  if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value))
    throw new Error(`workflow meta.${field} must be a static string`);
  return value.text;
}

function staticStringArray(expression: ts.Expression, field: string): string[] {
  const value = unwrapExpression(expression);
  if (!ts.isArrayLiteralExpression(value))
    throw new Error(`workflow meta.${field} must be a static string array`);
  return value.elements.map((element) => {
    if (ts.isSpreadElement(element))
      throw new Error(`workflow meta.${field} must be a static string array`);
    return staticString(element, field);
  });
}

function propertyName(property: ts.ObjectLiteralElementLike): string {
  if (!ts.isPropertyAssignment(property) || property.name === undefined)
    throw new Error("workflow meta must contain only static properties");
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    return property.name.text;
  throw new Error("workflow meta keys must be static identifiers or strings");
}

function extractMeta(sourceFile: ts.SourceFile): CompiledWorkflowMeta {
  let initializer: ts.Expression | undefined;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported || !(statement.declarationList.flags & ts.NodeFlags.Const))
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "meta"
      ) {
        if (initializer)
          throw new Error("workflow must export meta exactly once");
        initializer = declaration.initializer;
      }
    }
  }
  if (!initializer)
    throw new Error("workflow must export const meta as a static object");
  const expression = unwrapExpression(initializer);
  if (!ts.isObjectLiteralExpression(expression))
    throw new Error("workflow meta must be a static object literal");

  const values = new Map<string, ts.Expression>();
  for (const property of expression.properties) {
    const name = propertyName(property);
    if (!new Set(["name", "description", "phases", "agents"]).has(name))
      throw new Error(`unknown workflow meta field: ${name}`);
    if (values.has(name))
      throw new Error(`duplicate workflow meta field: ${name}`);
    if (!ts.isPropertyAssignment(property))
      throw new Error("workflow meta must contain only static properties");
    values.set(name, property.initializer);
  }

  const nameExpression = values.get("name");
  const descriptionExpression = values.get("description");
  if (!nameExpression || !descriptionExpression)
    throw new Error("workflow meta requires name and description");
  const name = staticString(nameExpression, "name");
  const description = staticString(descriptionExpression, "description");
  if (name.trim() === "")
    throw new Error("workflow meta.name must be a non-empty string");
  if (description.trim() === "")
    throw new Error("workflow meta.description must be a non-empty string");

  const phasesExpression = values.get("phases");
  const phases = phasesExpression
    ? staticStringArray(phasesExpression, "phases")
    : undefined;
  if (phases && phases.length > MAX_DECLARED_PHASES)
    throw new Error(
      `workflow meta.phases supports at most ${MAX_DECLARED_PHASES} entries`,
    );
  if (
    phases?.some(
      (phase) =>
        phase.trim() === "" ||
        Buffer.byteLength(phase, "utf8") > MAX_PHASE_NAME_BYTES,
    )
  )
    throw new Error(
      `workflow phase names must be non-empty and at most ${MAX_PHASE_NAME_BYTES} UTF-8 bytes`,
    );

  const agentsExpression = values.get("agents");
  const agents = agentsExpression
    ? staticStringArray(agentsExpression, "agents")
    : undefined;
  const invalidAgent = agents?.find(
    (agent): agent is string => !AGENTS.has(agent as WorkflowAgent),
  );
  if (invalidAgent)
    throw new Error(`unknown workflow agent in meta.agents: ${invalidAgent}`);

  return {
    name,
    description,
    ...(phases ? { phases } : {}),
    ...(agents ? { agents: agents as WorkflowAgent[] } : {}),
  };
}

function validateImportsAndAgents(
  sourceFile: ts.SourceFile,
  meta: WorkflowMeta,
): void {
  const recipeImports = new Map<string, WorkflowAgent>();
  const defineWorkflowImports = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== WORKFLOW_MODULE
    )
      throw new Error(
        `workflow imports may only come from '${WORKFLOW_MODULE}'`,
      );
    const bindings = statement.importClause?.namedBindings;
    if (bindings && !ts.isNamedImports(bindings))
      throw new Error("workflow imports must use named imports");
    if (bindings) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (AGENTS.has(imported as WorkflowAgent))
          recipeImports.set(element.name.text, imported as WorkflowAgent);
        if (imported === "defineWorkflow")
          defineWorkflowImports.add(element.name.text);
      }
    }
  }

  const defaultExport = sourceFile.statements.find(
    (statement): statement is ts.ExportAssignment =>
      ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  const defaultExpression = defaultExport
    ? unwrapExpression(defaultExport.expression)
    : undefined;
  const firstArgument =
    defaultExpression && ts.isCallExpression(defaultExpression)
      ? defaultExpression.arguments[0]
      : undefined;
  if (
    !defaultExpression ||
    !ts.isCallExpression(defaultExpression) ||
    !ts.isIdentifier(defaultExpression.expression) ||
    !defineWorkflowImports.has(defaultExpression.expression.text) ||
    !firstArgument ||
    !ts.isIdentifier(firstArgument) ||
    firstArgument.text !== "meta"
  )
    throw new Error(
      "workflow default export must be defineWorkflow(meta, { ... })",
    );

  const declared = new Set(meta.agents ?? []);
  const visit = (node: ts.Node): void => {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      (!ts.isStringLiteral(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== WORKFLOW_MODULE)
    )
      throw new Error(
        `workflow imports may only come from '${WORKFLOW_MODULE}'`,
      );
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        throw new Error(
          `workflow imports may only come from '${WORKFLOW_MODULE}'`,
        );
      if (ts.isIdentifier(node.expression)) {
        const agent = recipeImports.get(node.expression.text);
        if (agent && !declared.has(agent))
          throw new Error(
            `workflow uses undeclared ${agent} recipe; add it to meta.agents`,
          );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function diagnosticsMessage(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        "\n",
      );
      if (!diagnostic.file || diagnostic.start === undefined) return message;
      const position = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start,
      );
      return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} - ${message}`;
    })
    .join("\n");
}

export function compileWorkflowSource(
  source: string,
  filename = "inline-workflow.ts",
): CompiledWorkflow {
  const sourcePath = filename.endsWith(".ts") ? filename : `${filename}.ts`;
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const meta = extractMeta(sourceFile);
  validateImportsAndAgents(sourceFile, meta);

  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    strict: true,
    noEmitOnError: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (requested, languageVersion, onError, shouldCreate) => {
    if (requested === sourcePath)
      return ts.createSourceFile(
        requested,
        source,
        languageVersion,
        true,
        ts.ScriptKind.TS,
      );
    if (requested === API_PATH)
      return ts.createSourceFile(
        requested,
        API_SOURCE,
        languageVersion,
        true,
        ts.ScriptKind.TS,
      );
    return originalGetSourceFile(
      requested,
      languageVersion,
      onError,
      shouldCreate,
    );
  };
  host.fileExists = (
    (original) => (requested: string) =>
      requested === sourcePath || requested === API_PATH || original(requested)
  )(host.fileExists.bind(host));
  host.readFile = (
    (original) => (requested: string) =>
      requested === sourcePath
        ? source
        : requested === API_PATH
          ? API_SOURCE
          : original(requested)
  )(host.readFile.bind(host));
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) =>
      name === WORKFLOW_MODULE
        ? {
            resolvedFileName: API_PATH,
            extension: API_PATH.endsWith(".d.ts")
              ? ts.Extension.Dts
              : ts.Extension.Ts,
            isExternalLibraryImport: true,
          }
        : ts.resolveModuleName(name, containingFile, options, host)
            .resolvedModule,
    );

  let code: string | undefined;
  host.writeFile = (emittedFilename, text, _bom, _onError, sourceFiles) => {
    if (
      emittedFilename.endsWith(".js") &&
      sourceFiles?.some((file) => file.fileName === sourcePath)
    )
      code = text;
  };
  const program = ts.createProgram([sourcePath], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) throw new Error(diagnosticsMessage(diagnostics));
  const result = program.emit();
  if (result.emitSkipped || !code)
    throw new Error(
      diagnosticsMessage(result.diagnostics) ||
        "workflow compilation emitted no code",
    );
  return {
    code,
    meta,
    hash: createHash("sha256").update(source).digest("hex"),
  };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const compile = (body: string) =>
    compileWorkflowSource(body, "/tmp/workflow.ts");

  describe("workflow compiler", () => {
    it("type-checks and emits a valid workflow as CommonJS ES2022", () => {
      const result = compile(`
        import { defineWorkflow, delegate, finder, oracle } from "@bds_pi/workflow";
        import type { WorkflowMeta } from "@bds_pi/workflow";
        export const meta = {
          name: "research",
          description: "research a topic",
          phases: ["inspect"] as const,
          agents: ["delegate", "finder", "oracle"] as const,
        } satisfies WorkflowMeta;
        export default defineWorkflow(meta, {
          parseArgs(value) {
            return { topic: String(value) };
          },
          async run({ agent, parallel, phase }, args) {
            return phase("inspect", async () => {
              const finderQuery: string = finder({ query: args.topic }).input.query;
              const results = await parallel([
                () => agent(delegate({ prompt: finderQuery, description: "inspect" })),
                () => agent(oracle({ task: args.topic, files: ["api.ts"] })),
              ] as const);
              const tuple: readonly [string, string] = results;
              return tuple;
            });
          },
        });
      `);
      expect(result.meta.phases).toEqual(["inspect"]);
      expect(result.code).toContain('require("@bds_pi/workflow")');
      expect(result.code).toContain("exports.meta");
    });

    it("type-checks every specialized agent recipe", () => {
      const result = compile(`
        import { codeReview, defineWorkflow, lookAt, readSession, readWebPage } from "@bds_pi/workflow";
        export const meta = {
          name: "specialized",
          description: "specialized recipes",
          agents: ["codeReview", "lookAt", "readSession", "readWebPage"],
        } as const;
        export default defineWorkflow(meta, {
          run: () => [
            codeReview({ diff_description: "review" }).kind,
            lookAt({ path: "diagram.png", objective: "inspect", context: "demo" }).kind,
            readSession({ session_id: "session", goal: "extract" }).kind,
            readWebPage({ url: "https://example.com", prompt: "answer" }).kind,
          ],
        });
      `);
      expect(result.meta.agents).toEqual([
        "codeReview",
        "lookAt",
        "readSession",
        "readWebPage",
      ]);
    });

    it("reports semantic errors for invalid recipe input", () => {
      expect(() =>
        compile(`
          import { defineWorkflow, delegate } from "@bds_pi/workflow";
          export const meta = { name: "x", description: "x", agents: ["delegate"] } as const;
          export default defineWorkflow(meta, {
            run: ({ agent }) => agent(delegate({ prompt: "x" })),
          });
        `),
      ).toThrow("description");
    });

    it("keeps args unknown without parseArgs", () => {
      expect(() =>
        compile(`
          import { defineWorkflow, finder } from "@bds_pi/workflow";
          export const meta = { name: "x", description: "x", agents: ["finder"] } as const;
          export default defineWorkflow(meta, {
            run: ({ agent }, args) => agent(finder({ query: args.query })),
          });
        `),
      ).toThrow("'args' is of type 'unknown'");
    });

    it("rejects runtime values absent from the JSON workflow contract", () => {
      expect(() =>
        compile(`
          import { defineWorkflow } from "@bds_pi/workflow";
          export const meta = { name: "x", description: "x" } as const;
          export default defineWorkflow(meta, {
            parseArgs: () => new Date(),
            run: (_context, date) => date.toISOString(),
          });
        `),
      ).toThrow();
      expect(() =>
        compile(`
          import { defineWorkflow } from "@bds_pi/workflow";
          export const meta = { name: "x", description: "x" } as const;
          export default defineWorkflow(meta, { run: () => fetch("https://example.com") });
        `),
      ).toThrow("Cannot find name 'fetch'");
    });

    it("rejects recipes not declared by metadata", () => {
      expect(() =>
        compile(`
          import { defineWorkflow, finder } from "@bds_pi/workflow";
          export const meta = { name: "x", description: "x" } as const;
          export default defineWorkflow(meta, {
            run: ({ agent }) => agent(finder({ query: "x" })),
          });
        `),
      ).toThrow("undeclared finder recipe");
    });

    it("reports semantic errors for phases outside metadata", () => {
      expect(() =>
        compile(`
          import { defineWorkflow, finder } from "@bds_pi/workflow";
          export const meta = { name: "x", description: "x", phases: ["inspect"], agents: ["finder"] } as const;
          export default defineWorkflow(meta, {
            run: ({ agent, phase }) =>
              phase("write", () => agent(finder({ query: "x" }))),
          });
        `),
      ).toThrow('"write"');
    });

    it("rejects imports outside the workflow API", () => {
      expect(() =>
        compile(`
          import { readFile } from "node:fs";
          import { defineWorkflow } from "@bds_pi/workflow";
          export const meta = { name: "x", description: "x" } as const;
          export default defineWorkflow(meta, { run: () => readFile("x", () => {}) });
        `),
      ).toThrow("imports may only come from");
    });

    it("rejects metadata expressions without evaluating them", () => {
      expect(() =>
        compile(`
          import { defineWorkflow } from "@bds_pi/workflow";
          const description = (() => { throw new Error("executed"); })();
          export const meta = { name: "x", description };
          export default defineWorkflow(meta, { run: () => { throw new Error("unused"); } });
        `),
      ).toThrow("static properties");
    });
  });
}
