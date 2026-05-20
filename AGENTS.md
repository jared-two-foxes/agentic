# AGENTS.md — opencode-vscode

VSCode extension (extension host + Svelte webview) backed by `opencode serve`.

## Toolchain

| Key              | Value                                      |
|------------------|--------------------------------------------|
| `BUILD_CMD`      | `npm run build`                            |
| `TEST_CMD`       | _(none)_                                   |
| `FMT_CHECK_CMD`  | _(none)_                                   |
| `FMT_FIX_CMD`    | _(none)_                                   |
| `LINT_CMD`       | _(none)_                                   |
| `TYPECHECK_CMD`  | `npx tsc --noEmit`                         |
| `GIT_WORKFLOW`   | trunk-based                                |

## Build pipeline — two separate bundlers

`npm run build` runs both steps in order:

1. **`npm run build:webview`** — Vite bundles `webview/` → `dist/webview/`
   - Config: `vite.config.mts`; root is `webview/`, `base: './'`
   - Output: `dist/webview/index.html` + hashed JS/CSS assets
   - Svelte 4 via `@sveltejs/vite-plugin-svelte`

2. **`npm run build:ext`** — esbuild bundles `src/extension.ts` → `dist/extension.js`
   - Config: `esbuild.mjs`; format CJS, platform node, `vscode` external
   - `npm run watch` runs esbuild in watch mode only (not Vite)

`tsconfig.json` covers only `src/**/*.ts` (extension host). The webview TypeScript is handled entirely by Vite/esbuild — `tsc --noEmit` will not type-check `webview/`.

## Directory layout

```
src/          Extension host TypeScript (compiled by esbuild → dist/extension.js)
webview/      Svelte app (compiled by Vite → dist/webview/)
dist/         Build output — gitignored, excluded from .vsix via .vscodeignore
scratch-notes/ Planning docs — excluded from .vsix
```

## Key constraints

- **`vscode` is external** in esbuild — never import it in webview code.
- **CSP nonce required** — the webview HTML must inject a random nonce into every `<script>` tag at serve time; hardcoded nonces break the extension.
- **Webview asset URIs** — all asset paths must go through `webview.asWebviewUri()`; relative paths from `dist/webview/` won't resolve inside the panel.
- **View ID** — the sidebar panel is registered as `opencode.chatView`; this string must match in both `ChatPanel.ts` and `package.json` `contributes.views`.
- **Activation event** — currently `onStartupFinished`; add `onView:opencode.chatView` when the view contribution is declared so the extension activates when the panel is revealed.

## Packaging

```
npm run package   # runs vsce package → opencode-vscode-0.0.1.vsix
```

`.vscodeignore` excludes `src/`, `webview/`, `scripts/`, `scratch-notes/`, `node_modules/`, `*.map`.

## Backlog

Development tasks are tracked in `scratch-notes/backlog.md` as a Markdown checklist. Mark items `- [x]` when complete.
