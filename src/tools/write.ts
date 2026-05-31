import * as vscode from 'vscode';
import * as path from 'path';
import type { ITool, ToolExecutionContext, ToolResult } from './index';
import type { JsonSchema } from '../providers/base';

export class WriteTool implements ITool {
  readonly name = 'write';
  readonly description = 'Write full content to a file (creates or overwrites).';
  readonly inputSchema: JsonSchema = {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute or workspace-relative path to write' },
      content:  { type: 'string', description: 'Full file content to write' },
    },
    required: ['filePath', 'content'],
  };

  async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const callID    = crypto.randomUUID();
    const filePath  = String(input.filePath ?? '');
    const content   = String(input.content ?? '');
    const resolved  = path.isAbsolute(filePath) ? filePath : path.join(ctx.workspaceRoot, filePath);
    const uri       = vscode.Uri.file(resolved);

    const autoApprove = vscode.workspace
      .getConfiguration('opencode')
      .get<boolean>('autoApprove.fileWrites', false);
    if (!autoApprove) {
      await ctx.awaitPermission(callID, this.name, [resolved]);
    }

    ctx.emitEvent({
      type: 'session.next.tool.input.started',
      id: crypto.randomUUID(),
      properties: { sessionID: ctx.sessionID, callID, name: this.name },
    });

    let originalContent = '';
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      originalContent = Buffer.from(bytes).toString('utf-8');
    } catch { /* new file */ }

    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(resolved)));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
    } catch (err) {
      return { content: `Failed to write file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }

    ctx.emitEvent({
      type: 'session.next.tool.success',
      id: crypto.randomUUID(),
      properties: {
        sessionID: ctx.sessionID,
        callID,
        filePath: resolved,
        originalContent,
        newContent: content,
      },
    });

    return { content: `Successfully wrote ${filePath}` };
  }
}

export class EditTool implements ITool {
  readonly name = 'edit';
  readonly description = 'Replace the first occurrence of oldString with newString in a file.';
  readonly inputSchema: JsonSchema = {
    type: 'object',
    properties: {
      filePath:  { type: 'string', description: 'Absolute or workspace-relative path to edit' },
      oldString: { type: 'string', description: 'Exact string to find and replace (first occurrence)' },
      newString: { type: 'string', description: 'Replacement string' },
    },
    required: ['filePath', 'oldString', 'newString'],
  };

  async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const callID    = crypto.randomUUID();
    const filePath  = String(input.filePath ?? '');
    const oldString = String(input.oldString ?? '');
    const newString = String(input.newString ?? '');
    const resolved  = path.isAbsolute(filePath) ? filePath : path.join(ctx.workspaceRoot, filePath);
    const uri       = vscode.Uri.file(resolved);

    const autoApprove = vscode.workspace
      .getConfiguration('opencode')
      .get<boolean>('autoApprove.fileWrites', false);
    if (!autoApprove) {
      await ctx.awaitPermission(callID, this.name, [resolved]);
    }

    ctx.emitEvent({
      type: 'session.next.tool.input.started',
      id: crypto.randomUUID(),
      properties: { sessionID: ctx.sessionID, callID, name: this.name },
    });

    let originalContent = '';
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      originalContent = Buffer.from(bytes).toString('utf-8');
    } catch (err) {
      return { content: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }

    if (!originalContent.includes(oldString)) {
      return { content: `oldString not found in ${filePath}`, isError: true };
    }

    const newContent = originalContent.replace(oldString, newString);

    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(resolved)));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(newContent, 'utf-8'));
    } catch (err) {
      return { content: `Failed to write file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }

    ctx.emitEvent({
      type: 'session.next.tool.success',
      id: crypto.randomUUID(),
      properties: {
        sessionID: ctx.sessionID,
        callID,
        filePath: resolved,
        originalContent,
        newContent,
      },
    });

    return { content: `Successfully edited ${filePath}` };
  }
}
