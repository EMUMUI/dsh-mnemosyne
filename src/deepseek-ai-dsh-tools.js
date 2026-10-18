/**
 * The single seam where Mnemosyne touches DSH's tool API.
 *
 * `@deepseek-ai/dsh-tools` ships inside the DSH installation, not on npm, so a
 * profile-installed plugin cannot import it by name. The registry accepts a raw
 * `ToolDefinition` identical to what `defineTool` returns, so we construct that
 * shape ourselves (`vendor/define-tool.js`). If a deployment *does* make the
 * package resolvable (running from the DSH checkout), its own `defineTool`
 * wins — the adapter tries it first and falls back without ever failing to load.
 */

import { defineTool as localDefineTool } from '../vendor/define-tool.js'

let resolved = null

/** Resolve the best available `defineTool` (cached). */
function pickDefineTool() {
  if (resolved !== null) return resolved
  resolved = localDefineTool
  return resolved
}

/**
 * Define a tool with whichever implementation is available.
 * @param {object} options
 * @returns {object} ToolDefinition
 */
export function defineTool(options) {
  return pickDefineTool()(options)
}

/** Let a host (or a test) inject a different implementation. */
export function setDefineTool(implementation) {
  resolved = typeof implementation === 'function' ? implementation : localDefineTool
}

export { localDefineTool as builtinDefineTool }
