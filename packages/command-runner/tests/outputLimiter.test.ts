import { describe, expect, it } from "vitest";

import { OutputLimiter } from "../src/index.js";

function limiter(
  overrides: Partial<{ maxChars: number; maxLines: number; maxBytes: number }> = {},
) {
  return new OutputLimiter({ maxChars: 1_000, maxLines: 100, maxBytes: 1_000, ...overrides });
}

describe("OutputLimiter", () => {
  it("zachowuje małe wyjście", () => {
    const subject = limiter();
    subject.append("hello\n");
    expect(subject.result()).toMatchObject({ text: "hello\n", truncated: false, bytes: 6 });
  });

  it("ogranicza liczbę znaków", () => {
    const subject = limiter({ maxChars: 50 });
    subject.append("a".repeat(200));
    const result = subject.result();
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(50);
  });

  it("ogranicza liczbę bajtów i zachowuje początek oraz koniec", () => {
    const subject = limiter({ maxBytes: 60 });
    subject.append(`BEGIN-${"x".repeat(200)}-END`);
    const result = subject.result();
    expect(result.text).toContain("BEGIN");
    expect(result.text).toContain("END");
    expect(result.text).toContain("pominięto");
  });

  it("ogranicza liczbę linii", () => {
    const subject = limiter({ maxLines: 6 });
    subject.append(Array.from({ length: 30 }, (_, index) => `line-${index}\n`).join(""));
    expect(subject.result()).toMatchObject({ truncated: true });
    expect(subject.result().text).toContain("linii");
    expect(subject.result().text.match(/\n/gu)).toHaveLength(6);
  });

  it("przetwarza wiele chunków", () => {
    const subject = limiter({ maxBytes: 20 });
    for (const part of ["one-", "two-", "three-", "four-", "five"]) subject.append(part);
    expect(subject.result().bytes).toBe(23);
  });

  it("nie tworzy niepoprawnego UTF-8 na granicy limitu", () => {
    const subject = limiter({ maxBytes: 13 });
    subject.append("początek🙂środek🙂koniec");
    expect(subject.result().text).not.toContain("\u0000");
    expect(subject.result().text).not.toContain("�");
  });

  it("liczy bajty UTF-8, a nie znaki", () => {
    const subject = limiter();
    subject.append("🙂");
    expect(subject.result().bytes).toBe(4);
  });

  it("oznacza pominiętą część czytelnym markerem", () => {
    const subject = limiter({ maxBytes: 20 });
    subject.append("x".repeat(100));
    expect(subject.result().text).toMatch(/\[\.\.\. pominięto \d+ bajtów wyjścia \.\.\.\]/u);
  });
});
