import { describe, expect, it, vi } from "vitest";
import {
  FailClosedBrowserDestinationAuthority,
  IsolatedQualificationDestinationAuthority,
  type DestinationResolver,
} from "../src/destination-authority.js";
import type { AuthorityActor } from "../src/ports.js";

const actor: AuthorityActor = { principalId: "principal-a", agentId: "agent-a", scopes: new Set() };
const request = (url: string) => ({ actor, operationId: "operation-1", operation: "navigate" as const, url });

function resolver(addresses: readonly string[]): DestinationResolver {
  return { resolve: vi.fn(async () => addresses) };
}

describe("fail-closed browser destination authority", () => {
  it.each([
    ["http://127.0.0.1/", ["127.0.0.1"], "WEBX_POLICY_PRIVATE_ADDRESS"],
    ["http://10.0.0.8/", ["10.0.0.8"], "WEBX_POLICY_PRIVATE_ADDRESS"],
    ["http://169.254.2.3/", ["169.254.2.3"], "WEBX_POLICY_LINK_LOCAL_ADDRESS"],
    ["http://169.254.169.254/latest/meta-data", ["169.254.169.254"], "WEBX_POLICY_METADATA_ENDPOINT"],
    ["http://metadata.google.internal/computeMetadata/v1/", [], "WEBX_POLICY_METADATA_ENDPOINT"],
    ["http://[::ffff:127.0.0.1]/", ["::ffff:127.0.0.1"], "WEBX_POLICY_PRIVATE_ADDRESS"],
    ["https://mixed.example/", ["93.184.216.34", "192.168.1.4"], "WEBX_POLICY_PRIVATE_ADDRESS"],
  ])("refuses %s before egress binding", async (url, answers, code) => {
    const authority = new FailClosedBrowserDestinationAuthority(resolver(answers));
    await expect(authority.authorize(request(url))).rejects.toMatchObject({ code, status: 403 });
  });

  it("refuses a public address when connection-bound egress is absent", async () => {
    const authority = new FailClosedBrowserDestinationAuthority(resolver(["93.184.216.34"]));
    await expect(authority.authorize(request("https://example.com/"))).rejects.toMatchObject({
      code: "WEBX_POLICY_EGRESS_REQUIRED",
      status: 403,
    });
  });
});

describe("isolated actual-qualification authority", () => {
  it("permits one exact non-redirecting loopback fixture document", async () => {
    const authority = new IsolatedQualificationDestinationAuthority(resolver(["127.0.0.1"]));
    await expect(authority.authorize(request("http://127.0.0.1:43123/static"))).resolves.toMatchObject({
      mode: "qualification-only",
      resolvedAddresses: ["127.0.0.1"],
      redirectPolicy: { revalidateEveryHop: true, maxRedirects: 0 },
    });
  });

  it("permits only exact marked journey documents", async () => {
    const authority = new IsolatedQualificationDestinationAuthority(resolver(["127.0.0.1"]));
    await expect(
      authority.authorize(
        request("http://127.0.0.1:43123/qualification-journey?case=J2&state=visual-binding"),
      ),
    ).resolves.toMatchObject({ mode: "qualification-only" });
  });

  it.each([
    "http://127.0.0.1:43123/redirect/private",
    "http://127.0.0.1:43123/static?next=http://169.254.169.254/",
    "http://127.0.0.1:43123/qualification-journey?case=J2&state=wrong",
    "http://127.0.0.1:43123/qualification-journey?case=J4&state=visual-binding",
    "http://localhost:43123/static",
    "https://127.0.0.1:43123/static",
  ])("refuses non-fixture or redirect-capable qualification URL %s", async (url) => {
    const authority = new IsolatedQualificationDestinationAuthority(resolver(["127.0.0.1"]));
    await expect(authority.authorize(request(url))).rejects.toMatchObject({
      code: "WEBX_POLICY_QUALIFICATION_TARGET_DENIED",
    });
  });
});
