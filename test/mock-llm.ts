import { createServer, type Server } from 'node:http';

export interface MockLlmRequest {
  model?: string;
  stream?: boolean;
  messages: Array<{ role: string; content?: unknown; [key: string]: unknown }>;
  tools?: Array<{ function: { name: string; parameters?: unknown } }>;
  [key: string]: unknown;
}

export interface MockLlmReply {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id?: string }>;
  status?: number;
  error?: string;
}

export type MockLlmHandler = (request: MockLlmRequest, index: number) => MockLlmReply | Promise<MockLlmReply>;

/** Real OpenAI chat-completion SSE, usable over HTTP or as ClineCore's fetch override. */
export function createMockLlm(handler: MockLlmHandler = () => ({ text: 'Mock completed.' })) {
  const requests: MockLlmRequest[] = [];
  const respond = async (body: string): Promise<Response> => {
    const request = JSON.parse(body) as MockLlmRequest;
    const index = requests.push(request) - 1;
    const reply = await handler(request, index);
    if (reply.status && reply.status >= 400) {
      return Response.json({ error: { message: reply.error ?? 'Mock error', type: 'mock_error' } }, { status: reply.status });
    }
    const base = { id: `mock-${index}`, object: 'chat.completion.chunk', created: 0, model: request.model ?? 'mock-model' };
    const calls = reply.toolCalls?.map((call, toolIndex) => ({
      index: toolIndex, id: call.id ?? `call-${index}-${toolIndex}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
    const delta = calls?.length ? { role: 'assistant', tool_calls: calls } : { role: 'assistant', content: reply.text ?? '' };
    const chunks = [
      { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: calls?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  };

  const fetchMock: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    return respond(await request.text());
  };

  return {
    requests,
    fetch: fetchMock,
    async listen(): Promise<{ server: Server; baseUrl: string; close(): Promise<void> }> {
      const server = createServer(async (request, response) => {
        try {
          let body = '';
          for await (const chunk of request) body += chunk;
          const result = await respond(body);
          response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
          response.end(await result.text());
        } catch (error) {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: String(error) } }));
        }
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Mock server has no TCP address');
      return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
    },
  };
}
