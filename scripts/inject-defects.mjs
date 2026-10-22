/**
 * Mutation gate for the guard.
 *
 * Each mutant is one deliberate defect injected into `lib/index.js`; the whole
 * test suite then runs against it. A mutant the suite still passes is a gap in
 * the suite, not a better plugin, so this script fails when any mutant
 * survives.
 *
 * The unmutated control runs first and must be green with zero failures before
 * any mutant is scored — a control that fails for an unrelated reason would
 * otherwise mark every mutant "caught".
 *
 * Run: node scripts/inject-defects.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = resolve(ROOT, 'lib/index.js')
const original = readFileSync(TARGET, 'utf8')

/** One replacement each: `find` must occur exactly once in the source. */
const MUTANTS = [
  ['recursion guard removed', 'if (dispatched.has(options)) return next()', 'if (false) return next()'],
  ['redispatch is not recorded', 'dispatched.add(replacement)\n', ''],
  ['route matching inverted', 'if (!matchesRoute(routes, options.provider, options.model)) return next()', 'if (matchesRoute(routes, options.provider, options.model)) return next()'],
  ['route matching disabled', 'if (!matchesRoute(routes, options.provider, options.model)) return next()', 'if (false) return next()'],
  ['glob unanchored at the end', 'return new RegExp(`^${body}$`, \'u\').test(value)', 'return new RegExp(`^${body}`, \'u\').test(value)'],
  ['glob unanchored at the start', 'return new RegExp(`^${body}$`, \'u\').test(value)', 'return new RegExp(`${body}$`, \'u\').test(value)'],
  ['literal pattern matches everything', 'if (!pattern.includes(\'*\')) return pattern === value', 'if (!pattern.includes(\'*\')) return true'],
  ['empty pattern matches everything', 'if (typeof pattern !== \'string\' || pattern.length === 0) return false', 'if (typeof pattern !== \'string\') return false\n  if (pattern.length === 0) return true'],
  ['provider constraint ignored', 'if (route.provider !== undefined && !matchPattern(route.provider, provider)) return false', 'if (false) return false'],
  ['model constraint ignored', 'if (route.model !== undefined && !matchPattern(route.model, model)) return false', 'if (false) return false'],
  ['routes were never a list', 'if (!Array.isArray(routes)) return []', 'if (Array.isArray(routes)) return []'],
  ['unconstrained entries admitted', '.filter(route => route.provider !== undefined || route.model !== undefined)', '.filter(() => true)'],
  ['projection declares the capability back', 'projectToolUpdates(options.messages, options.tools, undefined, options.toolHistory)', 'projectToolUpdates(options.messages, options.tools, \'in-history\', options.toolHistory)'],
  ['projection keeps deferred declarations', 'const deferred = projected.tools === options.tools', 'const deferred = true'],
  ['deferred count counts every tool', '.filter(tool => tool.deferLoading === true).length', '.length'],
  ['removals are not counted', 'else if (block.type === \'tool-removal\') removals += 1', 'else if (block.type === \'tool-removal\') removals += 0'],
  ['additions are not counted', 'if (block.type === \'tool-addition\') additions += 1', 'if (block.type === \'tool-addition\') additions += 0'],
  ['agent-loop marker dropped', 'if (isAgentLoopRequest(options)) markAgentLoopRequest(copy)', 'void isAgentLoopRequest'],
  ['replacement left unfrozen', '  Object.freeze(copy)\n', ''],
  ['replacement keeps an absent tool list', 'if (tools === undefined) delete copy.tools\n  else copy.tools = Object.isFrozen(tools) ? tools : Object.freeze([...tools])', 'copy.tools = Object.isFrozen(tools) ? tools : Object.freeze([...(tools ?? [])])'],
  ['messages left unfrozen', 'messages: Object.isFrozen(messages) ? messages : Object.freeze([...messages])', 'messages'],
  ['audit mode changes the request anyway', '      if (audit) {', '      if (false) {'],
  ['audit counter never moves', '        stats.projected += 1\n        stats.additions += projected.additions', '        stats.additions += projected.additions'],
  ['warning repeated every request', '    if (reported.has(key)) return\n', ''],
  ['listener not prepended', ', { prepend: true })', ')'],
  ['failure rejects the request', '      return next()\n    }\n  }\n\n  function warnOnce', '      throw _projectionFailed\n    }\n  }\n\n  function warnOnce'],
  ['inert mount stays silent', 'if (guard.routes.length === 0 && config?.routes !== undefined) {', 'if (false) {'],
  ['inert mount warns on every mount', 'if (guard.routes.length === 0 && config?.routes !== undefined) {', 'if (guard.routes.length === 0) {'],
  ['service requirement dropped', 'export const inject = [\'llm\']', 'export const inject = []'],
  ['default export loses its inject', 'export default { name, inject, apply }', 'export default { name, apply }'],
  ['service requirement left optional', 'export const inject = [\'llm\']', 'export const inject = [{ required: false, name: \'llm\' }]'],
]

/** Run the suite once; returns `{ok, total, failed}`. */
function runSuite() {
  try {
    const out = execFileSync(process.execPath, ['--test', 'test/*.spec.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    return parse(out, true)
  } catch (error) {
    return parse(`${error.stdout ?? ''}${error.stderr ?? ''}`, false)
  }
}

/** Read node's test-runner summary. */
function parse(output, ok) {
  const total = /^# tests (\d+)$/mu.exec(output.replace(/^ℹ /gmu, '# '))?.[1]
  const failed = /^# fail (\d+)$/mu.exec(output.replace(/^ℹ /gmu, '# '))?.[1]
  return { ok, total: Number(total), failed: Number(failed) }
}

function restore() {
  writeFileSync(TARGET, original)
}

const control = runSuite()
if (!control.ok || control.failed !== 0 || !(control.total > 0)) {
  restore()
  console.error(`control failed: ok=${control.ok} failed=${control.failed} total=${control.total}`)
  process.exit(1)
}
console.log(`control: ${control.total} tests, ${control.failed} failed`)

let survived = 0
for (const [label, find, replacement] of MUTANTS) {
  const occurrences = original.split(find).length - 1
  if (occurrences !== 1) {
    restore()
    console.error(`mutant "${label}" is not applicable: anchor occurs ${occurrences} times`)
    process.exit(1)
  }
  writeFileSync(TARGET, original.replace(find, replacement))
  const result = runSuite()
  if (result.ok && result.failed === 0) {
    survived += 1
    console.log(`SURVIVED  ${label}`)
  } else {
    console.log(`caught    ${label} (fail ${result.failed}/${result.total})`)
  }
}
restore()
console.log(`\n${MUTANTS.length} mutants, ${MUTANTS.length - survived} caught, ${survived} survived`)
process.exit(survived === 0 ? 0 : 1)
