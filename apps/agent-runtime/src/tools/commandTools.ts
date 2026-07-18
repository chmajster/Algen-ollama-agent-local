import { z } from "zod";

import {
  UnsupportedProjectCommandError,
  type CommandRunner,
} from "@local-code-agent/command-runner";
import type { ProjectVerifier } from "@local-code-agent/project-verifier";

import type { ToolRegistry } from "./toolRegistry.js";
import { createToolDefinition } from "./toolTypes.js";

const emptySchema = z.object({}).strict();
const reasonSchema = z.string().trim().min(3).max(1_000);
const runCommandSchema = z
  .object({ commandId: z.string().trim().min(1).max(500), reason: reasonSchema })
  .strict();
const specializedSchema = z
  .object({ target: z.string().trim().min(1).max(500).optional(), reason: reasonSchema })
  .strict();
const verificationSchema = z
  .object({
    scope: z.enum(["changed_files", "affected_packages", "workspace"]).default("affected_packages"),
    include: z
      .array(z.enum(["tests", "lint", "typecheck", "build", "format_check"]))
      .max(5)
      .optional(),
    reason: reasonSchema,
  })
  .strict();
const historySchema = z
  .object({
    limit: z.number().int().min(1).max(200).default(20),
    category: z.string().trim().min(1).optional(),
    status: z.string().trim().min(1).optional(),
  })
  .strict();
const reportSchema = z.object({ verificationId: z.string().uuid().optional() }).strict();

function register<TArgs, TResult>(
  registry: ToolRegistry,
  name: string,
  description: string,
  schema: z.ZodType<TArgs>,
  execute: (args: TArgs) => Promise<TResult>,
): void {
  registry.register({
    name,
    description,
    schema,
    definition: createToolDefinition(name, description, schema),
    execute,
  });
}

export interface RegisterCommandToolsOptions {
  enabled: boolean;
  verificationEnabled: boolean;
}

export function registerCommandTools(
  registry: ToolRegistry,
  runner: CommandRunner,
  verifier: ProjectVerifier,
  options: RegisterCommandToolsOptions,
): void {
  register(
    registry,
    "detect_project_commands",
    "Wykrywa bezpieczne polecenia projektu bez uruchamiania procesów.",
    emptySchema,
    async () => verifier.detectProjectCommands(),
  );
  if (options.enabled) {
    register(
      registry,
      "run_project_command",
      "Uruchamia wyłącznie polecenie o identyfikatorze z aktualnego katalogu detekcji.",
      runCommandSchema,
      ({ commandId, reason }) => verifier.runProjectCommand(commandId, reason),
    );
    const categories = [
      ["run_tests", "test"],
      ["run_linter", "lint"],
      ["run_typecheck", "typecheck"],
      ["run_build", "build"],
      ["run_formatter", "format"],
    ] as const;
    for (const [name, category] of categories) {
      register(
        registry,
        name,
        `Uruchamia wykryte polecenie kategorii ${category}; target nie jest dowolnym argumentem procesu.`,
        specializedSchema,
        ({ target, reason }) => {
          if (target !== undefined && !["workspace", "."].includes(target)) {
            return Promise.reject(new UnsupportedProjectCommandError(undefined, { target }));
          }
          return verifier.runCategory(category, reason);
        },
      );
    }
    if (options.verificationEnabled) {
      register(
        registry,
        "run_verification",
        "Buduje i wykonuje minimalny plan weryfikacji projektu.",
        verificationSchema,
        ({ scope, include, reason }) =>
          verifier.verify({ scope, reason, ...(include === undefined ? {} : { include }) }),
      );
    }
  }
  register(
    registry,
    "get_command_history",
    "Zwraca metadane historii poleceń bez stdout, stderr i środowiska.",
    historySchema,
    ({ limit, category, status }) =>
      runner.getHistory({
        limit,
        ...(category === undefined ? {} : { category }),
        ...(status === undefined ? {} : { status }),
      }),
  );
  register(
    registry,
    "get_verification_report",
    "Zwraca wskazany albo ostatni raport weryfikacji sesji.",
    reportSchema,
    async ({ verificationId }) => ({ report: verifier.getReport(verificationId) ?? null }),
  );
}
