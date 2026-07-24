import { isIP } from "node:net";

const MAX_FORWARDED_ENTRIES = 32;
const MAX_FORWARDED_HEADER_LENGTH = 2_048;
const MAX_TRUSTED_RANGES = 64;

function canonicalizeIpv6(value) {
  let hostname;
  try {
    hostname = new URL(`http://[${value}]/`).hostname;
  } catch {
    return null;
  }
  return hostname.slice(1, -1).toLowerCase();
}

function ipv6ToBytes(value) {
  const halves = value.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (
    missing < 0 ||
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return null;
  }
  const parts = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (parts.length !== 8) {
    return null;
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < parts.length; index += 1) {
    if (!/^[0-9a-f]{1,4}$/i.test(parts[index])) {
      return null;
    }
    const valueAtIndex = Number.parseInt(parts[index], 16);
    bytes[index * 2] = valueAtIndex >> 8;
    bytes[index * 2 + 1] = valueAtIndex & 0xff;
  }
  return bytes;
}

function ipv4ToBytes(value) {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const bytes = parts.map((part) => Number(part));
  return bytes.every(
    (part) => Number.isInteger(part) && part >= 0 && part <= 255,
  )
    ? Uint8Array.from(bytes)
    : null;
}

function bytesToIpv6(bytes) {
  const parts = [];
  for (let index = 0; index < 16; index += 2) {
    parts.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
  }
  return canonicalizeIpv6(parts.join(":"));
}

function mappedIpv4(bytes) {
  if (
    bytes.length === 16 &&
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return [...bytes.slice(12)].join(".");
  }
  return null;
}

export function canonicalizeIp(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 100 ||
    value.includes("%")
  ) {
    return null;
  }

  const version = isIP(value);
  if (version === 4) {
    return [...ipv4ToBytes(value)].join(".");
  }
  if (version !== 6) {
    return null;
  }

  const canonical = canonicalizeIpv6(value);
  if (!canonical) {
    return null;
  }
  const bytes = ipv6ToBytes(canonical);
  return mappedIpv4(bytes) ?? canonical;
}

function canonicalizeSocketIp(value) {
  if (typeof value !== "string") {
    return null;
  }
  const zoneIndex = value.indexOf("%");
  if (zoneIndex < 0) {
    return canonicalizeIp(value);
  }
  if (
    zoneIndex === 0 ||
    zoneIndex === value.length - 1 ||
    value.indexOf("%", zoneIndex + 1) >= 0
  ) {
    return null;
  }
  const address = value.slice(0, zoneIndex);
  return isIP(address) === 6 ? canonicalizeIp(address) : null;
}

function ipBytes(value) {
  return isIP(value) === 4
    ? { bytes: ipv4ToBytes(value), version: 4 }
    : { bytes: ipv6ToBytes(value), version: 6 };
}

function maskBytes(bytes, prefixLength) {
  const masked = Uint8Array.from(bytes);
  for (let bit = prefixLength; bit < masked.length * 8; bit += 1) {
    const byteIndex = Math.floor(bit / 8);
    const bitIndex = 7 - (bit % 8);
    masked[byteIndex] &= ~(1 << bitIndex);
  }
  return masked;
}

function parseTrustedRange(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("trusted proxy ranges must be non-empty strings");
  }
  const parts = value.split("/");
  if (parts.length > 2) {
    throw new TypeError(`invalid trusted proxy range: ${value}`);
  }
  const address = canonicalizeIp(parts[0]);
  if (!address) {
    throw new TypeError(`invalid trusted proxy range: ${value}`);
  }
  const { bytes, version } = ipBytes(address);
  const maxPrefix = version === 4 ? 32 : 128;
  if (parts.length === 1) {
    return {
      bytes,
      canonical: address,
      prefixLength: maxPrefix,
      version,
    };
  }
  if (!/^(0|[1-9]\d{0,2})$/.test(parts[1])) {
    throw new TypeError(`invalid trusted proxy range: ${value}`);
  }
  const prefixLength = Number(parts[1]);
  if (prefixLength < 0 || prefixLength > maxPrefix) {
    throw new TypeError(`invalid trusted proxy range: ${value}`);
  }
  if (prefixLength === 0) {
    throw new TypeError("trusted proxy ranges must not trust every address");
  }
  const networkBytes = maskBytes(bytes, prefixLength);
  const networkAddress =
    version === 4
      ? [...networkBytes].join(".")
      : bytesToIpv6(networkBytes);
  return {
    bytes: networkBytes,
    canonical: `${networkAddress}/${prefixLength}`,
    prefixLength,
    version,
  };
}

