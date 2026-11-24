import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { ApiError } from "codemie-sdk";
import { handleSdkError } from "../cli-utils.js";
import {
  recordNetworkError,
  takeNetworkError,
  clearNetworkError,
} from "@/utils/network-error-capture.js";

function run(error: unknown): string {
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  handleSdkError(error, "test assistant");
  return errors.join("\n");
}

beforeEach(() => clearNetworkError());
afterEach(() => vi.restoreAllMocks());

describe("handleSdkError", () => {
  it("shows the re-auth hint for ApiError with statusCode 401", () => {
    expect(run(new ApiError("Unauthorized", 401))).toContain("Authorization error");
  });

  it("reports the captured network error code instead of the generic HTTP 500", () => {
    recordNetworkError(Object.assign(new Error("Maximum number of redirects exceeded"), {
      code: "ERR_FR_TOO_MANY_REDIRECTS",
    }));
    const out = run(new ApiError("HTTP 500 error", 500, {}));
    expect(out).toContain("ERR_FR_TOO_MANY_REDIRECTS");
    expect(out).not.toContain("HTTP 500");
  });

  it("keeps the generic message when nothing was recorded", () => {
    expect(run(new ApiError("HTTP 500 error", 500, {}))).toContain("API error: HTTP 500 error");
  });

  it("leaves a 500 with a real body unchanged", () => {
    recordNetworkError(Object.assign(new Error("x"), { code: "ECONNRESET" }));
    const out = run(new ApiError("boom", 500, { data: "x" }));
    expect(out).toContain("API error: boom");
    expect(out).not.toContain("ECONNRESET");
  });

  it("does not leak URLs or tokens from the recorded message", () => {
    recordNetworkError(Object.assign(new Error("failed https://host/x?token=abc123 now"), {
      code: "ERR_BAD_REQUEST",
    }));
    const out = run(new ApiError("HTTP 500 error", 500, {}));
    expect(out).toContain("ERR_BAD_REQUEST");
    expect(out).not.toContain("https://host");
    expect(out).not.toContain("abc123");
  });
});

describe("network error store", () => {
  it("clears on read", () => {
    recordNetworkError(Object.assign(new Error("x"), { code: "ECONNRESET" }));
    expect(takeNetworkError()?.code).toBe("ECONNRESET");
    expect(takeNetworkError()).toBeUndefined();
  });

  it("ignores errors that carry a response", () => {
    recordNetworkError(Object.assign(new Error("x"), { code: "ERR_BAD_RESPONSE", response: { status: 500 } }));
    expect(takeNetworkError()).toBeUndefined();
  });
});

describe("stale capture", () => {
  it("does not attach an unread capture to a later real empty-body 500", () => {
    recordNetworkError(Object.assign(new Error("x"), { code: "ECONNRESET" }));
    clearNetworkError(); // what the adapter does at the start of the next request
    expect(run(new ApiError("HTTP 500 error", 500, {}))).toContain("API error: HTTP 500 error");
  });
});
