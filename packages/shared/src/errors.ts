// Followr API error handling.
// Followr returns 4xx/5xx with bodies like:
//   { "message": "...", "errors": { "field": ["validation msg", ...] } }

export class FollowrApiError extends Error {
  override readonly name = "FollowrApiError";

  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body?: unknown,
    public readonly validationErrors?: Record<string, string[]>,
  ) {
    super(message);
  }

  static async fromResponse(response: Response, url: string): Promise<FollowrApiError> {
    let body: unknown;
    let validationErrors: Record<string, string[]> | undefined;
    let message = `${response.status} ${response.statusText}`;
    try {
      body = await response.json();
      if (typeof body === "object" && body !== null) {
        const b = body as Record<string, unknown>;
        if (typeof b["message"] === "string") {
          message = b["message"];
        }
        if (typeof b["errors"] === "object" && b["errors"] !== null) {
          validationErrors = b["errors"] as Record<string, string[]>;
        }
      }
    } catch {
      // body is not JSON
    }
    return new FollowrApiError(message, response.status, url, body, validationErrors);
  }
}

// Common Spanish error messages from Followr backend, mapped to English for MCP responses.
// AI clients converse in many languages; Claude translates the rest. This map handles
// common high-frequency messages so MCP tools return consistent English errors.
const SPANISH_TO_ENGLISH: Record<string, string> = {
  "No autenticado": "Not authenticated. Token is missing or expired.",
  "No autorizado": "Not authorized for this resource.",
  "El recurso no existe": "Resource not found.",
  "Token expirado": "Token expired. Generate a new one in Followr Settings > API Keys.",
  "Sin créditos": "Insufficient credits in your Followr plan.",
  "Solicitud inválida": "Invalid request body.",
};

export function translateError(message: string): string {
  return SPANISH_TO_ENGLISH[message] ?? message;
}
