import type {
  ChatRequest,
  ModelInfo,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
} from './types';

/**
 * 确定性 Provider，用脚本化的 ProviderEvent 序列驱动内核测试（零网络）。
 * 每次 streamChat 弹出队首脚本；空则默认 end_turn。
 */
export class FakeProvider implements Provider {
  readonly id = 'fake';
  readonly capabilities: ProviderCapabilities = {
    nativeToolCalling: true,
    thinking: false,
    promptCache: false,
    effort: false,
  };
  private readonly queue: ProviderEvent[][] = [];
  /** 记录每次收到的请求，便于断言 messages/tools 组装正确。 */
  readonly seen: ChatRequest[] = [];

  script(events: ProviderEvent[]): this {
    this.queue.push(events);
    return this;
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ProviderEvent> {
    this.seen.push(req);
    const events = this.queue.shift() ?? [{ kind: 'Stop', reason: 'end_turn' }];
    for (const e of events) yield e;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'fake-model' }];
  }
}

export function textTurn(text: string): ProviderEvent[] {
  return [
    { kind: 'TextDelta', text },
    { kind: 'Stop', reason: 'end_turn' },
  ];
}

export function toolCallTurn(name: string, id: string, input: unknown): ProviderEvent[] {
  return [
    { kind: 'ToolCallStart', id, name },
    { kind: 'ToolCallArgsDelta', id, delta: JSON.stringify(input) },
    { kind: 'ToolCallEnd', id },
    { kind: 'Stop', reason: 'tool_use' },
  ];
}
