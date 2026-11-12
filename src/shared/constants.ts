import type { AIConfig, InquiryMode, UserSettings } from './types';

export const SETTINGS_KEY = 'aq-user-settings'; // 用户配置存储键
export const SESSION_KEY = 'aq-current-session'; // 临时问卷会话存储键
export const FLOATING_HOST_ID = 'formsight-floating-host'; // 页面浮窗宿主节点 ID

export const DEFAULT_AI_CONFIG: AIConfig = {
  baseURL: 'https://api.deepseek.com/v1', // 默认使用 OpenAI 兼容接口地址
  model: 'deepseek-chat', // 默认模型名称
  apiKey: '', // API Key 由用户自行填写
  timeout: 60000, // 单次请求超时时间
};

export const DEFAULT_SETTINGS: UserSettings = {
  ai: DEFAULT_AI_CONFIG,
  inquiryMode: 'normal', // 默认采用正常询问模式
  floatingEnabled: true, // 默认显示页面浮窗
  scanAllPages: true, // 默认在普通网页中注入浮窗
};

export const INQUIRY_MODE_LABELS: Record<InquiryMode, string> = {
  casual: '敷衍', // 快速生成示例答案
  normal: '正常', // 少量确认关键歧义
  serious: '认真', // 多轮确认关键歧义
  conversation: '基于对话', // 先收集用户描述，再一次性推断填写
};

export const INQUIRY_MODE_DESCRIPTIONS: Record<InquiryMode, string> = {
  casual: '不主动询问，直接生成一套合理的示例答案。', // 敷衍模式直接完成全部字段
  normal: '围绕关键歧义进行对话确认，其余内容合理推断。', // 正常模式平衡确认和自动填写
  serious: '确认关键歧义并允许不限轮次对话，仍无法判断的内容合理推断或生成。', // 认真模式不限制总轮次
  conversation: '先描述你的实际情况，再结合问卷内容一次性推断填写，不追问、不留空。', // 用户输入优先，未提及字段进行相关推断
};

export const SUPPORTED_FIELD_TYPES = [
  'input',
  'textarea',
  'select',
  'radio',
  'checkbox',
  'contenteditable',
] as const;
