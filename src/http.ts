import { ZodError } from "zod";

const MAX_JSON_BYTES = 64 * 1024;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

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

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) {
      throw new HttpError(403, "ORIGIN_FORBIDDEN", "Cross-origin mutations are not allowed");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(403, "ORIGIN_FORBIDDEN", "The request origin is invalid");
  }
}

function rateLimitKey(request: Request) {
  return (request.headers.get("x-forwarded-for")?.split(",", 1)[0] || "unknown").trim().slice(0, 128);
}

export function enforceMutationRateLimit(request: Request, now = Date.now()) {
  // ponytail: process-local limiter is enough for one Akash replica; use a shared store when scaling out.
  if (rateBuckets.size > 10_000) {
    for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
  const key = rateLimitKey(request);
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }
  if (current.count >= RATE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1_000));
    throw new HttpError(429, "RATE_LIMITED", "Too many mission requests", { "Retry-After": String(retryAfter) });
  }
  current.count += 1;
}
