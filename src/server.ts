import * as vscode from "vscode";
import * as cp from "child_process";
import * as http from "http";

export type ServerStatus = {
  value: "connecting" | "ready" | "error";
  message?: string;
};

export class ServerManager {
  private child: cp.ChildProcess | undefined;
  private outputChannel: vscode.OutputChannel;
  onStatusChange?: (status: ServerStatus) => void;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel("opencode server");
  }

  async start(): Promise<void> {
    const config = vscode.workspace.getConfiguration("opencode");
    const port: number = config.get("port") ?? 4096;
    const binaryPath: string = config.get("binaryPath") || "opencode";

    this.outputChannel.show(true);

    this.onStatusChange?.({ value: "connecting" });

    return new Promise((resolve, reject) => {
      let child: cp.ChildProcess;
      try {
        child = cp.spawn(binaryPath, ["serve", "--port", String(port)], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        this._handleSpawnError(err, reject);
        return;
      }

      this.child = child;

      child.stdout?.on("data", (data: Buffer) => {
        this.outputChannel.append(data.toString());
      });
      child.stderr?.on("data", (data: Buffer) => {
        this.outputChannel.append(data.toString());
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        this._handleSpawnError(err, reject);
      });

      child.on("exit", (code) => {
        this.outputChannel.appendLine(`[opencode] process exited with code ${code}`);
      });

      this._pollReady(port, 10_000).then(() => {
        this.onStatusChange?.({ value: "ready" });
        resolve();
      }).catch((err: Error) => {
        this.onStatusChange?.({ value: "error", message: err.message });
        reject(err);
      });
    });
  }

  private _handleSpawnError(err: unknown, reject: (e: Error) => void): void {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      vscode.window.showErrorMessage(
        "opencode binary not found. Install from https://opencode.ai",
        "Open Docs"
      ).then((choice) => {
        if (choice === "Open Docs") {
          vscode.env.openExternal(vscode.Uri.parse("https://opencode.ai"));
        }
      });
    }
    this.onStatusChange?.({ value: "error", message: nodeErr.message });
    reject(nodeErr);
  }

  private _pollReady(port: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      let delay = 1000;

      const attempt = () => {
        http.get(`http://localhost:${port}/`, (res) => {
          res.resume(); // drain
          resolve();
        }).on("error", () => {
          const now = Date.now();
          if (now >= deadline) {
            reject(new Error(`opencode server did not become ready within ${timeoutMs}ms`));
            return;
          }
          // Clamp delay so we don't overshoot the deadline
          const remaining = deadline - now;
          const wait = Math.min(delay, remaining);
          setTimeout(attempt, wait);
          delay = Math.min(delay * 2, 8000);
        });
      };

      attempt();
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      return;
    }

    return new Promise((resolve) => {
      const forceKillTimer = setTimeout(() => {
        // Force-kill: SIGKILL on Unix, terminate on Windows
        if (process.platform === "win32") {
          child.kill();
        } else {
          process.kill(child.pid!, 9);
        }
        resolve();
      }, 2000);

      child.once("exit", () => {
        clearTimeout(forceKillTimer);
        resolve();
      });

      // SIGTERM not supported on Windows child processes via process.kill;
      // child.kill() with no arg sends SIGTERM on Unix, terminates on Windows.
      child.kill("SIGTERM");
    });
  }
}
