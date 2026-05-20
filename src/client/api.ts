import * as http from "http";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type EventTextDelta = {
  type: "session.next.text.delta";
  id: string;
  properties: { timestamp: number; sessionID: string; delta: string };
};

export type EventToolCalled = {
  type: "session.next.tool.called";
  id: string;
  properties: {
    timestamp: number;
    sessionID: string;
    callID: string;
    tool: string;
    input: Record<string, unknown>;
    provider: { executed: boolean };
  };
};

export type EventToolSuccess = {
  type: "session.next.tool.success";
  id: string;
  properties: {
    timestamp: number;
    sessionID: string;
    callID: string;
    structured: Record<string, unknown>;
    provider: { executed: boolean };
  };
};

export type EventToolFailed = {
  type: "session.next.tool.failed";
  id: string;
  properties: {
    timestamp: number;
    sessionID: string;
    callID: string;
    error: Record<string, unknown>;
    provider: { executed: boolean };
  };
};

export type EventSessionError = {
  type: "session.error";
  id: string;
  properties: { sessionID?: string; error: Record<string, unknown> };
};

export type EventSessionIdle = {
  type: "session.idle";
  id: string;
  properties: { sessionID: string };
};

export type OpenCodeEvent =
  | EventTextDelta
  | EventToolCalled
  | EventToolSuccess
  | EventToolFailed
  | EventSessionError
  | EventSessionIdle;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class OpenCodeClient {
  constructor(
    private baseUrl: string,
    private password: string = ""
  ) {}

  private authHeader(): Record<string, string> {
    if (!this.password) return {};
    const encoded = Buffer.from(`opencode:${this.password}`).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }

  private request(
    method: string,
    urlPath: string,
    body?: unknown
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, this.baseUrl);
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...this.authHeader(),
          ...(bodyStr !== undefined
            ? { "Content-Length": Buffer.byteLength(bodyStr) }
            : {}),
        },
      };

      const req = http.request(options, (res) => {
        const statusCode = res.statusCode ?? 0;

        // Reject immediately on auth failure — no need to buffer body
        if (statusCode === 401) {
          res.resume();
          return reject(
            new Error("401 Unauthorized — check opencode.password setting")
          );
        }

        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          if (statusCode < 200 || statusCode >= 300) {
            return reject(
              new Error(`HTTP ${statusCode}: ${data.trim()}`)
            );
          }
          try {
            resolve(data ? JSON.parse(data) : undefined);
          } catch {
            resolve(data);
          }
        });
      });

      req.on("error", reject);

      if (bodyStr !== undefined) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  async createSession(): Promise<string> {
    const result = (await this.request("POST", "/session", {})) as {
      id: string;
    };
    return result.id;
  }

  async sendMessage(sessionId: string, prompt: string): Promise<void> {
    await this.request("POST", `/session/${sessionId}/message`, {
      parts: [{ type: "text", text: prompt }],
    });
  }

  subscribeEvents(
    sessionId: string,
    onEvent: (event: OpenCodeEvent) => void
  ): () => void {
    let destroyed = false;
    let buffer = "";

    const url = new URL("/event", this.baseUrl);

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...this.authHeader(),
      },
    };

    let req: http.ClientRequest;

    const promise = new Promise<void>((resolve, reject) => {
      req = http.get(options, (res) => {
        const statusCode = res.statusCode ?? 0;

        if (statusCode === 401) {
          res.destroy();
          return reject(
            new Error("401 Unauthorized — check opencode.password setting")
          );
        }
        if (statusCode !== 200) {
          res.destroy();
          return reject(new Error(`HTTP ${statusCode} on /event`));
        }

        res.on("data", (chunk: Buffer) => {
          // Normalise CRLF → LF so the parser works with both line-ending styles
          buffer += chunk.toString().replace(/\r\n/g, "\n");

          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            for (const line of frame.split("\n")) {
              if (line.startsWith("data: ")) {
                const jsonStr = line.slice("data: ".length).trim();
                if (!jsonStr) continue;
                try {
                  const event = JSON.parse(jsonStr) as {
                    id: string;
                    type: string;
                    properties?: Record<string, unknown>;
                  };

                  // Filter: only drop events where properties.sessionID is
                  // defined AND does not match the target sessionId.
                  const sid = event.properties?.sessionID;
                  if (sid !== undefined && sid !== sessionId) {
                    continue;
                  }

                  onEvent(event as unknown as OpenCodeEvent);
                } catch {
                  // ignore malformed frames
                }
              }
            }
          }
        });

        res.on("end", resolve);
        res.on("error", (err) => {
          if (!destroyed) {
            console.error("SSE stream error:", err);
          }
        });
      });

      req.on("error", (err) => {
        if (!destroyed) {
          reject(err);
        }
      });
    });

    // Suppress unhandled rejection — callers use the unsubscribe fn, not the promise
    promise.catch(() => {});

    return () => {
      destroyed = true;
      buffer = "";
      req.destroy();
    };
  }
}
