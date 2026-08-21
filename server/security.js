import crypto from "node:crypto";

export function createSecurity(config) {
  const generalLimit = createRateLimiter({
    limit: config.rateLimitMax ?? 180,
    windowMs: config.rateLimitWindowMs ?? 60_000,
  });
  const authFailLimit = createRateLimiter({
    limit: config.authFailLimit ?? 20,
    windowMs: config.authFailWindowMs ?? 10 * 60_000,
  });

  function responseHeaders(_req, res, next) {
    setSecurityHeaders(res);
    next();
  }

  function rateLimitMiddleware(req, res, next) {
    if (!generalLimit.hit(clientKey(req))) {
      reject(res, 429, "请求过于频繁");
      return;
    }
    next();
  }

  function httpMiddleware(req, res, next) {
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.has(origin)) {
      reject(res, 403, "Origin not allowed");
      return;
    }
    if (config.accessToken && !validBearer(req.headers.authorization, config.accessToken)) {
      if (!authFailLimit.hit(clientKey(req))) {
        reject(res, 429, "请求过于频繁");
        return;
      }
      reject(res, 401, "Access token required");
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
    const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const protocolToken = readProtocolToken(request.headers["sec-websocket-protocol"]);
    return safeEqual(bearer || protocolToken, config.accessToken);
  }

  function apiErrorHandler(err, req, res, next) {
    if (res.headersSent) {
      next(err);
      return;
    }
    setSecurityHeaders(res);
    if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
      res.status(400).json({ error: "请求 JSON 无效" });
      return;
    }
    res.status(500).json({ error: "服务器内部错误" });
  }

  return {
    httpMiddleware,
    rateLimitMiddleware,
    responseHeaders,
    validateUpgrade,
    apiErrorHandler,
  };
}

function clientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function reject(res, status, error) {
  setSecurityHeaders(res);
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ error });
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:",
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

function createRateLimiter({ limit, windowMs }) {
  const buckets = new Map();
  return {
    hit(key) {
      const now = Date.now();
      const stamps = (buckets.get(key) || []).filter((at) => now - at < windowMs);
      if (stamps.length >= limit) {
        buckets.set(key, stamps);
        return false;
      }
      stamps.push(now);
      buckets.set(key, stamps);
      return true;
    },
  };
}
