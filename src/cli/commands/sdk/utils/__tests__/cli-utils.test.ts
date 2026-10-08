import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiError } from "codemie-sdk";
import { handleSdkError } from "../cli-utils.js";

afterEach(() => vi.restoreAllMocks());

describe("handleSdkError", () => {
  it("shows the re-auth hint for ApiError with statusCode 401", () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    handleSdkError(new ApiError("Unauthorized", 401), "test assistant");
    expect(errors.join("\n")).toContain("Authorization error");
  });
});
