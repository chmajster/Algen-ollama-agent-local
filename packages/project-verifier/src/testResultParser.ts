import type { TestSummary } from "./verifierTypes.js";

function number(text: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export class TestResultParser {
  public parse(stdout: string, stderr = ""): TestSummary {
    const text = `${stdout}\n${stderr}`;
    const passed =
      number(text, /^Tests:?\s+(?:\d+ failed(?:\s+\|\s+)?)*(\d+) passed/imu) ??
      number(text, /(?:^|[,;]\s*)(\d+)\s+passed/imu) ??
      number(text, /\bPassed:\s*(\d+)/iu);
    const failed =
      number(text, /^Tests:?\s+(\d+) failed/imu) ??
      number(text, /(?:^|[,;]\s*)(\d+)\s+failed/imu) ??
      number(text, /\bFailed:\s*(\d+)/iu);
    const skipped =
      number(text, /(\d+)\s+(?:skipped|ignored|pending)/iu) ?? number(text, /\bSkipped:\s*(\d+)/iu);
    const explicitTotal =
      number(text, /\b(\d+)\s+tests? collected/iu) ??
      number(text, /^Tests:.*?\b(\d+) total/imu) ??
      number(text, /\bTotal:\s*(\d+)/iu);
    const countedTotal =
      passed === undefined && failed === undefined && skipped === undefined
        ? undefined
        : (passed ?? 0) + (failed ?? 0) + (skipped ?? 0);
    const total = explicitTotal ?? countedTotal;
    const suites =
      number(text, /Test Files\s+(?:\d+ failed \| )?(\d+) passed/iu) ??
      number(text, /Test Suites:\s+(\d+) passed/iu);
    return {
      ...(suites === undefined ? {} : { testSuites: suites }),
      ...(total === undefined ? {} : { testsTotal: total }),
      ...(passed === undefined ? {} : { testsPassed: passed }),
      ...(failed === undefined ? {} : { testsFailed: failed }),
      ...(skipped === undefined ? {} : { testsSkipped: skipped }),
    };
  }
}
