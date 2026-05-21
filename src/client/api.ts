import * as http from "http";

// ---------------------------------------------------------------------------
// Event types — matching the actual opencode serve SSE event schema
// ---------------------------------------------------------------------------

/** Text (or other field) delta streamed from the model */
export type EventMessagePartDelta = {
  type: "message.part.delta";
  id: string;
  properties: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;   // "text" | "input" | etc.
    delta: string;
  };
};

/** Session turn complete */
export type EventSessionIdle = {
  type: "session.idle";
  id: string;
  properties: { sessionID: string };
};

/** Session busy/idle/error status change */
export type EventSessionStatus = {
  type: "session.status";
  id: string;
  properties: {
    sessionID: string;
    status: { type: "busy" | "idle" | "error"; error?: unknown };
  };
};

/** Catch-all for events we don't specifically handle */
export type OpenCodeEvent =
  | EventMessagePartDelta
  | EventSessionIdle
  | EventSessionStatus
  | { type: string; id: string; properties?: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Context types (agent / model / config)
// ---------------------------------------------------------------------------

export type Agent = {
  name: string;
  description?: string;
  mode?: "subagent" | "primary" | "all";
  hidden?: boolean;
  model?: { modelID: string; providerID: string };
  variant?: string;
};

export type Model = {
  id: string;
  providerID: string;
  name: string;
  variants?: Record<string, unknown>;
  status?: "alpha" | "beta" | "deprecated" | "active";
};

export type Config = {
  model?: string;        // composite "providerID/modelID" string
  default_agent?: string;
};

/** The user's current selection — passed to POST /session as overrides */
export type CurrentSelection = {
  agent?: string;        // agent name
  modelId?: string;      // model id (e.g. "claude-sonnet-4-5")
  providerID?: string;   // provider id (e.g. "anthropic")
  variant?: string;      // variant key, if any
};

/** Minimal session descriptor returned by GET /session */
export type SessionInfo = {
  id: string;
  title: string;
  directory: string;
  time: { created: number; updated: number };
};

/** A text part inside a historical session message */
export type SessionTextPart = {
  id: string;
  messageID: string;
  type: "text";
  text: string;
};

/** One item from GET /session/:id/message */
export type SessionMessageItem = {
  info: { id: string; role: "user" | "assistant" };
  parts: Array<{ id: string; messageID: string; type: string; text?: string }>;
};

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

  async createSession(selection?: CurrentSelection): Promise<string> {
    const body: Record<string, unknown> = {};
    if (selection?.agent) body.agent = selection.agent;
    if (selection?.modelId && selection?.providerID) {
      body.model = {
        id: selection.modelId,
        providerID: selection.providerID,
        ...(selection.variant ? { variant: selection.variant } : {}),
      };
    }
    const result = (await this.request("POST", "/session", body)) as { id: string };
    return result.id;
  }

  async listAgents(): Promise<Agent[]> {
    const result = await this.request("GET", "/agent");
    return Array.isArray(result) ? (result as Agent[]) : [];
  }

  async listModels(): Promise<Model[]> {
    const result = await this.request("GET", "/api/model");
    return Array.isArray(result) ? (result as Model[]) : [];
  }

  async getConfig(): Promise<Config> {
    const result = await this.request("GET", "/config");
    return (result ?? {}) as Config;
  }

  async listSessions(): Promise<SessionInfo[]> {
    const result = await this.request("GET", "/session");
    return Array.isArray(result) ? (result as SessionInfo[]) : [];
  }

  async getSessionMessages(sessionId: string, limit = 50): Promise<SessionMessageItem[]> {
    const result = await this.request("GET", `/session/${sessionId}/message?limit=${limit}`);
    return Array.isArray(result) ? (result as SessionMessageItem[]) : [];
  }

  async sendMessage(sessionId: string, prompt: string): Promise<void> {
    await this.request("POST", `/session/${sessionId}/message`, {
      parts: [{ type: "text", text: prompt }],
    });
  }

  subscribeEvents(
    sessionId: string,
    onEvent: (event: OpenCodeEvent) => void,
    onError?: (err: Error) => void
  ): { ready: Promise<void>; unsubscribe: () => void } {
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

    const ready = new Promise<void>((resolve, reject) => {
      req = http.get(options, (res) => {
        const statusCode = res.statusCode ?? 0;

        if (statusCode === 401) {
          res.destroy();
          const err = new Error("401 Unauthorized — check opencode.password setting");
          onError?.(err);
          return reject(err);
        }
        if (statusCode !== 200) {
          res.destroy();
          const err = new Error(`HTTP ${statusCode} on /event`);
          onError?.(err);
          return reject(err);
        }

        // Stream is open — caller can now safely send the message
        resolve();

        res.on("data", (chunk: Buffer) => {
          // Normalise CRLF → LF so the parser works with both line-ending styles
          buffer += chunk.toString().replace(/\r\n/g, "\n");

          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            // Collect all data: lines in the frame and join them — handles
            // multi-line JSON payloads that span several data: lines
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith("data: ")) {
                dataLines.push(line.slice("data: ".length));
              }
            }
            if (dataLines.length === 0) continue;

            const jsonStr = dataLines.join("").trim();
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
        });

        res.on("end", () => {
          if (!destroyed) {
            onError?.(new Error("SSE stream closed unexpectedly"));
          }
        });
        res.on("error", (err) => {
          if (!destroyed) {
            onError?.(err);
          }
        });
      });

      req.on("error", (err) => {
        if (!destroyed) {
          onError?.(err);
          reject(err);
        }
      });
    });

    const unsubscribe = () => {
      destroyed = true;
      buffer = "";
      req?.destroy();
    };

    return { ready, unsubscribe };
  }
}
