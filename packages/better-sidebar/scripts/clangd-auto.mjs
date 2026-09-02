#!/usr/bin/env node

/**
 * Start clangd with the nearest compilation database below the workspace.
 * dsh-lsp-stdio launches this command with the canonical workspace as cwd.
 */
import { readdir, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { spawn } from 'node:child_process'

const MAX_DEPTH = 4
const MAX_DIRECTORIES = 500
const SKIP = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'third_party'])

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function findCompilationDatabase(root) {
  const preferred = [
    join(root, 'compile_commands.json'),
    join(root, 'build', 'compile_commands.json'),
    join(root, 'out', 'build', 'compile_commands.json'),
  ]
  for (const path of preferred) if (await isFile(path)) return path

  const queue = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < MAX_DIRECTORIES) {
    const current = queue.shift()
    if (current === undefined) break
    visited += 1
    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'compile_commands.json') return join(current.dir, entry.name)
    }
    if (current.depth >= MAX_DEPTH) continue
    const directories = entries
      .filter(entry => entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith('.'))
      .sort((left, right) => {
        const rank = name => /^(build|out|cmake-build)/i.test(name) ? 0 : 1
        return rank(left.name) - rank(right.name) || left.name.localeCompare(right.name)
      })
    for (const entry of directories) queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 })
  }
  return null
}

const root = process.cwd()
const forwarded = process.argv.slice(2)
const hasExplicitDatabase = forwarded.some(arg => arg.startsWith('--compile-commands-dir='))
const database = hasExplicitDatabase ? null : await findCompilationDatabase(root)
const args = database === null
  ? forwarded
  : [`--compile-commands-dir=${dirname(database)}`, ...forwarded]

if (database !== null) {
  process.stderr.write(`[dsh-code-navigator] compile_commands.json: ${relative(root, database) || 'compile_commands.json'}\n`)
}

const child = spawn('clangd', args, { cwd: root, env: process.env, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { child.kill(signal) })
}
child.once('error', error => {
  process.stderr.write(`[dsh-code-navigator] cannot start clangd: ${error.message}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.exitCode = signal === null ? code ?? 1 : 1
})
