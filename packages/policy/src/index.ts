export type Visibility = "public" | "internal" | "private" | "secret";

const visibilityRank: Readonly<Record<Visibility, number>> = {
  public: 0,
  internal: 1,
  private: 2,
  secret: 3,
};

export class PolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

export function mostRestrictiveVisibility(values: readonly Visibility[]): Visibility {
  if (values.length === 0) {
    throw new PolicyError("WEBX_REQUEST_INVALID", "At least one visibility value is required.");
  }

  return values.reduce((current, candidate) =>
    visibilityRank[candidate] > visibilityRank[current] ? candidate : current,
  );
}

export function canReadVisibility(maxVisibility: Visibility, resourceVisibility: Visibility): boolean {
  return visibilityRank[resourceVisibility] <= visibilityRank[maxVisibility];
}

export function assertOwner(actorId: string, ownerId: string): void {
  if (actorId.length === 0 || ownerId.length === 0 || actorId !== ownerId) {
    throw new PolicyError("WEBX_SCOPE_REQUIRED", "The resource is not owned by the actor.");
  }
}

export interface ArtifactAccessRequest {
  actorId: string;
  maxVisibility: Visibility;
}

export interface OwnedArtifact {
  ownerId: string;
  visibility: Visibility;
}

export function assertArtifactAccess(request: ArtifactAccessRequest, artifact: OwnedArtifact): void {
  assertOwner(request.actorId, artifact.ownerId);
  if (!canReadVisibility(request.maxVisibility, artifact.visibility)) {
    throw new PolicyError("WEBX_SCOPE_REQUIRED", "The artifact visibility exceeds the actor ceiling.");
  }
}

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link_local"
  | "carrier_grade_nat"
  | "multicast"
  | "unspecified"
  | "reserved";

function classifyIpv4(address: string): AddressClass | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const bytes = parts.map(Number);
  if (bytes.some((part) => part > 255)) return undefined;
  const [a, b, c] = bytes as [number, number, number, number];

  if (a === 0) return "unspecified";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "carrier_grade_nat";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link_local";
  if (a >= 224 && a <= 239) return "multicast";
  if (
    a >= 240 ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) return "reserved";
  return "public";
}

