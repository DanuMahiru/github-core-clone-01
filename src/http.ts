// Shared HTTP plumbing for the four surfaces: the request the server hands its handlers and
// the response a handler answers with. Every reply carries a Content-Length, so keep-alive
// connections (the read workload's 2,000 sequential GETs on one socket) know where a response
// ends.

export interface HttpRequest {
  method: string;
  url: URL;
  headers: Map<string, string>;
  body: Buffer;
  /** The Host header, for building absolute pagination links on the entry's own origin. */
  host: string;
}

export interface HttpResponse {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    contentType: JSON_TYPE,
    body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'),
    headers,
  };
}

export function textResponse(status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): HttpResponse {
  return { status, contentType, body, headers };
}

export function emptyResponse(status: number, headers: Record<string, string> = {}): HttpResponse {
  return { status, contentType: JSON_TYPE, body: Buffer.alloc(0), headers };
}

/** Parse a request body as JSON: undefined for an empty body, an error flag when malformed. */
export function parseJsonBody(body: Buffer): { value: unknown; malformed: boolean } {
  if (body.length === 0) return { value: undefined, malformed: false };
  try {
    return { value: JSON.parse(body.toString('utf8')), malformed: false };
  } catch {
    return { value: undefined, malformed: true };
  }
}

/** Whether a value is a plain JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
