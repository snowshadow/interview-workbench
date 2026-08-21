import dns from "node:dns";
import net from "node:net";

const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
]);
const LOOPBACK_HOSTS = new Set(["localhost", "localhost.localdomain", "ip6-localhost"]);

const alwaysBlocked = new net.BlockList();
alwaysBlocked.addSubnet("169.254.0.0", 16, "ipv4");
alwaysBlocked.addSubnet("fe80::", 10, "ipv6");
alwaysBlocked.addAddress("fd00:ec2::254", "ipv6");
alwaysBlocked.addAddress("100.100.100.200", "ipv4");

const privateBlocked = new net.BlockList();
privateBlocked.addSubnet("10.0.0.0", 8, "ipv4");
privateBlocked.addSubnet("172.16.0.0", 12, "ipv4");
privateBlocked.addSubnet("192.168.0.0", 16, "ipv4");
privateBlocked.addSubnet("127.0.0.0", 8, "ipv4");
privateBlocked.addSubnet("0.0.0.0", 8, "ipv4");
privateBlocked.addAddress("::1", "ipv6");
privateBlocked.addAddress("::", "ipv6");
privateBlocked.addSubnet("fc00::", 7, "ipv6");

export function loadOutboundPolicy(env = process.env) {
  return {
    blockPrivate: isTruthy(env.WORKBENCH_BLOCK_PRIVATE_PROVIDERS),
    allowlist: String(env.WORKBENCH_OUTBOUND_ALLOWLIST || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  };
}

export function assertOutboundUrl(text, policy = {}, { protocols, label = "地址" } = {}) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label}格式无效`);
  }
  if (protocols && !protocols.includes(url.protocol)) {
    throw new Error(`${label}协议无效`);
  }
  assertSafeHostname(url.hostname, policy, label);
  return url;
}

export function assertSafeIp(address, policy = {}, label = "地址") {
  const ip = normalizeIp(address);
  const kind = net.isIPv6(ip) ? "ipv6" : "ipv4";
  if (!net.isIP(ip) || alwaysBlocked.check(ip, kind)) {
    throw new Error(`${label}不可用`);
  }
  if (policy.blockPrivate && privateBlocked.check(ip, kind)) {
    throw new Error(`${label}不可用`);
  }
}

export function createSafeLookup(policy = {}, lookupFn = dns.lookup.bind(dns)) {
  return (hostname, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const wantAll = Boolean(options.all);
    try {
      assertSafeHostname(hostname, policy);
    } catch (error) {
      callback(error);
      return;
    }
    lookupFn(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }
      const records = normalizeLookupRecords(addresses);
      try {
        for (const record of records) assertSafeIp(record.address, policy);
      } catch (blocked) {
        callback(blocked);
        return;
      }
      if (wantAll) {
        callback(null, records);
        return;
      }
      callback(null, records[0].address, records[0].family);
    });
  };
}

function assertSafeHostname(hostname, policy, label = "地址") {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (policy.allowlist?.length && !policy.allowlist.includes(host)) {
    throw new Error(`${label}不在允许的出站名单中`);
  }
  if (BLOCKED_HOSTS.has(host)) {
    throw new Error(`${label}不可用`);
  }
  if (net.isIP(host)) {
    assertSafeIp(host, policy, label);
    return;
  }
  if (policy.blockPrivate && LOOPBACK_HOSTS.has(host)) {
    throw new Error(`${label}不可用`);
  }
}

function normalizeIp(address) {
  const value = String(address || "");
  if (value.toLowerCase().startsWith("::ffff:")) return value.slice(7);
  return value;
}

function normalizeLookupRecords(addresses) {
  if (Array.isArray(addresses)) {
    return addresses.map((item) => (
      typeof item === "string" ? { address: item, family: net.isIPv6(item) ? 6 : 4 } : item
    ));
  }
  return [{ address: addresses, family: net.isIPv6(addresses) ? 6 : 4 }];
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}
