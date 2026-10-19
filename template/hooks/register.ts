import type { Register } from 'claude-code'

// Starter mod: shows which tool Claude is using in the status bar.
// Copy this folder, rename it, change "name" in .claude-plugin/plugin.json, and build from here.
export const register: Register = on => {
  on('tool.call', ($, e, next) => {
    $.ui.status(`Claude is using: ${e.tool}`)
    return next(e)
  })
}
