const ALLOWED_SCHEMES = ["file", "tool", "feishu", "object"] as const;

export type AuthorizationResourceScheme = (typeof ALLOWED_SCHEMES)[number];

export interface ParsedResourceUri {
  uri: string;
  scheme: AuthorizationResourceScheme;
  authority: string;
  segments: readonly string[];
}

const MAX_URI_BYTES = 2_048;
const MAX_SEGMENTS = 32;
const MAX_SEGMENT_BYTES = 256;

function fail(label: string, reason: string): never {
  throw new Error(`${label} must be a canonical resource URI: ${reason}`);
}

function encodeSegment(value: string, label: string): string {
  const segment = String(value ?? "");
  if (
    segment.length === 0
    || segment === "."
    || segment === ".."
    || /[\\/\u0000-\u001f\u007f]/.test(segment)
    || Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES
  ) {
    fail(label, "path segments must be non-empty, bounded, and may not contain slash, backslash, dot traversal, or controls");
  }
  return encodeURIComponent(segment);
}

/**
 * Normalize one address in the authorization resource namespace.
 *
 * The four schemes are deliberately few and semantic: `file://` for data rooted
 * at a machine, `tool://` for callable surfaces, `feishu://` for Feishu people
 * and chats, and `object://` for everything without a more precise protocol.
 * Credentials, query strings, fragments, ports, dot traversal and encoded
 * slashes are not addresses in this namespace.
 */
export function parseResourceUri(value: string, label = "resource URI"): ParsedResourceUri {
  const input = String(value ?? "");
  if (
    input !== input.trim()
    || input.length === 0
    || Buffer.byteLength(input, "utf8") > MAX_URI_BYTES
    || /[\u0000-\u001f\u007f]/.test(input)
  ) {
    fail(label, `expected a trimmed value up to ${MAX_URI_BYTES} UTF-8 bytes`);
  }

  const schemeMarker = input.indexOf("://");
  if (schemeMarker <= 0) fail(label, "URL parsing failed");
  const pathStart = input.indexOf("/", schemeMarker + 3);
  const queryStart = input.indexOf("?", schemeMarker + 3);
  const hashStart = input.indexOf("#", schemeMarker + 3);
  const firstSuffix = [pathStart, queryStart, hashStart]
    .filter((position) => position >= 0)
    .reduce((left, right) => Math.min(left, right), input.length);
  const rawPath = pathStart >= 0 && pathStart === firstSuffix
    ? input.slice(pathStart, Math.min(
      queryStart >= 0 ? queryStart : input.length,
      hashStart >= 0 ? hashStart : input.length,
    ))
    : "";
  const rawSegments = rawPath.split("/").slice(1);
  if (rawSegments.length === 0 || rawSegments.some((segment) => segment.length === 0)) {
    fail(label, "at least one non-empty path segment is required and trailing slash is forbidden");
  }
  if (rawSegments.length > MAX_SEGMENTS) fail(label, `path depth exceeds ${MAX_SEGMENTS}`);
  const segments = rawSegments.map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      fail(label, "path contains malformed percent encoding");
    }
    encodeSegment(decoded, label);
    return decoded;
  });

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    fail(label, "URL parsing failed");
  }
  const scheme = parsed.protocol.slice(0, -1) as AuthorizationResourceScheme;
  if (!ALLOWED_SCHEMES.includes(scheme)) fail(label, `unsupported scheme ${parsed.protocol}`);
  if (!parsed.hostname || !/^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/.test(parsed.hostname)) {
    fail(label, "authority must be a bounded lowercase DNS-flavoured namespace label");
  }
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    fail(label, "credentials, ports, query strings, and fragments are forbidden");
  }
  const uri = `${scheme}://${parsed.hostname}/${segments.map((segment) => encodeSegment(segment, label)).join("/")}`;
  return { uri, scheme, authority: parsed.hostname, segments: Object.freeze(segments) };
}

export function resourceUri(
  scheme: AuthorizationResourceScheme,
  authority: string,
  ...segments: readonly string[]
): string {
  if (!ALLOWED_SCHEMES.includes(scheme)) fail("resource URI", `unsupported scheme ${scheme}`);
  const root = String(authority ?? "");
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/.test(root)) {
    fail("resource URI", "authority must be a bounded lowercase DNS-flavoured namespace label");
  }
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) {
    fail("resource URI", `path depth must be between 1 and ${MAX_SEGMENTS}`);
  }
  return `${scheme}://${root}/${segments.map((segment) => encodeSegment(segment, "resource URI")).join("/")}`;
}

/** Self first, then each parent path. The bare scheme authority is not a node. */
export function resourceUriPrefixes(value: string): string[] {
  const parsed = parseResourceUri(value);
  const out: string[] = [];
  for (let size = parsed.segments.length; size >= 1; size -= 1) {
    out.push(resourceUri(parsed.scheme, parsed.authority, ...parsed.segments.slice(0, size)));
  }
  return out;
}

export function isResourceUriPrefix(prefix: string, value: string): boolean {
  const left = parseResourceUri(prefix).uri;
  const right = parseResourceUri(value).uri;
  return right === left || right.startsWith(`${left}/`);
}

/** Rewrite one exact URI or subtree while preserving the relative suffix. */
export function rewriteResourceUri(value: string, from: string, to: string): string {
  const current = parseResourceUri(value).uri;
  const source = parseResourceUri(from).uri;
  const target = parseResourceUri(to).uri;
  if (!isResourceUriPrefix(source, current)) throw new Error(`${source} is not an ancestor of ${current}`);
  return `${target}${current.slice(source.length)}`;
}
