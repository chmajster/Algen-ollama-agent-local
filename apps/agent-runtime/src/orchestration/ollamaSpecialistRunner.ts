import type {
  SpecialistModelRequest,
  SpecialistModelRunner,
  SpecialistResult,
} from "@local-code-agent/agent-specialists";
import type { AgentMessage, OllamaToolDefinition } from "@local-code-agent/shared-types";

import type { AgentConfig } from "../config.js";
import { OllamaClient } from "../ollamaClient.js";

const TOOL_DEFINITIONS: Record<string, OllamaToolDefinition> = Object.fromEntries(
  [
    [
      "read_file",
      "Odczytaj plik workspace.",
      { path: { type: "string" }, includeLineNumbers: { type: "boolean" } },
      ["path"],
    ],
    [
      "search_repository",
      "Wyszukaj tekst w repozytorium.",
      { query: { type: "string" }, path: { type: "string" } },
      ["query"],
    ],
    ["get_change_preview", "Odczytaj rzeczywisty diff przygotowanego ChangeSetu.", {}, []],
    [
      "prepare_patch",
      "Przygotuj patch z oczekiwanym hashem.",
      {
        path: { type: "string" },
        expectedHash: { type: "string" },
        replacements: { type: "array", items: { type: "object" } },
        reason: { type: "string" },
      },
      ["path", "expectedHash", "replacements", "reason"],
    ],
    [
      "prepare_create_file",
      "Przygotuj utworzenie pliku.",
      { path: { type: "string" }, content: { type: "string" }, reason: { type: "string" } },
      ["path", "content", "reason"],
    ],
    [
      "prepare_delete_file",
      "Przygotuj usunięcie pliku.",
      { path: { type: "string" }, expectedHash: { type: "string" }, reason: { type: "string" } },
      ["path", "expectedHash", "reason"],
    ],
    [
      "prepare_move_file",
      "Przygotuj przeniesienie pliku.",
      {
        sourcePath: { type: "string" },
        destinationPath: { type: "string" },
        expectedSourceHash: { type: "string" },
        reason: { type: "string" },
      },
      ["sourcePath", "destinationPath", "expectedSourceHash", "reason"],
    ],
    [
      "run_verification",
      "Uruchom centralną weryfikację.",
      {
        scope: { type: "string", enum: ["changed_files", "affected_packages", "workspace"] },
        include: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
      },
      ["reason"],
    ],
    [
      "run_project_command",
      "Uruchom wykryte polecenie projektu po identyfikatorze.",
      { commandId: { type: "string" }, reason: { type: "string" } },
      ["commandId", "reason"],
    ],
  ].map(([name, description, properties, required]) => [
    name,
    {
      type: "function",
      function: {
        name,
        description,
        parameters: { type: "object", properties, required, additionalProperties: false },
      },
    },
  ]),
) as Record<string, OllamaToolDefinition>;

function parseResult(content: string): unknown {
  const unfenced = content
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  return JSON.parse(
    start >= 0 && end >= start ? unfenced.slice(start, end + 1) : unfenced,
  ) as unknown;
}

function resultInstructions(request: SpecialistModelRequest): string {
  return `Zwróć wyłącznie JSON SpecialistResult. Wymagane pola: taskId=${request.task.id}, role=${request.role}, status (completed|failed|blocked|needs_clarification|security_stop), summary, artifacts, evidence, proposedActions, confidence, limitations, warnings. Każdy completed wymaga co najmniej jednego dowodu. Dozwolone typy artefaktów: ${request.task.expectedArtifactTypes.join(", ")}. Implementacja completed musi pobrać changeSetId z wyniku centralnego narzędzia prepare_*, umieścić ten sam identyfikator w change_proposal.changeSetId oraz akcji {type:"prepare_change",changeSetReference:changeSetId}. Nie umieszczaj historii rozmowy ani ukrytego rozumowania. Schematy kluczowych payloadów: repository_map={files:string[],summary:string}; implementation_plan={steps:unknown[]}; architecture_report={summary:string,evidence:string[]}; change_proposal={changeSetId:string,files:string[]}; test_plan={scenarios:unknown[],requirements:string[]}; verification_report={status:string,evidence:string[]}; security_report={verdict:"pass"|"warning"|"block",findings:[],reviewedAreas:string[],limitations:string[]}; review_report={verdict:"approve"|"changes_required"|"manual_review",findings:[],planCoverage:[],limitations:string[]}; performance_report={summary:string,evidence:string[]}; documentation_plan={files:string[],changes:string[]}.`;
}

export class OllamaSpecialistRunner implements SpecialistModelRunner {
  private readonly availability = new Map<string, boolean>();

  public constructor(private readonly config: AgentConfig) {}

  public async isModelAvailable(model: string): Promise<boolean> {
    const cached = this.availability.get(model);
    if (cached !== undefined) return cached;
    try {
      await new OllamaClient({ ...this.config, ollamaModel: model }).checkAvailability();
      this.availability.set(model, true);
      return true;
    } catch {
      this.availability.set(model, false);
      return false;
    }
  }

  public async execute(request: SpecialistModelRequest): Promise<SpecialistResult> {
    const startedAt = Date.now();
    const client = new OllamaClient({
      ...this.config,
      ollamaModel: request.model,
      contextLength: Math.min(
        this.config.orchestrationMaxAgentContextTokens,
        request.task.budget.maxContextTokens,
      ),
    });
    const messages: AgentMessage[] = [
      { role: "system", content: `${request.systemPrompt}\n${resultInstructions(request)}` },
      {
        role: "user",
        content: JSON.stringify({
          task: request.task,
          repositoryContext: request.repositoryContext,
          artifacts: request.artifacts,
        }),
      },
    ];
    const tools = request.toolGateway.allowedTools
      .map((name) => TOOL_DEFINITIONS[name])
      .filter((definition): definition is OllamaToolDefinition => definition !== undefined);
    let toolCalls = 0;
    let commands = 0;
    for (let step = 1; step <= request.task.budget.maxSteps; step += 1) {
      const response = await client.chat({
        messages,
        tools,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      messages.push(response.message);
      const calls = response.message.toolCalls ?? [];
      if (calls.length === 0) {
        if (response.message.content.length > this.config.orchestrationMaxAgentOutputChars) {
          throw new Error("Wynik specjalisty przekracza limit znaków.");
        }
        const parsed = parseResult(response.message.content) as SpecialistResult;
        parsed.usage = {
          steps: step,
          toolCalls,
          commands,
          contextTokens: Math.ceil(
            messages.reduce((sum, message) => sum + message.content.length, 0) / 4,
          ),
          durationMs: Date.now() - startedAt,
        };
        return parsed;
      }
      for (const call of calls) {
        toolCalls += 1;
        if (
          call.function.name === "run_project_command" ||
          call.function.name === "run_verification"
        )
          commands += 1;
        const result = await request.toolGateway.execute(
          call.function.name,
          call.function.arguments,
        );
        messages.push({
          role: "tool",
          toolName: call.function.name,
          content: JSON.stringify(result).slice(0, this.config.maxToolResultChars),
        });
      }
    }
    throw new Error(`Specjalista ${request.role} przekroczył limit kroków.`);
  }
}
