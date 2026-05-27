export interface ToolMeta {
  icon: string;
  label: string;
}

export const TOOL_META: Record<string, ToolMeta> = {
  // opencode built-in tools (lowercase, as they appear in SSE events)
  read:       { icon: '📖', label: 'Read file' },
  write:      { icon: '✏️', label: 'Write file' },
  edit:       { icon: '📝', label: 'Edit file' },
  bash:       { icon: '💻', label: 'Run command' },
  glob:       { icon: '🔍', label: 'Find files' },
  grep:       { icon: '🔎', label: 'Search files' },
  webfetch:   { icon: '🌐', label: 'Web fetch' },
  todowrite:  { icon: '📋', label: 'Update todos' },
  task:       { icon: '🤖', label: 'Sub-agent' },
  // Capitalised variants (MCP-style or alternate naming)
  Read:       { icon: '📖', label: 'Read file' },
  Write:      { icon: '✏️', label: 'Write file' },
  Edit:       { icon: '📝', label: 'Edit file' },
  Bash:       { icon: '💻', label: 'Run command' },
  Glob:       { icon: '🔍', label: 'Find files' },
  Grep:       { icon: '🔎', label: 'Search files' },
  WebFetch:   { icon: '🌐', label: 'Web fetch' },
};

const FALLBACK: ToolMeta = { icon: '🔧', label: '' };

export function getToolMeta(toolName: string): ToolMeta {
  return TOOL_META[toolName] ?? { icon: FALLBACK.icon, label: toolName };
}
