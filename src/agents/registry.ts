import * as vscode from 'vscode';
import * as path from 'path';
import type { AgentDefinition, AgentConfigFile } from './types';
import { isAgentDefinition } from './types';
import { BUILTIN_AGENTS } from './builtins';

export class AgentRegistry {
  private readonly _agents = new Map<string, AgentDefinition>();
  private _outputChannel?: vscode.OutputChannel;

  setOutputChannel(ch: vscode.OutputChannel): void {
    this._outputChannel = ch;
  }

  loadBuiltins(): void {
    for (const agent of BUILTIN_AGENTS) {
      this._agents.set(agent.name, agent);
    }
  }

  async load(workspaceRoot: string): Promise<void> {
    const agentsDir = vscode.Uri.file(path.join(workspaceRoot, '.opencode', 'agents'));
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(agentsDir);
    } catch {
      return; // directory doesn't exist — fine
    }

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
      const fileUri = vscode.Uri.joinPath(agentsDir, name);
      try {
        const raw = await vscode.workspace.fs.readFile(fileUri);
        const parsed: AgentConfigFile = JSON.parse(Buffer.from(raw).toString('utf8'));
        const definitions = Array.isArray(parsed) ? parsed : [parsed];
        for (const def of definitions) {
          if (!isAgentDefinition(def)) {
            this._log(`[agents] Skipped malformed definition in ${name}`);
            continue;
          }
          this._agents.set(def.name, def); // workspace overrides builtin
        }
      } catch (err) {
        this._log(`[agents] Failed to parse ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  get(name: string): AgentDefinition | undefined {
    return this._agents.get(name);
  }

  list(): AgentDefinition[] {
    return [...this._agents.values()]
      .filter(a => !a.hidden)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  listAll(): AgentDefinition[] {
    return [...this._agents.values()];
  }

  watch(
    context: vscode.ExtensionContext,
    workspaceRoot: string,
    onReload: () => void,
  ): void {
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(path.join(workspaceRoot, '.opencode', 'agents')),
      '*.json',
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const reload = () => {
      this.loadBuiltins();
      this.load(workspaceRoot).then(onReload).catch(() => {});
    };
    context.subscriptions.push(
      watcher.onDidCreate(reload),
      watcher.onDidChange(reload),
      watcher.onDidDelete(reload),
      watcher,
    );
  }

  private _log(msg: string): void {
    this._outputChannel?.appendLine(msg);
    console.warn(msg);
  }
}