function expandIpv6(address: string): number[] | undefined {
  const withoutZone = address.toLowerCase();
  if (withoutZone.includes("%")) return undefined;
  const separator = withoutZone.indexOf("::");
  if (separator !== -1 && withoutZone.indexOf("::", separator + 1) !== -1) return undefined;

  const parseSide = (side: string): number[] | undefined => {
    if (side === "") return [];
    const words: number[] = [];
    for (const part of side.split(":")) {
      if (part.includes(".")) {
        const ipv4Class = classifyIpv4(part);
        if (ipv4Class === undefined) return undefined;
        const [a, b, c, d] = part.split(".").map(Number) as [number, number, number, number];
        words.push((a << 8) | b, (c << 8) | d);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
        words.push(Number.parseInt(part, 16));
      }
    }
    return words;
  };

  const left = parseSide(separator === -1 ? withoutZone : withoutZone.slice(0, separator));
  const right = parseSide(separator === -1 ? "" : withoutZone.slice(separator + 2));
  if (left === undefined || right === undefined) return undefined;
  if (separator === -1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

function classifyIpv6(address: string): AddressClass | undefined {
  const words = expandIpv6(address);
  if (words === undefined) return undefined;
  const [first, word1, word2, , , word5, word6, word7] = words as [number, number, number, number, number, number, number, number];
  const allZero = words.every((word) => word === 0);
  if (allZero) return "unspecified";
  if (words.slice(0, 7).every((word) => word === 0) && word7 === 1) return "loopback";

  const mapped = words.slice(0, 5).every((word) => word === 0) && word5 === 0xffff;
  if (mapped) {
    return classifyIpv4(`${word6 >> 8}.${word6 & 255}.${word7 >> 8}.${word7 & 255}`);
  }

  if ((first & 0xfe00) === 0xfc00) return "private";
  if ((first & 0xffc0) === 0xfe80) return "link_local";
  if ((first & 0xff00) === 0xff00) return "multicast";
  if (words.slice(0, 6).every((word) => word === 0)) return "reserved";
  if (first === 0x0064 && word1 === 0xff9b && (word2 === 0 || word2 === 1)) return "reserved";
  if (first === 0x0100 && words.slice(1, 4).every((word) => word === 0)) return "reserved";
  if (first === 0x2001 && (word1 <= 0x01ff || word1 === 0x0db8)) return "reserved";
  if (first === 0x2002 || first === 0x3fff || first === 0x5f00) return "reserved";
  return "public";
}

export function classifyAddress(address: string): AddressClass {
  const ipv4 = classifyIpv4(address);
  if (ipv4 !== undefined) return ipv4;
  const ipv6 = classifyIpv6(address);
  if (ipv6 !== undefined) return ipv6;
  throw new PolicyError("WEBX_URL_INVALID", "The resolved address is not a valid IP address.");
}

export interface ValidatedDestination {
  normalizedUrl: string;
  asciiHostname: string;
  port: number;
  addresses: readonly string[];
}

export interface UrlPolicyOptions {
  maxUrlLength?: number;
  allowedSchemes?: readonly ("http:" | "https:")[];
}

const metadataHosts = new Set([
  "metadata.google.internal",
  "metadata.aws.internal",
  "metadata.azure.internal",
  "instance-data.ec2.internal",
]);
const metadataAddresses = new Set([
  "169.254.169.254",
  "fd00:ec2::254",
  "fe80::a9fe:a9fe",
]);

export function validatePublicDestination(
  rawUrl: string,
  resolvedAddresses: readonly string[],
  options: UrlPolicyOptions = {},
): ValidatedDestination {
  const maxUrlLength = options.maxUrlLength ?? 4096;
  if (rawUrl.length === 0 || rawUrl.length > maxUrlLength) {
    throw new PolicyError("WEBX_URL_INVALID", "The URL length is invalid.");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PolicyError("WEBX_URL_INVALID", "The URL is not absolute and valid.");
  }

  const allowedSchemes = options.allowedSchemes ?? ["http:", "https:"];
  if (!allowedSchemes.includes(url.protocol as "http:" | "https:")) {
    throw new PolicyError("WEBX_POLICY_SCHEME_DENIED", "The URL scheme is not allowed.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new PolicyError("WEBX_URL_CREDENTIALS_FORBIDDEN", "URL user information is forbidden.");
  }
  if (url.hash !== "") {
    throw new PolicyError("WEBX_URL_INVALID", "URL fragments are not valid network targets.");
  }
  if (resolvedAddresses.length === 0) {
    throw new PolicyError("WEBX_DNS_FAILED", "The destination did not resolve to an address.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || metadataHosts.has(hostname)) {
    throw new PolicyError(
      metadataHosts.has(hostname) ? "WEBX_POLICY_METADATA_ENDPOINT" : "WEBX_POLICY_PRIVATE_ADDRESS",
      "The destination hostname is blocked.",
    );
  }

  let literalAddressClass: AddressClass | undefined;
  try {
    literalAddressClass = classifyAddress(hostname);
  } catch (error) {
    if (!(error instanceof PolicyError) || error.code !== "WEBX_URL_INVALID") throw error;
  }
  if (literalAddressClass !== undefined && literalAddressClass !== "public") {
    const code = metadataAddresses.has(hostname)
      ? "WEBX_POLICY_METADATA_ENDPOINT"
      : literalAddressClass === "link_local"
        ? "WEBX_POLICY_LINK_LOCAL_ADDRESS"
        : "WEBX_POLICY_PRIVATE_ADDRESS";
    throw new PolicyError(code, `The literal destination address class '${literalAddressClass}' is blocked.`);
  }

  for (const address of resolvedAddresses) {
    const classification = classifyAddress(address);
    if (classification !== "public") {
      const code = metadataAddresses.has(address.toLowerCase())
        ? "WEBX_POLICY_METADATA_ENDPOINT"
        : classification === "link_local"
          ? "WEBX_POLICY_LINK_LOCAL_ADDRESS"
          : "WEBX_POLICY_PRIVATE_ADDRESS";
      throw new PolicyError(code, `The destination address class '${classification}' is blocked.`);
    }
  }

  return {
    normalizedUrl: url.toString(),
    asciiHostname: hostname,
    port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
    addresses: [...resolvedAddresses],
  };
}

export interface RedirectHop {
  url: string;
  resolvedAddresses: readonly string[];
}

export function validateRedirectChain(
  hops: readonly RedirectHop[],
  maxRedirects = 10,
): readonly ValidatedDestination[] {
  if (hops.length === 0 || hops.length - 1 > maxRedirects) {
    throw new PolicyError("WEBX_REDIRECT_LIMIT", "The redirect chain exceeds its limit.");
  }
  return hops.map((hop) => validatePublicDestination(hop.url, hop.resolvedAddresses));
}

export interface ApprovalDescriptor {
  target: string;
  operation: string;
  reason: string;
  credentialRef: string | null;
  requestedData: string;
  limits: {
    maxPages: number;
    maxBytes: number;
    maxDurationSeconds: number;
  };
  visibility: Visibility;
  retention: string;
  downstream: {
    index: boolean;
    wiki: boolean;
  };
  expiresAt: string;
}

export function createApprovalDescriptor(input: ApprovalDescriptor, now = new Date()): Readonly<ApprovalDescriptor> {
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(input.operation)) {
    throw new PolicyError("WEBX_REQUEST_INVALID", "The approval operation is invalid.");
  }
  if (input.reason.trim() === "" || input.requestedData.trim() === "" || input.retention.trim() === "") {
    throw new PolicyError("WEBX_REQUEST_INVALID", "The approval descriptor is incomplete.");
  }
  if (input.credentialRef !== null && !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.credentialRef)) {
    throw new PolicyError("WEBX_REQUEST_INVALID", "The credential reference is invalid.");
  }
  for (const value of Object.values(input.limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new PolicyError("WEBX_BUDGET_INVALID", "Approval limits must be finite positive integers.");
    }
  }
  const expiry = new Date(input.expiresAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(input.expiresAt) || !Number.isFinite(expiry.getTime()) || expiry <= now) {
    throw new PolicyError("WEBX_REQUEST_INVALID", "The approval expiry must be a future RFC 3339 timestamp.");
  }
  validatePublicDestination(input.target, ["8.8.8.8"]);
  return Object.freeze({
    ...input,
    limits: Object.freeze({ ...input.limits }),
    downstream: Object.freeze({ ...input.downstream }),
  });
}
