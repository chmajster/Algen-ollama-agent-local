import type {
  SpecialistAgent,
  SpecialistModelRunner,
  SpecialistRole,
} from "@local-code-agent/agent-specialists";

import { SpecialistNotFoundError } from "./errors.js";

export type SpecialistConstructor = (id: string, runner: SpecialistModelRunner) => SpecialistAgent;

export class AgentRegistry {
  private readonly constructors = new Map<SpecialistRole, SpecialistConstructor>();

  public register(role: SpecialistRole, constructor: SpecialistConstructor): void {
    if (this.constructors.has(role)) throw new Error(`Rola ${role} jest już zarejestrowana.`);
    this.constructors.set(role, constructor);
  }

  public create(role: SpecialistRole, id: string, runner: SpecialistModelRunner): SpecialistAgent {
    const constructor = this.constructors.get(role);
    if (constructor === undefined)
      throw new SpecialistNotFoundError(`Rola ${role} nie jest zarejestrowana.`);
    const agent = constructor(id, runner);
    if (agent.access.applyChanges !== false || agent.access.remoteWrite !== false) {
      throw new Error(`Rola ${role} narusza centralną politykę zapisu.`);
    }
    return agent;
  }

  public roles(): SpecialistRole[] {
    return [...this.constructors.keys()].sort();
  }
}
