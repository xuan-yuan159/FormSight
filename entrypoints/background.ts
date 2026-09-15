import { browser } from 'wxt/browser';
import { buildTestPrompt, normalizeAIConfig } from '../src/shared/prompts';
import { getSettings } from '../src/shared/storage';
import type {
  AIConfig,
  AIConnectionTestRequest,
  AIConnectionTestResponse,
  AIMessagePayload,
  AIStreamRequest,
  AIStreamEvent,
} from '../src/shared/types';

type MessageSender = { tab?: { id?: number } }; // 只保留后台需要的标签页信息

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(handleRuntimeMessage); // 监听内容脚本和配置页消息
});

/**
 * 处理扩展内部消息。
 */
async function handleRuntimeMessage(
  message: AIStreamRequest | AIConnectionTestRequest,
  sender: MessageSender,
): Promise<{ ok: boolean; message?: string } | AIConnectionTestResponse> {
  if (message?.type === 'AQ_AI_STREAM_REQUEST') {
    if (!sender.tab?.id) return { ok: false, message: '当前请求没有关联网页标签页。' };
    void streamAIResponse(message, sender.tab.id); // 流式任务在后台继续运行
    return { ok: true, message: 'AI 请求已开始。' };
  }

  if (message?.type === 'AQ_AI_TEST_REQUEST') {
    return testAIConnection(message.config);
  }

  return { ok: false, message: '不支持的消息类型。' };
}

/**
 * 通过配置的 AI 服务测试连接。
 */
async function testAIConnection(config: AIConfig): Promise<AIConnectionTestResponse> {
  try {
    const normalized = normalizeAIConfig(config);
    const prompt = buildTestPrompt();
    const text = await requestAI(
      { ...normalized, temperature: 0, maxTokens: Math.min(normalized.maxTokens, 64) }, // 连接测试只请求很短的结果
      prompt,
      false,
      undefined,
    );
    if (!text.trim()) throw new Error('接口已响应，但模型没有返回文本。');
    return { ok: true, message: `连接成功：${text.slice(0, 120)}` };
  } catch (error) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

/**
 * 向 AI 服务发起流式请求，并把事件推送回对应标签页。
 */
async function streamAIResponse(request: AIStreamRequest, tabId: number): Promise<void> {
  /**
   * 将后台状态推送回当前标签页。
   */
  const sendEvent = (event: AIStreamEvent) => sendTabEvent(tabId, request.requestId, request.phase, event);

  try {
    const settings = await getSettings();
    const config = normalizeAIConfig(settings.ai);
    await sendEvent({ type: 'status', message: '正在连接 AI 服务...' });
    await requestAI(config, request.payload, true, sendEvent);
  } catch (error) {
    await sendEvent({ type: 'error', message: getErrorMessage(error) });
  }
}

/**
 * 向标签页发送一条 AI 流式事件。
 */
async function sendTabEvent(
  tabId: number,
  requestId: string,
  phase: AIStreamRequest['phase'],
  event: AIStreamEvent,
): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, {
      type: 'AQ_AI_STREAM_EVENT',
      requestId,
      phase,
      event,
    });
  } catch {
    // 页面关闭后无需继续抛出消息错误
  }
}

/**
 * 请求 OpenAI 兼容接口，支持普通响应和 SSE 流式响应。
 */
