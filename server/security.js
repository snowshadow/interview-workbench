import crypto from "node:crypto";

export function createSecurity(config) {
  function responseHeaders(_req, res, next) {
    setSecurityHeaders(res);
    next();
  }

  function httpMiddleware(req, res, next) {
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.has(origin)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    if (config.accessToken && !validBearer(req.headers.authorization, config.accessToken)) {
      res.status(401).json({ error: "Access token required" });
      return;
    }
    setSecurityHeaders(res);
    res.setHeader("Cache-Control", "no-store");
    next();
  }

  function validateUpgrade(request) {
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.has(origin)) return false;
    if (!config.accessToken) return true;
    const url = new URL(request.url || "/", "http://localhost");
    const queryToken = url.searchParams.get("token") || "";
    const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const protocolToken = readProtocolToken(request.headers["sec-websocket-protocol"]);
    return safeEqual(queryToken || bearer || protocolToken, config.accessToken);
  }

  return { httpMiddleware, responseHeaders, validateUpgrade };
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:",
  );
}

function readProtocolToken(header) {
  const protocol = String(header || "")
    .split(",")
    .map((item) => item.trim())
    .find((item) => item.startsWith("auth."));
  if (!protocol) return "";
  try {
    return Buffer.from(protocol.slice(5), "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function validBearer(header, expected) {
  const value = String(header || "").replace(/^Bearer\s+/i, "");
  return safeEqual(value, expected);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
