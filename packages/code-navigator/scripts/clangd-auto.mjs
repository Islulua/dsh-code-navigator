#!/usr/bin/env node
/** Start clangd with the workspace's bounded compilation-database search. */
import { readdir, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { spawn } from 'node:child_process'

const skip = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'third_party'])
const isFile = async path => { try { return (await stat(path)).isFile() } catch { return false } }
async function database(root) {
  for (const path of [join(root, 'compile_commands.json'), join(root, 'build', 'compile_commands.json'), join(root, 'out', 'build', 'compile_commands.json')]) if (await isFile(path)) return path
  const queue = [{ path: root, depth: 0 }]
  let visited = 0
  while (queue.length && visited++ < 500) {
    const current = queue.shift()
    let entries
    try { entries = await readdir(current.path, { withFileTypes: true }) } catch { continue }
    if (entries.some(entry => entry.isFile() && entry.name === 'compile_commands.json')) return join(current.path, 'compile_commands.json')
    if (current.depth === 4) continue
    for (const entry of entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !skip.has(entry.name))) queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 })
  }
  return null
}
const root = process.cwd()
const forwarded = process.argv.slice(2)
const found = forwarded.some(arg => arg.startsWith('--compile-commands-dir=')) ? null : await database(root)
const child = spawn('clangd', found === null ? forwarded : [`--compile-commands-dir=${dirname(found)}`, ...forwarded], { cwd: root, env: process.env, stdio: 'inherit' })
if (found !== null) process.stderr.write(`[dsh-code-navigator] compile_commands.json: ${relative(root, found) || 'compile_commands.json'}\n`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.once('error', error => { process.stderr.write(`[dsh-code-navigator] cannot start clangd: ${error.message}\n`); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