export function normalizeTrustedProxyConfig(config) {
  if (config === undefined || config === null || config === false) {
    return Object.freeze({
      mode: "direct",
      ranges: Object.freeze([]),
    });
  }
  if (config === true || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError(
      "trustedProxy must use an explicit direct or allowlist policy",
    );
  }
  const unsupportedKeys = Object.keys(config).filter(
    (key) => key !== "mode" && key !== "ranges",
  );
  if (unsupportedKeys.length > 0) {
    throw new TypeError(
      `unsupported trustedProxy option: ${unsupportedKeys[0]}`,
    );
  }

  const mode = config.mode ?? "direct";
  if (mode === "direct") {
    if (
      config.ranges !== undefined &&
      (!Array.isArray(config.ranges) || config.ranges.length > 0)
    ) {
      throw new TypeError("direct proxy mode cannot contain trusted ranges");
    }
    return Object.freeze({
      mode,
      ranges: Object.freeze([]),
    });
  }
  if (mode !== "allowlist" || !Array.isArray(config.ranges)) {
    throw new TypeError(
      "trustedProxy must use an explicit direct or allowlist policy",
    );
  }
  if (
    config.ranges.length === 0 ||
    config.ranges.length > MAX_TRUSTED_RANGES
  ) {
    throw new TypeError(
      `trustedProxy allowlist requires 1-${MAX_TRUSTED_RANGES} ranges`,
    );
  }

  const parsed = config.ranges.map(parseTrustedRange);
  const ranges = [...new Set(parsed.map((range) => range.canonical))];
  return Object.freeze({
    mode,
    ranges: Object.freeze(ranges),
  });
}

function matchesRange(address, range) {
  const parsedAddress = ipBytes(address);
  if (parsedAddress.version !== range.version) {
    return false;
  }
  const fullBytes = Math.floor(range.prefixLength / 8);
  const remainingBits = range.prefixLength % 8;
  for (let index = 0; index < fullBytes; index += 1) {
    if (parsedAddress.bytes[index] !== range.bytes[index]) {
      return false;
    }
  }
  if (remainingBits === 0) {
    return true;
  }
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (
    (parsedAddress.bytes[fullBytes] & mask) ===
    (range.bytes[fullBytes] & mask)
  );
}

function forwardedChain(header) {
  if (
    typeof header !== "string" ||
    header.length === 0 ||
    header.length > MAX_FORWARDED_HEADER_LENGTH
  ) {
    return null;
  }
  const values = header.split(",");
  if (
    values.length === 0 ||
    values.length > MAX_FORWARDED_ENTRIES
  ) {
    return null;
  }
  const addresses = [];
  for (const value of values) {
    const address = canonicalizeIp(value.trim());
    if (!address) {
      return null;
    }
    addresses.push(address);
  }
  return addresses;
}

export function createClientIpResolver(config) {
  const normalized = normalizeTrustedProxyConfig(config);
  const ranges =
    normalized.mode === "allowlist"
      ? normalized.ranges.map(parseTrustedRange)
      : [];
  const isTrusted = (address) =>
    ranges.some((range) => matchesRange(address, range));

  return function resolveClientIp(req) {
    const socketAddress =
      canonicalizeSocketIp(req?.socket?.remoteAddress) ?? "unknown";
    if (
      normalized.mode !== "allowlist" ||
      socketAddress === "unknown" ||
      !isTrusted(socketAddress)
    ) {
      return socketAddress;
    }

    const chain = forwardedChain(req?.headers?.["x-forwarded-for"]);
    if (!chain) {
      return socketAddress;
    }
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      if (!isTrusted(chain[index])) {
        return chain[index];
      }
    }
    return chain[0];
  };
}

export const clientIpDefaults = Object.freeze({
  maxForwardedEntries: MAX_FORWARDED_ENTRIES,
  maxForwardedHeaderLength: MAX_FORWARDED_HEADER_LENGTH,
  maxTrustedRanges: MAX_TRUSTED_RANGES,
  trustedProxy: normalizeTrustedProxyConfig(),
});
