import { z } from "zod";

import type { AgentTool } from "./toolTypes.js";
import { createToolDefinition } from "./toolTypes.js";

const argsSchema = z.object({}).strict();

export interface CurrentTimeInfo {
  isoTime: string;
  localTime: string;
  timezoneOffset: string;
  timezoneName?: string;
}

function formatOffset(offsetInMinutes: number): string {
  const localOffset = -offsetInMinutes;
  const sign = localOffset >= 0 ? "+" : "-";
  const absolute = Math.abs(localOffset);
  const hours = Math.floor(absolute / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absolute % 60).toString().padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

export const getCurrentTimeTool: AgentTool<z.infer<typeof argsSchema>, CurrentTimeInfo> = {
  name: "get_current_time",
  description: "Zwraca bieżący czas lokalny, czas ISO i informacje o strefie czasowej.",
  schema: argsSchema,
  definition: createToolDefinition(
    "get_current_time",
    "Zwraca bieżący czas lokalny, czas ISO i informacje o strefie czasowej.",
    argsSchema,
  ),
  async execute(): Promise<CurrentTimeInfo> {
    const now = new Date();
    const timezoneName = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      isoTime: now.toISOString(),
      localTime: Intl.DateTimeFormat(undefined, {
        dateStyle: "full",
        timeStyle: "long",
      }).format(now),
      timezoneOffset: formatOffset(now.getTimezoneOffset()),
      ...(timezoneName === "" ? {} : { timezoneName }),
    };
  },
};
