/** Request fixtures built from the published message factories, never hand-shaped. */
import { createDeveloperMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

export const baseline = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }
export const added = { name: 'search', description: 'Search files', parameters: { type: 'object', properties: {} } }

export const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** One developer message carrying instructions plus a tool addition. */
export function addition() {
  return createDeveloperMessage({
    source: { kind: 'tool-registry' },
    content: [
      { type: 'text', text: 'Instruction one.' },
      { type: 'tool-addition', toolName: added.name },
    ],
  })
}

/** One developer message carrying a tool removal. */
export function removal(toolName = 'read') {
  return createDeveloperMessage({
    source: { kind: 'tool-registry' },
    content: [{ type: 'tool-removal', toolName }],
  })
}

/**
 * A request whose history was recorded under a route declaring tool updates.
 * @param extra - additional messages appended after the user turn.
 */
export function recordedRequest(extra = [addition()]) {
  const update = extra[0]
  return {
    provider: 'guarded',
    model: 'declaring',
    messages: [user('first'), ...extra],
    tools: [baseline, { ...added, deferLoading: true }],
    toolHistory: {
      tools: [baseline],
      updates: update === undefined ? [] : [{ messageId: update.id, additions: [added] }],
    },
  }
}