async function requestAI(
  config: AIConfig,
  payload: AIMessagePayload,
  stream: boolean,
  onEvent?: (event: AIStreamEvent) => Promise<void>,
): Promise<string> {
  if (!config.baseURL || !config.model || !config.apiKey) {
    throw new Error('请先在扩展设置中填写 Base URL、Model 和 API Key。');
  }

  const endpoint = buildChatEndpoint(config.baseURL); // 统一处理 v1、完整接口和尾部斜杠
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout); // 配置请求超时

  try {
    const requestHeaders = {
      'Content-Type': 'application/json', // 发送 JSON 请求
      Accept: stream ? 'text/event-stream, application/json' : 'application/json', // 兼容流式和普通响应
      Authorization: `Bearer ${config.apiKey}`, // 使用用户配置的 API Key
    };
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(buildChatRequestBody(config, payload, stream)), // 首次请求直接使用跨模型兼容的请求体
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI 请求失败（${response.status}）：${errorText.slice(0, 220)}`);
    }

    if (!stream || !response.body) {
      const data = await readJSONResponse(response);
      throwIfAIResponseError(data); // 兼容服务商用 200 状态返回错误对象
      return readAIContent(data);
    }

    const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? '';
    if (!contentType.includes('text/event-stream')) {
      const data = await readJSONResponse(response); // 部分兼容接口忽略 stream 参数并返回普通 JSON
      throwIfAIResponseError(data); // 兼容服务商用 200 状态返回错误对象
      const text = readAIContent(data);
      if (text) await onEvent?.({ type: 'chunk', text }); // 普通响应也补发一段输出
      await onEvent?.({ type: 'done', text }); // 保证前端不会一直停留在加载状态
      return text;
    }

    return readSSEStream(response.body, onEvent);
  } finally {
    clearTimeout(timeoutId); // 清理请求超时计时器
  }
}

/**
 * 构造 OpenAI 兼容 Chat Completions 请求体。
 */
function buildChatRequestBody(
  config: AIConfig,
  payload: AIMessagePayload,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model, // 使用用户配置的模型
    messages: [
      { role: 'system', content: payload.systemPrompt },
      { role: 'user', content: payload.userPrompt },
    ],
    max_tokens: Math.round(config.maxTokens), // 统一发送整数 Token 上限
    stream, // 按请求类型选择流式或普通响应
  };

  // 不发送 temperature，兼容明确拒绝该参数的新模型并避免错误后重复重试
  return body;
}

/**
 * 将用户填写的 Base URL 规范化为 OpenAI Chat Completions 接口地址。
 */
function buildChatEndpoint(baseURL: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(baseURL);
  } catch {
    throw new Error('Base URL 格式不正确，请填写完整的 http:// 或 https:// 地址。');
  }

  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('Base URL 只支持 http:// 或 https:// 地址。');
  }

  const path = endpoint.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/chat/completions')) {
    endpoint.pathname = `${path || ''}/chat/completions`;
  } else {
    endpoint.pathname = path;
  }
  return endpoint.toString();
}

/**
 * 读取接口 JSON 响应，并把非 JSON 错误转换为可读提示。
 */
async function readJSONResponse(response: Response): Promise<Record<string, unknown>> {
  const rawText = await response.text();
  try {
    const data = JSON.parse(rawText) as unknown;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : { value: data };
  } catch {
    throw new Error(`AI 接口返回了无法解析的内容：${rawText.slice(0, 220)}`);
  }
}

/**
 * 识别 HTTP 200 响应体中的标准 error 字段并抛出可读错误。
 */
function throwIfAIResponseError(data: Record<string, unknown>): void {
  if (!data.error) return;
  const error = data.error;
  if (typeof error === 'string') throw new Error(`AI 服务返回错误：${error}`);
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    throw new Error(`AI 服务返回错误：${typeof message === 'string' ? message : JSON.stringify(error)}`);
  }
  throw new Error(`AI 服务返回错误：${String(error)}`);
}

/**
 * 读取普通 Chat Completions 响应中的文本。
 */
function readAIContent(data: Record<string, unknown>): string {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;
  const content = message.content ?? first.text ?? first.content ?? '';
  return readContentText(content);
}

/**
 * 把字符串、内容数组和常见内容对象统一转换成模型文本。
 */
function readContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => readContentText(item)).join('');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return value === null || value === undefined ? '' : JSON.stringify(value);
}

/**
 * 解析 SSE 流并逐段返回模型文本。
 */
async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  onEvent?: (event: AIStreamEvent) => Promise<void>,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      await consumeSSELine(line); // 逐行消费服务商返回的 SSE 数据
    }
  }

  buffer += decoder.decode(); // 刷新 TextDecoder 的尾部字节
  if (buffer.trim()) await consumeSSELine(buffer); // 处理服务商没有换行结尾的最后一段
  const finalText = fullText;
  await onEvent?.({ type: 'done', text: finalText }); // 通知前端流式响应结束
  return finalText;

  /**
   * 处理一行 SSE 数据并推送增量文本。
   */
  async function consumeSSELine(line: string): Promise<void> {
    const text = parseSSELine(line);
    if (!text || text === '[DONE]') return;
    const delta = readSSEDelta(text);
    if (!delta) return;
    fullText += delta;
    await onEvent?.({ type: 'chunk', text: delta }); // 推送实时输出片段
  }
}

/**
 * 读取 SSE 单行中的 data 内容。
 */
function parseSSELine(line: string): string {
  const normalized = line.trim();
  return normalized.startsWith('data:') ? normalized.slice(5).trim() : '';
}

/**
 * 从 SSE 数据包中读取增量文本。
 */
function readSSEDelta(text: string): string {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = (choices[0] ?? {}) as Record<string, unknown>;
    const delta = (first.delta ?? {}) as Record<string, unknown>;
    const content = delta.content ?? delta.text ?? first.text ?? '';
    return readContentText(content);
  } catch {
    return '';
  }
}

/**
 * 将未知错误转换为用户可以理解的提示。
 */
function getErrorMessage(error: unknown): string {
  if ((error instanceof DOMException && error.name === 'AbortError') || error instanceof Error && error.name === 'AbortError') {
    return 'AI 请求超时，请检查网络或缩短问卷内容。';
  }
  if (error instanceof TypeError) return `网络请求失败，请检查 Base URL、网络和服务商跨域设置：${error.message}`;
  if (error instanceof Error) return error.message;
  return 'AI 请求发生未知错误。';
}
