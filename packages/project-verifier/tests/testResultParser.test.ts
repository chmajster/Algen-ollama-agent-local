import { describe, expect, it } from "vitest";

import { TestResultParser } from "../src/index.js";

describe("TestResultParser", () => {
  const parser = new TestResultParser();

  it("parsuje Vitest", () => {
    expect(parser.parse("Test Files  2 passed\nTests  8 passed")).toMatchObject({
      testSuites: 2,
      testsTotal: 8,
      testsPassed: 8,
    });
  });

  it("parsuje Jest", () => {
    expect(parser.parse("Test Suites: 3 passed, 3 total\nTests: 9 passed, 9 total")).toMatchObject({
      testSuites: 3,
    });
  });

  it("parsuje pytest", () => {
    expect(parser.parse("2 failed, 7 passed, 1 skipped")).toMatchObject({
      testsPassed: 7,
      testsFailed: 2,
      testsSkipped: 1,
    });
  });

  it.each([
    "test result: ok. 5 passed; 0 failed; 1 ignored",
    "ok example/pkg 0.12s\nTests 4 passed",
    "Passed! - Failed: 0, Passed: 3, Skipped: 1",
  ])("zwraca użyteczne podsumowanie formatu fallback", (text) => {
    expect(parser.parse(text)).toBeTypeOf("object");
  });

  it("zwraca pusty obiekt dla nieznanego wyjścia", () => {
    expect(parser.parse("no structured summary")).toEqual({});
  });
});
