import * as cp from 'child_process';
import * as vscode from 'vscode';
import type { ITool, ToolExecutionContext, ToolResult } from './index';
import type { JsonSchema } from '../providers/base';

export class BashTool implements ITool {
  readonly name = 'bash';
  readonly description = 'Execute a shell command in the workspace directory.';
  readonly inputSchema: JsonSchema = {
    type: 'object',
    properties: {
      command:     { type: 'string', description: 'Shell command to execute' },
      description: { type: 'string', description: 'Human-readable description of what the command does' },
      timeout:     { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
    },
    required: ['command'],
  };

  async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const command     = String(input.command ?? '');
    const description = String(input.description ?? command);
    const timeout     = typeof input.timeout === 'number' ? input.timeout : 30_000;

    if (!command.trim()) {
      return { content: 'No command provided', isError: true };
    }

    const autoApprove = vscode.workspace
      .getConfiguration('opencode')
      .get<boolean>('autoApprove.commands', false);
    if (!autoApprove) {
      await ctx.awaitPermission(crypto.randomUUID(), this.name, [description]);
    }

    const isWin = process.platform === 'win32';
    const shell  = isWin ? 'cmd'  : 'sh';
    const args   = isWin ? ['/c', command] : ['-c', command];

    return new Promise<ToolResult>((resolve) => {
      const chunks: string[] = [];

      const child = cp.spawn(shell, args, {
        cwd:   ctx.workspaceRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
      child.stderr?.on('data', (d: Buffer) => chunks.push(d.toString()));

      const timer = setTimeout(() => {
        child.kill();
        resolve({
          content: `Command timed out after ${timeout}ms.\n${chunks.join('')}`,
          isError: true,
        });
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(timer);
        const output = chunks.join('').trim();
        resolve({
          content: `Exit code: ${code ?? '?'}\n${output}`,
          isError: (code ?? 0) !== 0,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ content: `Spawn error: ${err.message}`, isError: true });
      });
    });
  }
}
