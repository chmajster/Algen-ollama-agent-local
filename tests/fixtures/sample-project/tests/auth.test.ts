import { describe, expect, it } from "vitest";

import { authenticate } from "../src/auth.js";

describe("authenticate", () => {
  it("akceptuje wyłącznie dane przykładowe", () => {
    expect(authenticate("sample-token")).toBe(true);
  });
});
