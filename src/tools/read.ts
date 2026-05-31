import * as vscode from 'vscode';
import * as path from 'path';
import type { ITool, ToolExecutionContext, ToolResult } from './index';
import type { JsonSchema } from '../providers/base';

async function maybeGate(toolName: string, patterns: string[], ctx: ToolExecutionContext): Promise<void> {
  const autoApprove = vscode.workspace
    .getConfiguration('opencode')
    .get<boolean>('autoApprove.fileReads', true);
  if (autoApprove) return;
  await ctx.awaitPermission(crypto.randomUUID(), toolName, patterns);
}

export class ReadTool implements ITool {
  readonly name = 'read';
  readonly description = 'Read a file and return its contents with line numbers.';
  readonly inputSchema: JsonSchema = {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute or workspace-relative path' },
      offset:   { type: 'number', description: '1-indexed line to start from (default: 1)' },
      limit:    { type: 'number', description: 'Max lines to return (default: 2000)' },
    },
    required: ['filePath'],
  };

  async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const filePath = String(input.filePath ?? '');
    const offset   = typeof input.offset === 'number' ? Math.max(1, input.offset) : 1;
    const limit    = typeof input.limit  === 'number' ? input.limit : 2000;

    await maybeGate(this.name, [filePath], ctx);

    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(ctx.workspaceRoot, filePath);

    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved));
      const text  = Buffer.from(bytes).toString('utf-8');
      const lines = text.split('\n');
      const total = lines.length;
      const start = offset - 1; // 0-indexed
      const sliced = lines.slice(start, start + limit);
      const numbered = sliced.map((l, i) => `${start + i + 1}: ${l}`).join('\n');
      const truncNote = sliced.length < (total - start)
        ? `\n[Truncated: showing lines ${offset}–${start + sliced.length} of ${total}]`
        : '';
      return { content: numbered + truncNote };
    } catch (err) {
      return { content: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
}

export class GlobTool implements ITool {
  readonly name = 'glob';
  readonly description = 'Find files matching a glob pattern.';
  readonly inputSchema: JsonSchema = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts"' },
      path:    { type: 'string', description: 'Directory to search (default: workspace root)' },
    },
    required: ['pattern'],
  };

  async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const pattern = String(input.pattern ?? '');
    const searchPath = input.path ? String(input.path) : '';

    await maybeGate(this.name, [pattern], ctx);

    const fullPattern = searchPath ? `${searchPath}/${pattern}` : pattern;

    try {
      const uris = await vscode.workspace.findFiles(fullPattern, '**/node_modules/**', 200);
      const rootUri = vscode.Uri.file(ctx.workspaceRoot);
      const files = uris.map(u => {
        const rel = u.fsPath.startsWith(rootUri.fsPath)
          ? u.fsPath.slice(rootUri.fsPath.length).replace(/\\/g, '/').replace(/^\//, '')
          : u.fsPath;
        return rel;
      });
      const note = files.length >= 200 ? '\n[Results capped at 200]' : '';
      return { content: files.join('\n') + note };
    } catch (err) {
      return { content: `Glob failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
}

export class GrepTool implements ITool {
  readonly name = 'grep';
  readonly description = 'Search file contents with a regular expression.';
  readonly inputSchema: JsonSchema = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path:    { type: 'string', description: 'Directory to search (default: workspace root)' },
      include: { type: 'string', description: 'File glob filter, e.g. "*.ts"' },
    },
    required: ['pattern'],
  };

  async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const pattern = String(input.pattern ?? '');
    const searchPath = input.path ? String(input.path) : '';
    const include    = input.include ? String(input.include) : '**/*';

    await maybeGate(this.name, [pattern], ctx);

    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      return { content: `Invalid regex: ${pattern}`, isError: true };
    }

    const fullInclude = searchPath ? `${searchPath}/${include}` : include;

    try {
      const uris = await vscode.workspace.findFiles(fullInclude, '**/node_modules/**', 500);
      const rootUri = vscode.Uri.file(ctx.workspaceRoot);
      const matches: Array<{ file: string; line: number; text: string }> = [];

      for (const uri of uris) {
        if (matches.length >= 100) break;
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const text  = Buffer.from(bytes).toString('utf-8');
          const lines = text.split('\n');
          const rel   = uri.fsPath.startsWith(rootUri.fsPath)
            ? uri.fsPath.slice(rootUri.fsPath.length).replace(/\\/g, '/').replace(/^\//, '')
            : uri.fsPath;
          for (let i = 0; i < lines.length && matches.length < 100; i++) {
            if (regex.test(lines[i])) {
              matches.push({ file: rel, line: i + 1, text: lines[i].trim() });
            }
          }
        } catch { /* skip unreadable files */ }
      }

      return { content: JSON.stringify(matches, null, 2) };
    } catch (err) {
      return { content: `Grep failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
}
