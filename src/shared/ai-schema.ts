import { z } from 'zod';
import type { AIAnalysis } from './types';

const answerSchema = z.object({
  fieldId: z.coerce.string(), // 兼容模型把字段编号返回成数字
  value: z.union([z.string(), z.array(z.coerce.string()), z.boolean(), z.number(), z.null()]), // 兼容数字和数字数组答案
  source: z.enum(['profile', 'user', 'inference', 'unknown']).default('unknown'),
  confidence: z.coerce.number().min(0).max(1).default(0), // 兼容模型把置信度返回成字符串
  note: z.string().optional(),
});

const questionSchema = z.object({
  questionId: z.coerce.string(),
  fieldIds: z.array(z.coerce.string()).default([]),
  question: z.coerce.string(),
  reason: z.coerce.string().default(''),
  type: z.enum(['text', 'single', 'multiple']).default('text'),
  options: z.array(z.coerce.string()).default([]),
  required: z.boolean().default(false),
  confidence: z.coerce.number().min(0).max(1).default(0), // 兼容模型把置信度返回成字符串
});

const fieldSummarySchema = z.object({
  fieldId: z.coerce.string(),
  label: z.coerce.string().default(''),
  description: z.coerce.string().default(''),
  type: z.coerce.string().default('unknown'),
  required: z.boolean().default(false),
  options: z.array(z.coerce.string()).default([]),
});

const analysisSchema = z.object({
  summary: z.string().default(''),
  fieldSummaries: z.array(fieldSummarySchema).default([]),
  resolvedAnswers: z.array(answerSchema).default([]),
  questions: z.array(questionSchema).default([]),
  warnings: z.array(z.string()).default([]),
});

/**
 * 从模型文本中提取 JSON 内容。
 */
function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/**
 * 校验并标准化 AI 分析结果。
 */
export function parseAIAnalysis(text: string): AIAnalysis {
  const parsed = JSON.parse(extractJsonText(text)) as unknown; // 只解析模型返回的 JSON 文本
  return analysisSchema.parse(parsed);
}
