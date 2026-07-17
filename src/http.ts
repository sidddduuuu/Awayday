import { ZodError } from "zod";
import { createRemoteJWKSet, jwtVerify } from "jose";

const MAX_JSON_BYTES = 64 * 1024;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
let pomeriumKeys: { route: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const responseHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

export function dataResponse(data: unknown, status = 200) {
  return Response.json({ data }, { status, headers: responseHeaders });
}

function errorResponse(error: HttpError) {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status, headers: { ...responseHeaders, ...error.headers } },
  );
}

export function handleApiError(error: unknown, context: string) {
  if (error instanceof HttpError) return errorResponse(error);
  if (error instanceof ZodError) {
    return Response.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "The request is invalid",
          details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      },
      { status: 400, headers: responseHeaders },
    );
  }
  console.error(context, error instanceof Error ? error.message : "Unknown error");
  return errorResponse(new HttpError(500, "INTERNAL_ERROR", "The request could not be completed"));
}

export async function readJson(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The request body is too large");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_JSON_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The request body is too large");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON");
  }
}

function pomeriumRoute() {
  const configured = process.env.POMERIUM_ROUTE_URL;
  if (!configured) throw new HttpError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured");
  try {
    const route = new URL(configured);
    const loopback = route.hostname === "localhost" || route.hostname === "127.0.0.1" || route.hostname === "[::1]";
    if ((route.protocol !== "https:" && !loopback) || route.username || route.password) throw new Error();
    return route;
  } catch {
    throw new HttpError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured");
  }
}

function jwks(route: URL) {
  if (pomeriumKeys?.route === route.origin) return pomeriumKeys.keys;
  const url = new URL("/.well-known/pomerium/jwks.json", route);
  const keys = createRemoteJWKSet(url, { timeoutDuration: 5_000 });
  pomeriumKeys = { route: route.origin, keys };
  return keys;
}

function jwksUnavailable(error: unknown) {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ERR_JWKS_TIMEOUT" || error.code === "ERR_JWKS_FETCH_FAILED";
}

export async function authenticatedSubject(request: Request) {
  const route = pomeriumRoute();
  const assertion = request.headers.get("x-pomerium-jwt-assertion");
  if (!assertion) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
  try {
    const { payload } = await jwtVerify(assertion, jwks(route), {
      algorithms: ["ES256"],
      issuer: route.hostname,
      audience: route.hostname,
    });
    if (
      typeof payload.sub !== "string"
      || payload.sub.length === 0
      || payload.sub.length > 255
      || /[\u0000-\u001f\u007f]/u.test(payload.sub)
      || typeof payload.exp !== "number"
    ) {
      throw new Error("Invalid subject");
    }
    return payload.sub;
  } catch (error) {
    if (jwksUnavailable(error)) {
      throw new HttpError(503, "AUTH_UNAVAILABLE", "Authentication is temporarily unavailable");
    }
    throw new HttpError(401, "AUTH_INVALID", "Authentication is invalid");
  }
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) throw new HttpError(403, "ORIGIN_REQUIRED", "A same-origin request is required");
  try {
    const expected = process.env.POMERIUM_ROUTE_URL ? pomeriumRoute().origin : new URL(request.url).origin;
    if (new URL(origin).origin !== expected) {
      throw new HttpError(403, "ORIGIN_FORBIDDEN", "Cross-origin mutations are not allowed");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(403, "ORIGIN_FORBIDDEN", "The request origin is invalid");
  }
}

export function enforceMutationRateLimit(principal: string, now = Date.now()) {
  // ponytail: process-local limiter is enough for one Akash replica; use a shared store when scaling out.
  if (rateBuckets.size > 10_000) {
    for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
  const current = rateBuckets.get(principal);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(principal, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }
  if (current.count >= RATE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1_000));
    throw new HttpError(429, "RATE_LIMITED", "Too many requests", { "Retry-After": String(retryAfter) });
  }
  current.count += 1;
}
