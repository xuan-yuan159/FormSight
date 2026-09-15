export type InquiryMode = 'casual' | 'normal' | 'serious';

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'email'
  | 'single'
  | 'multiple'
  | 'select'
  | 'contenteditable'
  | 'unknown';

export type AnswerValue = string | string[] | boolean | number | null;

export interface AIConfig {
  baseURL: string;
  model: string;
  apiKey: string;
  temperature: number;
  timeout: number;
  maxTokens: number;
}

export interface UserSettings {
  ai: AIConfig;
  inquiryMode: InquiryMode;
  floatingEnabled: boolean;
  scanAllPages: boolean;
}

export interface FieldLocator {
  fieldId: string;
  label?: string;
  name?: string;
  id?: string;
  tagName: string;
}

export interface QuestionnaireOption {
  label: string;
  value: string;
  element?: HTMLElement; // 仅运行时保留实际选项节点
}

export interface QuestionnaireField {
  id: string;
  label: string;
  description: string;
  type: FieldType;
  required: boolean;
  options: string[];
  currentValue: string;
  locator: FieldLocator;
  element?: HTMLElement;
  runtimeOptions?: QuestionnaireOption[]; // 仅运行时保存单选和多选控件
}

export interface QuestionnaireSnapshot {
  pageTitle: string;
  url: string;
  formScore: number;
  fields: Array<Omit<QuestionnaireField, 'element' | 'runtimeOptions'>>;
  capturedAt: string;
}

export interface DecisionQuestion {
  questionId: string;
  fieldIds: string[];
  question: string;
  reason: string;
  type: 'text' | 'single' | 'multiple';
  options: string[];
  required: boolean;
  confidence: number;
}

export interface ResolvedAnswer {
  fieldId: string;
  value: AnswerValue;
  source: 'profile' | 'user' | 'inference' | 'unknown';
  confidence: number;
  note?: string;
}

/**
 * AI 结合页面上下文归纳出的问卷字段摘要。
 */
export interface AIFieldSummary {
  fieldId: string;
  label: string;
  description: string;
  type: string;
  required: boolean;
  options: string[];
}

export interface AIAnalysis {
  summary: string;
  fieldSummaries: AIFieldSummary[];
  resolvedAnswers: ResolvedAnswer[];
  questions: DecisionQuestion[];
  warnings: string[];
}

export interface QuestionnaireSession {
  sessionId: string;
  tabId?: number;
  pageTitle: string;
  url: string;
  status: 'scanned' | 'analyzing' | 'waiting_for_user' | 'ready_to_fill' | 'filled';
  snapshot: QuestionnaireSnapshot;
  analysis?: AIAnalysis;
  finalAnswers: ResolvedAnswer[];
  createdAt: string;
  updatedAt: string;
}

export interface AIMessagePayload {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * 浮窗与 AI 之间的一轮对话消息。
 */
export interface ConversationMessage {
  role: 'assistant' | 'user';
  content: string;
}

export interface AIStreamRequest {
  type: 'AQ_AI_STREAM_REQUEST';
  requestId: string;
  phase: 'analyze' | 'complete';
  payload: AIMessagePayload;
}

export interface AIStreamEvent {
  type: 'status' | 'chunk' | 'done' | 'error';
  message?: string;
  text?: string;
}

export interface AIStreamMessage {
  type: 'AQ_AI_STREAM_EVENT';
  requestId: string;
  phase: 'analyze' | 'complete';
  event: AIStreamEvent;
}

export interface AIConnectionTestRequest {
  type: 'AQ_AI_TEST_REQUEST';
  config: AIConfig;
}

export interface AIConnectionTestResponse {
  ok: boolean;
  message: string;
}

export interface ScanResult {
  pageTitle: string;
  url: string;
  formScore: number;
  pageContext: string;
  fields: QuestionnaireField[];
}
