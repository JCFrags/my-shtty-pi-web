import { describe, expect, it } from "vitest";
import {
  PolicyError,
  assertArtifactAccess,
  classifyAddress,
  createApprovalDescriptor,
  mostRestrictiveVisibility,
  validatePublicDestination,
  validateRedirectChain,
} from "../src/index.js";

function expectPolicyCode(run: () => unknown, code: string): void {
  expect(run).toThrowError(expect.objectContaining<Partial<PolicyError>>({ code }));
}

describe("public URL and SSRF policy", () => {
  it.each([
    ["http://127.0.0.1/", "127.0.0.1"],
    ["http://2130706433/", "127.0.0.1"],
    ["http://0x7f000001/", "127.0.0.1"],
    ["http://0177.0.0.1/", "127.0.0.1"],
    ["http://[::ffff:127.0.0.1]/", "::ffff:127.0.0.1"],
    ["https://public.example/", "10.4.3.2"],
    ["https://public.example/", "169.254.169.254"],
  ])("rejects encoded or resolved private target %s", (url, address) => {
    expectPolicyCode(
      () => validatePublicDestination(url, [address]),
      address === "169.254.169.254" ? "WEBX_POLICY_METADATA_ENDPOINT" : "WEBX_POLICY_PRIVATE_ADDRESS",
    );
  });

  it("accepts only a fully public destination", () => {
    expect(validatePublicDestination("https://example.com/a", ["93.184.216.34"]))
      .toMatchObject({ asciiHostname: "example.com", port: 443 });
  });

  it("revalidates and refuses a redirect pivot", () => {
    expectPolicyCode(
      () => validateRedirectChain([
        { url: "https://example.com", resolvedAddresses: ["93.184.216.34"] },
        { url: "http://service.internal", resolvedAddresses: ["192.168.1.3"] },
      ]),
      "WEBX_POLICY_PRIVATE_ADDRESS",
    );
  });

  it("classifies private and reserved address forms", () => {
    expect(classifyAddress("100.64.2.1")).toBe("carrier_grade_nat");
    expect(classifyAddress("fc00::1")).toBe("private");
    expect(classifyAddress("2001:db8::1")).toBe("reserved");
  });
});

describe("ownership, visibility, and approval policy", () => {
  it("refuses cross-owner and over-ceiling artifact access", () => {
    expectPolicyCode(
      () => assertArtifactAccess(
        { actorId: "actor-a", maxVisibility: "secret" },
        { ownerId: "actor-b", visibility: "internal" },
      ),
      "WEBX_SCOPE_REQUIRED",
    );
    expectPolicyCode(
      () => assertArtifactAccess(
        { actorId: "actor-a", maxVisibility: "internal" },
        { ownerId: "actor-a", visibility: "private" },
      ),
      "WEBX_SCOPE_REQUIRED",
    );
  });

  it("never lowers inherited visibility", () => {
    expect(mostRestrictiveVisibility(["public", "private", "internal"])).toBe("private");
  });

  it("builds a finite explicit approval descriptor", () => {
    const descriptor = createApprovalDescriptor({
      target: "https://example.com/upload",
      operation: "browser.upload",
      reason: "The user selected a controlled upload.",
      credentialRef: null,
      requestedData: "One PDF artifact",
      limits: { maxPages: 1, maxBytes: 1024, maxDurationSeconds: 30 },
      visibility: "private",
      retention: "document policy",
      downstream: { index: false, wiki: false },
      expiresAt: "2026-08-12T11:00:00.000Z",
    }, new Date("2026-08-12T10:00:00.000Z"));
    expect(descriptor.downstream).toEqual({ index: false, wiki: false });
  });

  it("rejects an unbounded approval", () => {
    expectPolicyCode(() => createApprovalDescriptor({
      target: "https://example.com",
      operation: "media.acquire",
      reason: "Acquire selected media.",
      credentialRef: null,
      requestedData: "One media item",
      limits: { maxPages: 1, maxBytes: Number.POSITIVE_INFINITY, maxDurationSeconds: 30 },
      visibility: "internal",
      retention: "media policy",
      downstream: { index: false, wiki: false },
      expiresAt: "2026-08-12T11:00:00.000Z",
    }, new Date("2026-08-12T10:00:00.000Z")), "WEBX_BUDGET_INVALID");
  });
});
