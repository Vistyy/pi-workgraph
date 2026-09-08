/* oxlint-disable effecttsgo/async-function, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion */
import { once } from "node:events";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Verification owns one loopback HTTP boundary.
import { createServer, type IncomingMessage } from "node:http";

export interface ControlledRequest {
  readonly index: number;
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly model: string;
  readonly messages: unknown[];
  readonly tools: unknown[];
  readonly raw: string;
}

export interface ControlledReply {
  readonly text?: string;
  readonly tool?: { readonly id: string; readonly name: string; readonly arguments: unknown };
}

export interface ControlledProvider {
  readonly baseUrl: string;
  readonly requests: ControlledRequest[];
  readonly errors: Error[];
  close(): Promise<void>;
  assertComplete(): void;
}

export type ControlledResponse = (
  request: ControlledRequest,
) => ControlledReply | Promise<ControlledReply>;

function errorOf(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  const chunks: string[] = [];
  for await (const chunk of request) chunks.push(String(chunk));
  return chunks.join("");
}

function sse(model: string, reply: ControlledReply): string {
  const delta =
    reply.tool === undefined
      ? { role: "assistant", content: reply.text ?? "Controlled turn complete." }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: reply.tool.id,
              type: "function",
              function: {
                name: reply.tool.name,
                arguments: JSON.stringify(reply.tool.arguments),
              },
            },
          ],
        };
  const finishReason = reply.tool === undefined ? "stop" : "tool_calls";
  const chunks = [
    { delta, finish_reason: null },
    { delta: {}, finish_reason: finishReason },
  ].map((choice) =>
    JSON.stringify({
      id: "workgraph-controlled",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, ...choice }],
    }),
  );
  return `${chunks.map((chunk) => `data: ${chunk}\n\n`).join("")}data: [DONE]\n\n`;
}

function decodeRequest(incoming: IncomingMessage, raw: string, index: number): ControlledRequest {
  if (incoming.method !== "POST" || incoming.url !== "/v1/chat/completions")
    throw new Error(`Unexpected provider boundary: ${incoming.method} ${incoming.url}`);
  const parsed = JSON.parse(raw) as {
    model?: unknown;
    messages?: unknown;
    tools?: unknown;
  };
  if (typeof parsed.model !== "string" || !Array.isArray(parsed.messages))
    throw new Error("Controlled provider received an invalid OpenAI request.");
  return {
    index,
    method: incoming.method,
    url: incoming.url,
    model: parsed.model,
    messages: parsed.messages,
    tools: Array.isArray(parsed.tools) ? parsed.tools : [],
    raw,
  };
}

async function handleRequest(
  incoming: IncomingMessage,
  outgoing: import("node:http").ServerResponse,
  responses: readonly ControlledResponse[],
  requests: ControlledRequest[],
  errors: Error[],
): Promise<void> {
  try {
    const request = decodeRequest(incoming, await bodyOf(incoming), requests.length);
    const response = responses[request.index];
    if (response === undefined)
      throw new Error(
        `Unexpected provider request ${request.index + 1}; finite response list exhausted.`,
      );
    requests.push(request);
    const reply = await response(request);
    outgoing.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
      connection: "close",
    });
    outgoing.end(sse(request.model, reply));
  } catch (cause) {
    errors.push(errorOf(cause));
    outgoing.destroy();
  }
}

/** A finite loopback OpenAI-compatible provider. Each request consumes exactly one response. */
export async function startControlledProvider(
  responses: readonly ControlledResponse[],
): Promise<ControlledProvider> {
  const requests: ControlledRequest[] = [];
  const errors: Error[] = [];
  const active = new Set<Promise<void>>();
  const server = createServer((incoming, outgoing) => {
    const operation = handleRequest(incoming, outgoing, responses, requests, errors);
    active.add(operation);
    void operation.then(
      () => active.delete(operation),
      () => active.delete(operation),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Loopback server did not bind.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    errors,
    async close() {
      if (!server.listening) return;
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
      await Promise.allSettled(active);
    },
    assertComplete() {
      const firstError = errors[0];
      if (firstError !== undefined) throw firstError;
      if (requests.length !== responses.length)
        throw new Error(
          `Controlled provider consumed ${requests.length} of ${responses.length} responses.`,
        );
    },
  };
}
