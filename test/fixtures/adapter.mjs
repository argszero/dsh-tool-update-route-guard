/** A recording adapter whose only job is to capture the request it is dispatched. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export class RecordingAdapter extends LlmAdapter {
  /**
   * @param toolUpdate - the route capability the runtime must resolve; omission
   *   means the route declares no mid-conversation tool updates.
   */
  constructor(toolUpdate) {
    super()
    this.toolUpdate = toolUpdate
    this.requests = []
  }

  providerInfo(provider) {
    return { id: provider, name: `Recording ${provider}` }
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      ...this.toolUpdate === undefined ? {} : { toolUpdate: this.toolUpdate },
    }
  }

  async *stream(options) {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
