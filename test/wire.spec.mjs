/**
 * Line-level evidence: what the published Messages-API serializer actually puts
 * on the wire for a request this plugin projects.
 *
 * The unit suite proves the projection equals what core sends to a route that
 * declares nothing, using a recording adapter. That is a reading of the request
 * object. This file takes the second, independent reading the artifact needs:
 * it drives the real upstream adapter
 * (`@deepseek-ai/dsh-llm-deepseek@0.2.1-rc.2`) with a capturing `fetch`, and
 * asserts on the HTTP body and headers the adapter builds.
 *
 * Two arms, because an absence on its own proves nothing:
 *   - control: the same request, unprojected, must reach the wire carrying
 *     `tool_addition` blocks and the `mid-conversation-tool-changes-2026-07-01`
 *     beta header — this is what the reported session sends and what the
 *     endpoint rejects;
 *   - guarded: the same request through the guard must carry neither, while
 *     every other part of the body survives.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'

import { createGuard } from '../lib/index.js'
import { added, addition, baseline, recordedRequest, removal } from './fixtures/history.mjs'

/** The beta the Messages API requires before it accepts mid-conversation changes. */
const TOOL_CHANGES_BETA = 'mid-conversation-tool-changes-2026-07-01'

/**
 * One minimal, well-formed Messages event stream.
 * A stream that stops without `message_stop` is an error the adapter reports,
 * so the stub answers with a complete turn; that also proves the projected
 * request is acceptable to the adapter's own translator rather than merely
 * sent.
 */
const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

const connection = resolveAdapterOptions({
  baseURL: 'http://127.0.0.1:9',
  models: [{ id: 'declaring', toolUpdate: 'in-history' }],
})

/**
 * Build the real adapter over a capturing transport.
 * The adapter reaches for the global `fetch`, so the capture is installed for
 * the duration of one test and restored afterwards.
 * @param captures - array the outgoing request is recorded into.
 * @returns the adapter, plus a restore function for the global transport.
 */
function adapter(captures) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captures.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
    return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const instance = new DeepSeekAdapter({
    options: () => connection,
    resolveAuth: async () => ({ headers: { 'x-api-key': 'probe' } }),
    resolveUserId: () => 'probe-user',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  })
  return { instance, restore: () => { globalThis.fetch = original } }
}

/**
 * Run one request to completion and return what went out.
 * @param options - request as assembled by the caller (the plugin's envelope shape
 *   is the adapter's `GenerateOptions` here, so the projected request can be
 *   handed over unchanged).
 * @returns the captured HTTP conversation.
 */
async function transcribe(options) {
  const captures = []
  const { instance, restore } = adapter(captures)
  try {
    // The stub answers 200 with an empty SSE stream, so the iterator ends at
    // once; the capture is already recorded by then.
    for await (const _chunk of instance.stream(options)) { /* drain */ }
  } finally {
    restore()
  }
  assert.equal(captures.length, 1, 'one request must reach the transport')
  return captures[0]
}

/** Every wire block type carried anywhere in the body's messages. */
const blockTypes = body => body.messages.flatMap(message => message.content.map(block => block.type))

test('the unguarded request really does reach the wire carrying tool changes', async () => {
  const sent = await transcribe(recordedRequest())
  const types = blockTypes(sent.body)
  assert.ok(types.includes('tool_addition'), `expected a tool_addition block, saw ${types.join(',')}`)
  assert.equal(sent.body.messages.filter(message => message.role === 'system').length, 1)
  assert.match(sent.headers['anthropic-beta'] ?? '', new RegExp(TOOL_CHANGES_BETA, 'u'))
  assert.equal(sent.headers['anthropic-version'], '2023-06-01')
})

test('the guarded request reaches the wire with no tool changes and no beta header', async () => {
  const guard = createGuard({ routes: [{ model: 'declaring' }] })
  const unguarded = recordedRequest()
  let sent
  guard.handle(
    replacement => {
      sent = replacement
      return { stream: replacement }
    },
    unguarded,
    () => { throw new Error('the guard must redispatch, not continue') },
  )
  assert.notEqual(sent, undefined, 'the guard must hand over a replacement request')

  const wire = await transcribe(sent)
  const types = blockTypes(wire.body)
  assert.ok(!types.includes('tool_addition'), `tool_addition survived on the wire: ${types.join(',')}`)
  assert.ok(!types.includes('tool_removal'), `tool_removal survived on the wire: ${types.join(',')}`)
  assert.equal(wire.headers['anthropic-beta'], undefined, 'no beta header may be sent for a projected request')
  assert.equal(wire.headers['x-api-key'], 'probe', 'the credential headers must still be sent')
})

test('both tool additions and removals disappear, and the rest of the history survives', async () => {
  const guard = createGuard({ routes: [{ provider: 'guarded' }] })
  const unguarded = recordedRequest([addition(), removal()])
  let sent
  guard.handle(replacement => { sent = replacement; return { stream: replacement } }, unguarded, () => assert.fail('expected a replacement'))
  const wire = await transcribe(sent)

  const types = blockTypes(wire.body)
  assert.ok(!types.includes('tool_addition') && !types.includes('tool_removal'), types.join(','))
  assert.equal(wire.body.messages.filter(message => message.role === 'system').length, 0, 'no tool-update system turn may remain')
  assert.equal(wire.body.messages[0].role, 'user')
  assert.equal(wire.body.messages[0].content[0].text, 'first', 'the user turn must be intact')
  assert.equal(wire.headers['anthropic-beta'], undefined)
})

test('a route the operator did not name keeps its tool changes on the wire', async () => {
  const guard = createGuard({ routes: [{ model: 'some-other-model' }] })
  const unguarded = recordedRequest()
  let sent
  guard.handle(replacement => { sent = replacement; return { stream: replacement } }, unguarded, () => { sent = unguarded; return { stream: unguarded } })
  const wire = await transcribe(sent)

  assert.ok(blockTypes(wire.body).includes('tool_addition'), 'an unnamed route must not be projected')
  assert.match(wire.headers['anthropic-beta'] ?? '', new RegExp(TOOL_CHANGES_BETA, 'u'))
})

test('the wire body of a projected request equals the wire body of a request with no tool changes recorded', async () => {
  const guard = createGuard({ routes: [{ model: 'declaring' }] })
  let sent
  guard.handle(replacement => { sent = replacement; return { stream: replacement } }, recordedRequest(), () => assert.fail('expected a replacement'))
  const guardedWire = await transcribe(sent)

  // The same session, had its route declared no tool updates: core never
  // records developer tool-change messages and never defers a tool that no
  // addition would activate, so this is what the harness sends to a route that
  // does not offer the capability.
  const reference = { ...recordedRequest([]), tools: [baseline, added] }
  const referenceWire = await transcribe(reference)

  assert.deepEqual(guardedWire.body, referenceWire.body)
  assert.deepEqual(guardedWire.headers, referenceWire.headers)
})
