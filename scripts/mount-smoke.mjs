/**
 * Mount smoke on the published cordis runtime.
 *
 * The unit suite already mounts the guard on a real `Context`; this script is
 * the standalone reading a maintainer or a reviewer can run in one command. It
 * mounts `@deepseek-ai/cordis` and the published LLM service, dispatches one
 * request through the real `llm/stream` waterfall, and reports what the
 * adapter received, whether a second listener saw the replacement once, and
 * whether disposing the plugin restores the unguarded request.
 *
 * Run: node scripts/mount-smoke.mjs
 */
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'

import guardPlugin from '../lib/index.js'
import { RecordingAdapter } from '../test/fixtures/adapter.mjs'
import { recordedRequest } from '../test/fixtures/history.mjs'

const ctx = new Context()
await ctx.plugin(LlmRuntime)

const adapter = new RecordingAdapter('in-history')
ctx.llm.registerAdapter(['guarded'], adapter)

const observed = []
ctx.on('llm/stream', (options, next) => {
  observed.push(options)
  return next()
})

const fiber = ctx.plugin(guardPlugin, { routes: [{ provider: 'guarded' }] })
await fiber

const drain = async request => {
  const chunks = []
  for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk)
  return chunks
}

await drain(recordedRequest())
const guarded = adapter.requests[0]
assert.equal(adapter.requests.length, 1, 'exactly one request may reach the adapter')
assert.equal(observed.length, 1, 'other listeners must observe the request once')
assert.equal(observed[0], guarded, 'the observed request is the one that went out')
assert.equal(guarded.messages.some(message => message.role === 'developer'), false, 'developer tool-update messages must be projected out')
assert.equal(guarded.tools.some(tool => tool.deferLoading === true), false, 'deferred declarations must be cleared')
assert.equal(Object.isFrozen(guarded), true, 'the adapter still observes a frozen request')
assert.equal((await drain(recordedRequest())).length, 1, 'a second dispatch behaves the same')
const snapshot = {
  requests: adapter.requests.length,
  observed: observed.length,
  frozen: Object.isFrozen(guarded),
}

await fiber.dispose()
const second = recordedRequest()
await drain(second)
const restored = adapter.requests.at(-1)
assert.equal(restored.messages.length, 2, 'after dispose the developer message must be sent again')
assert.equal(restored.messages[1], second.messages[1], 'and it must be the caller’s own message object')

console.log('mount smoke: PASS')
console.log(`  requests reaching the adapter after two dispatches: ${snapshot.requests}`)
console.log(`  listeners observing the request: ${snapshot.observed}`)
console.log(`  request frozen at the adapter: ${snapshot.frozen}`)
console.log(`  teardown observable: ${restored.messages.length === 2}`)
