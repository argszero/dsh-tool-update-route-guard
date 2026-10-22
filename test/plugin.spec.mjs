/** Integration against the real cordis runtime and the real published LLM service. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import guardPlugin, { apply } from '../lib/index.js'
import { RecordingAdapter } from './fixtures/adapter.mjs'
import { addition, recordedRequest, user } from './fixtures/history.mjs'

/** Mount the real runtime, one recording adapter per route, then the guard. */
async function harness({ routes = [{ provider: 'guarded' }], audit = false, toolUpdate = 'in-history', adapters = { guarded: toolUpdate } } = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const recorded = new Map()
  for (const [provider, capability] of Object.entries(adapters)) {
    const adapter = new RecordingAdapter(capability)
    ctx.llm.registerAdapter([provider], adapter)
    recorded.set(provider, adapter)
  }
  const fiber = ctx.plugin(guardPlugin, { routes, audit })
  await fiber
  return { ctx, adapters: recorded, fiber }
}

async function drain(ctx, request) {
  const chunks = []
  for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk)
  return chunks
}

test('a declared route that the endpoint cannot carry is projected before dispatch', async () => {
  const { ctx, adapters } = await harness()
  await drain(ctx, recordedRequest())
  const received = adapters.get('guarded').requests
  assert.equal(received.length, 1)
  assert.equal(received[0].messages.some(message => message.role === 'developer'), false)
  assert.equal(received[0].tools.some(tool => tool.deferLoading === true), false)
})

test('the projected request equals what core sends to a route that declares nothing', async () => {
  const { ctx, adapters } = await harness({
    routes: [{ provider: 'guarded' }],
    adapters: { guarded: 'in-history', plain: undefined, gated: 'in-history' },
  })
  const request = recordedRequest()
  await drain(ctx, { ...request, provider: 'guarded', model: 'declaring' })
  await drain(ctx, { ...request, provider: 'plain', model: 'declaring' })
  // `gated` declares the capability and is not covered by the guard: core itself
  // projects it, which is the shape the guarded route must reproduce.
  const guarded = adapters.get('guarded').requests.at(-1)
  const plain = adapters.get('plain').requests.at(-1)
  assert.deepEqual(guarded.messages, plain.messages)
  assert.deepEqual(guarded.tools, plain.tools)
})

test('an unmatched route still receives its developer tool-update message', async () => {
  const { ctx, adapters } = await harness({ routes: [{ provider: 'nowhere' }] })
  const request = recordedRequest()
  await drain(ctx, request)
  const received = adapters.get('guarded').requests[0]
  assert.equal(received.messages.length, 2)
  assert.equal(received.messages[1], request.messages[1])
})

test('a history without tool updates is dispatched without a replacement', async () => {
  const { ctx, adapters } = await harness()
  const request = { provider: 'guarded', model: 'declaring', messages: [user('only')], tools: [] }
  await drain(ctx, request)
  assert.equal(adapters.get('guarded').requests[0], request)
})

test('the adapter still receives a frozen request', async () => {
  const { ctx, adapters } = await harness()
  await drain(ctx, recordedRequest())
  const received = adapters.get('guarded').requests[0]
  assert.equal(Object.isFrozen(received), true)
  assert.equal(Object.isFrozen(received.messages), true)
  assert.equal(Object.isFrozen(received.tools), true)
  assert.throws(() => received.tools.push({ name: 'x' }), TypeError)
})

test('the agent-loop marker survives the replacement', async () => {
  const { ctx, adapters } = await harness()
  const request = markAgentLoopRequest(recordedRequest())
  await drain(ctx, request)
  assert.equal(isAgentLoopRequest(adapters.get('guarded').requests[0]), true)
})

test('the guard dispatches once and other listeners observe the projected request once', async () => {
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
  await drain(ctx, recordedRequest())
  assert.equal(adapter.requests.length, 1)
  assert.equal(observed.length, 1)
  assert.equal(observed[0].messages.some(message => message.role === 'developer'), false)
})

test('audit mode leaves the wire request unchanged', async () => {
  const { ctx, adapters } = await harness({ audit: true })
  const request = recordedRequest()
  await drain(ctx, request)
  const received = adapters.get('guarded').requests[0]
  assert.deepEqual(received.messages, request.messages)
  assert.equal(received.messages[1], request.messages[1])
  assert.equal(received.messages.length, 2)
})

test('disposing the plugin restores the unguarded request', async () => {
  const { ctx, adapters, fiber } = await harness()
  await drain(ctx, recordedRequest())
  assert.equal(adapters.get('guarded').requests[0].messages.length, 1)
  await fiber.dispose()
  const second = recordedRequest()
  await drain(ctx, second)
  const restored = adapters.get('guarded').requests[1]
  assert.deepEqual(restored.messages, second.messages)
  assert.equal(restored.messages[1], second.messages[1])
  assert.equal(restored.messages.length, 2)
})

test('a model glob selects one model on a shared route', async () => {
  const { ctx, adapters } = await harness({ routes: [{ model: 'declaring' }] })
  await drain(ctx, recordedRequest())
  assert.equal(adapters.get('guarded').requests[0].messages.length, 1)
  const other = { ...recordedRequest(), model: 'other' }
  await drain(ctx, other)
  assert.equal(adapters.get('guarded').requests[1].messages.length, 2)
})

test('a mounted guard with no usable route says it is inert', () => {
  const warnings = []
  const events = []
  // `apply` touches only the logger, the event bus, and — inside the handler —
  // the stream entry point, so a plain object is the whole mount surface.
  const ctx = {
    logger: { warn: message => warnings.push(message) },
    on: (event, handler, options) => events.push({ event, handler, options }),
    llm: { stream: () => { throw new Error('not dispatched here') } },
  }
  apply(ctx, { routes: [{ provider: '' }, {}] })
  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'llm/stream')
  assert.equal(events[0].options.prepend, true, 'the guard must run before other listeners')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /every configured route entry was rejected/u)
})

test('a guard with no routes configured stays silent', () => {
  const warnings = []
  apply({ logger: { warn: message => warnings.push(message) }, on: () => {}, llm: {} }, {})
  assert.deepEqual(warnings, [], 'an unmounted route list is a documented no-op, not a warning')
})

test('the plugin declares the llm service as a hard requirement', () => {
  assert.deepEqual(guardPlugin.inject, ['llm'])
  assert.equal(guardPlugin.name, '@argszero/dsh-tool-update-route-guard')
  assert.equal(typeof guardPlugin.apply, 'function')
})

test('a removal-only history is projected too', async () => {
  const { ctx, adapters } = await harness()
  await drain(ctx, {
    provider: 'guarded',
    model: 'declaring',
    messages: [user('first'), addition()],
    tools: [],
    toolHistory: { tools: [], updates: [] },
  })
  assert.equal(adapters.get('guarded').requests[0].messages.some(message => message.role === 'developer'), false)
})
