<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  Bot,
  Check,
  CircleAlert,
  ClipboardCheck,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  RotateCcw,
  ScanSearch,
  Send,
  Settings2,
  Sparkles,
  X,
} from '@lucide/vue';
import { browser } from 'wxt/browser';
import { buildAnalysisPrompt, buildCompletionPrompt, createRequestId } from '../shared/prompts';
import { parseAIAnalysis } from '../shared/ai-schema';
import { getSettings, saveSession } from '../shared/storage';
import type {
  AIAnalysis,
  AIStreamMessage,
  AIFieldSummary,
  ConversationMessage,
  DecisionQuestion,
  InquiryMode,
  QuestionnaireField,
  QuestionnaireSession,
  ResolvedAnswer,
} from '../shared/types';
import { applyAnswers, scanQuestionnaire, serializeFields } from '../questionnaire/scanner';

const isOpen = ref(false);
const stage = ref<'idle' | 'scanned' | 'analyzing' | 'waiting' | 'completing' | 'ready' | 'filled' | 'error'>('idle');
const message = ref('点击扫描当前页面');
const streamText = ref('');
const fields = ref<QuestionnaireField[]>([]);
const analysis = ref<AIAnalysis | null>(null);
const finalAnswers = ref<ResolvedAnswer[]>([]);
const currentRequestId = ref('');
const currentPhase = ref<'analyze' | 'complete' | null>(null);
const mode = ref<InquiryMode>('normal');
const skippedFields = ref<string[]>([]);
const filledCount = ref(0);
const conversation = ref<ConversationMessage[]>([]);
const chatInput = ref('');
const pageContext = ref('');
const showFieldDetails = ref(false);
const expandedFieldIds = ref<Record<string, boolean>>({});
const showAllAnswers = ref(false);
const conversationRound = ref(0);

const modeOptions: Array<{ value: InquiryMode; label: string; description: string }> = [
  { value: 'casual', label: '敷衍', description: '不询问，直接生成合理答案' }, // 敷衍模式一次性完成
  { value: 'normal', label: '正常', description: '对关键歧义对话确认，其余推断' }, // 正常模式平衡确认和推断
  { value: 'serious', label: '认真', description: '关键歧义不限轮次对话' }, // 认真模式不限制总轮次
];

const isBusy = computed(() => ['analyzing', 'completing'].includes(stage.value));
const answerList = computed(() => finalAnswers.value.filter((answer) => hasAnswerValue(answer.value)));
const visibleAnswers = computed(() => showAllAnswers.value ? answerList.value : answerList.value.slice(0, 3));
const fieldSummaryList = computed<AIFieldSummary[]>(() => {
  if (analysis.value?.fieldSummaries?.length) return analysis.value.fieldSummaries;
  return fields.value.map((field) => ({
    fieldId: field.id,
    label: field.label,
    description: field.description,
    type: field.type,
    required: field.required,
    options: field.options,
  }));
});

/**
 * 判断答案是否是真正可以填写到页面的内容。
 */
function hasAnswerValue(value: ResolvedAnswer['value']): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasAnswerValue(String(item)));
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLocaleLowerCase();
    return Boolean(normalized) && !['unknown', 'null', 'undefined', '未知', '不确定', '无法确定'].includes(normalized); // 统一拦截模型的空值标记
  }
  if (typeof value === 'number') return Number.isFinite(value);
  return value !== null && value !== undefined;
}

/**
 * 判断选项是否只是下拉框的占位提示。
 */
function isPlaceholderOption(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase();
  return !normalized || /^(请选择|请选择一项|请选择答案|选择一项|select|please select|--+)/i.test(normalized); // 避免把占位文字当成真实答案
}

/**
 * 根据字段类型和题干生成缺失答案的合理示例值。
 */
function buildFallbackValueFromMetadata(
  label: string,
  description: string,
  type: string,
  options: string[],
  currentValue = '',
): ResolvedAnswer['value'] {
  const normalizedType = type.toLocaleLowerCase();
  if (hasAnswerValue(currentValue)) {
    return normalizedType === 'multiple'
      ? currentValue.split(/[,，、;；\n]+/).map((item) => item.trim()).filter(Boolean)
      : currentValue; // 页面已有值优先作为用户现有答案
  }

  const usableOptions = options.filter((option) => !isPlaceholderOption(option));
  if (normalizedType === 'single' || normalizedType === 'select') {
    return usableOptions[0] ?? '其他'; // 单选和下拉优先使用第一个真实选项
  }
  if (normalizedType === 'multiple') {
    return usableOptions.length > 0 ? usableOptions.slice(0, Math.min(usableOptions.length, 2)) : true; // 多选默认选择少量常见选项
  }

  const labelText = `${label} ${description}`.toLocaleLowerCase();
  if (normalizedType === 'number' && /年龄|岁数/.test(labelText)) return 28; // 年龄字段使用常见成年示例
  if (normalizedType === 'number') return 1; // 其他数字字段使用可填写的基础数值
  if (normalizedType === 'email' || /邮箱|邮件|email/.test(labelText)) return 'example@example.com'; // 邮箱字段使用示例地址
  if (/手机|电话|手机号|联系方式|phone|tel/.test(labelText)) return '13800138000'; // 联系方式字段使用示例号码
  if (/姓名|名字|称呼|联系人/.test(labelText)) return '张伟'; // 姓名字段使用常见示例姓名
  if (/性别/.test(labelText)) return '男'; // 性别字段使用常见示例选项
  if (/地址|住址|所在地|城市/.test(labelText)) return '北京市朝阳区'; // 地址字段使用完整示例地址
  if (/公司|单位|组织/.test(labelText)) return '示例科技有限公司'; // 单位字段使用示例公司
  if (/职业|职位|岗位|工作/.test(labelText)) return '产品经理'; // 职业字段使用常见示例职位
  if (/年龄|岁数/.test(labelText)) return '28'; // 文本年龄字段也保持可读的示例值
  if (/原因|理由|描述|说明|经历|意见|建议|备注/.test(labelText)) return '根据题意填写，暂无特殊情况。'; // 开放文本字段生成自然短句
  return '暂无特殊情况'; // 通用文本字段不再返回空白
}

/**
 * 根据标准 DOM 字段生成缺失答案，统一复用 AI 复杂字段的兜底规则。
 */
function buildFallbackValue(field: QuestionnaireField): ResolvedAnswer['value'] {
  return buildFallbackValueFromMetadata(field.label, field.description, field.type, field.options, field.currentValue.trim());
}

/**
 * 将字段选项和 AI 答案转换为便于比较的文本。
 */
function normalizeOptionText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s\u3000，。、“”‘’（）()【】\[\]：:；;、\/\\|_-]+/g, ''); // 忽略常见标点和空格差异
}

/**
 * 找到 AI 答案对应的页面真实选项文字，避免把解释性长句写入选项字段。
 */
function findMatchingOptionLabel(field: QuestionnaireField, value: string): string | undefined {
  const normalized = normalizeOptionText(value);
  if (!normalized || normalized === 'true' || normalized === 'false') return undefined;
  const matches = field.options.filter((option) => {
    if (isPlaceholderOption(option)) return false;
    const normalizedOption = normalizeOptionText(option);
    return normalized === normalizedOption
      || normalized.length === 1 && normalizedOption.startsWith(normalized)
      || normalized.includes(normalizedOption) && normalizedOption.length >= 2
      || normalizedOption.includes(normalized) && normalized.length >= 2;
  });
  return matches.sort((left, right) => {
    const leftText = normalizeOptionText(left);
    const rightText = normalizeOptionText(right);
    const leftExact = leftText === normalized ? 1 : 0;
    const rightExact = rightText === normalized ? 1 : 0;
    return rightExact - leftExact || rightText.length - leftText.length;
  })[0]; // 精确匹配优先，长选项优先于其短前缀
}

/**
 * 将单选、多选和下拉答案规范成页面已有的选项文本。
 */
function canonicalizeAnswerValue(field: QuestionnaireField, value: ResolvedAnswer['value']): ResolvedAnswer['value'] {
  if (!['single', 'multiple', 'select'].includes(field.type) || field.options.length === 0 || typeof value === 'boolean') {
    return value;
  }

  const values = Array.isArray(value) ? value : [String(value)];
  const labels = values
    .map((item) => findMatchingOptionLabel(field, String(item)))
    .filter((item): item is string => Boolean(item));
  if (labels.length === 0) return value;
  if (field.type === 'single' || field.type === 'select') return labels[0];
  return [...new Set(labels)]; // 多选去重后只保留页面真实选项
}

/**
 * 判断 AI 答案是否能够匹配页面实际提供的选项。
 */
function isApplicableAnswer(field: QuestionnaireField, value: ResolvedAnswer['value']): boolean {
  if (!['single', 'multiple', 'select'].includes(field.type) || field.options.length === 0) return true;
  if (typeof value === 'boolean') return true; // 独立同意复选框支持布尔值
  const values = Array.isArray(value) ? value : [String(value)];
  return values.some((item) => Boolean(findMatchingOptionLabel(field, String(item))));
}

/**
 * 从用户自然语言中提取年龄区间对应的页面选项。
 */
function findAgeOption(options: string[], age: number): string | undefined {
  return options.find((option) => {
    const range = option.match(/(\d{1,2})\s*[-~至到—–]+\s*(\d{1,2})/); // 兼容模型输出的 26--35 这类重复连接符
    if (range) return age >= Number(range[1]) && age <= Number(range[2]);
    if (/以下|以内/.test(option)) {
      const upper = option.match(/(\d{1,2})/);
      return Boolean(upper && age <= Number(upper[1]));
    }
    if (/以上|及以上/.test(option)) {
      const lower = option.match(/(\d{1,2})/);
      return Boolean(lower && age >= Number(lower[1]));
    }
    return false;
  });
}

/**
 * 根据用户对话提取可直接覆盖字段答案的事实，避免模型重复追问。
 */
function buildConversationInferredAnswers(
  fields: QuestionnaireField[],
  conversation: ConversationMessage[],
): ResolvedAnswer[] {
  const userText = conversation
    .filter((item) => item.role === 'user')
    .map((item) => item.content)
    .join('\n')
    .trim();
  if (!userText) return [];

  const normalizedUserText = normalizeOptionText(userText);
  return fields.flatMap((field) => {
    const semanticText = `${field.label} ${field.description}`.toLocaleLowerCase();
    let value: ResolvedAnswer['value'] | undefined;

    if (/性别|gender/.test(semanticText)) {
      if (/女性|女生|女孩|女/.test(userText) && !/男女性别|男女/.test(userText)) {
        value = findMatchingOptionLabel(field, '女') ?? '女';
      } else if (/男性|男生|男孩|男/.test(userText) && !/男女/.test(userText)) {
        value = findMatchingOptionLabel(field, '男') ?? '男';
      }
    } else if (/年龄|岁数|age/.test(semanticText)) {
      const exactAge = userText.match(/(?:^|\D)(1[0-9]|[2-9][0-9])\s*岁?/);
      const inferredAge = exactAge
        ? Number(exactAge[1])
        : (/正常年龄|正常年纪|应届|毕业生|刚毕业/.test(userText) ? 22 : undefined); // 应届生默认按常见毕业年龄推断
      if (inferredAge !== undefined) {
        value = field.options.length > 0
          ? findAgeOption(field.options, inferredAge) ?? findMatchingOptionLabel(field, String(inferredAge))
          : field.type === 'number' ? inferredAge : String(inferredAge);
      }
    } else if (/职业|行业|从事|职业类型|行业方向|期望.*行业|occupation|industry|job/.test(semanticText)
      && /计算机|软件|信息技术|互联网|编程|程序开发|\bit\b/i.test(userText)) {
      value = field.options.find((option) => /计算机|软件|信息技术|互联网|编程|程序开发|\bit\b/i.test(option))
        ?? findMatchingOptionLabel(field, '计算机相关行业')
        ?? (field.options.length === 0 ? '计算机相关行业' : undefined);
    }

    if (value === undefined && field.options.length > 0) {
      const explicitOption = field.options.find((option) => {
        const normalizedOption = normalizeOptionText(option);
        return normalizedOption.length >= 2 && normalizedUserText.includes(normalizedOption);
      });
      value = explicitOption;
    }

    if (value === undefined || !hasAnswerValue(value)) return [];
    return [{
      fieldId: field.id,
      value,
      source: 'user' as const,
      confidence: 0.98,
      note: '根据用户自然语言中的明确事实归纳。', // 说明答案来自用户对话而非模型猜测
    }];
  });
}

type QuestionFieldDescriptor = Pick<AIFieldSummary, 'fieldId' | 'label' | 'description' | 'type' | 'required' | 'options'>;

/**
 * 合并代码扫描字段和 AI 识别字段，供认真模式审计整份问卷。
 */
function buildQuestionFieldDescriptors(
  fields: QuestionnaireField[],
  fieldSummaries: AIFieldSummary[],
): QuestionFieldDescriptor[] {
  const knownIds = new Set(fields.map((field) => field.id));
  const scannedDescriptors = fields.map((field) => ({
    fieldId: field.id,
    label: field.label,
    description: field.description,
    type: field.type,
    required: field.required,
    options: field.options,
  }));
  const aiDescriptors = fieldSummaries.filter((summary) => !knownIds.has(summary.fieldId));
  return [...scannedDescriptors, ...aiDescriptors]; // 标准字段优先，复杂字段继续保留
}

/**
 * 判断字段是否属于需要覆盖的问卷主题领域。
 */
function isTopicQuestionField(field: QuestionFieldDescriptor): boolean {
  const semanticText = `${field.label} ${field.description}`.toLocaleLowerCase();
  return /旅游|旅行|出游|假期|消费|支出|活动|频率|季节|时间|原因|偏好|目的|travel|frequency|reason/.test(semanticText);
}

/**
 * 判断字段是否值得在认真模式中主动确认。
 */
function isKeyQuestionField(field: QuestionFieldDescriptor): boolean {
  const semanticText = `${field.label} ${field.description}`.toLocaleLowerCase();
  return field.required
    || field.options.some((option) => !isPlaceholderOption(option))
    || /性别|年龄|职业|行业|工作|gender|age|occupation|industry/.test(semanticText)
    || isTopicQuestionField(field);
}

/**
 * 为 AI 漏问的关键字段补充精简问题，保证认真模式不会只围绕个人资料追问。
 */
function buildSupplementalQuestions(
  fields: QuestionnaireField[],
  fieldSummaries: AIFieldSummary[],
  existingQuestions: DecisionQuestion[],
  answeredFieldIds: Set<string>,
  selectedMode: InquiryMode,
): DecisionQuestion[] {
  if (selectedMode !== 'serious') return [];
  const askedFieldIds = new Set(existingQuestions.flatMap((question) => question.fieldIds));
  const prefilledFieldIds = new Set(
    fields.filter((field) => hasAnswerValue(field.currentValue)).map((field) => field.id),
  ); // 页面已有值属于已知事实，不再列为待确认问题
  return buildQuestionFieldDescriptors(fields, fieldSummaries)
    .filter((field) => isKeyQuestionField(field))
    .filter((field) => !answeredFieldIds.has(field.fieldId)
      && !prefilledFieldIds.has(field.fieldId)
      && !askedFieldIds.has(field.fieldId))
    .map((field) => {
      const options = field.options.filter((option) => !isPlaceholderOption(option)).slice(0, 8);
      return {
        questionId: `inferred-question-${field.fieldId}`,
        fieldIds: [field.fieldId],
        question: shortenQuestion(options.length > 0 ? `“${field.label}”选哪一项？` : `请补充“${field.label}”的情况。`),
        reason: '认真模式需要确认尚未覆盖的关键字段',
        type: options.length > 0
          ? field.type === 'multiple' ? 'multiple' as const : 'single' as const
          : 'text' as const,
        options,
        required: field.required,
        confidence: 0.35,
      };
    });
}

/**
 * 移除用户已经在自然语言中回答过的重复问题。
 */
function removeResolvedQuestions(
  questions: DecisionQuestion[],
  conversationAnswers: ResolvedAnswer[],
  fieldDescriptors: QuestionFieldDescriptor[],
): DecisionQuestion[] {
  const answeredFieldIds = new Set(conversationAnswers.map((answer) => answer.fieldId));
  const answeredLabels = fieldDescriptors
    .filter((field) => answeredFieldIds.has(field.fieldId))
    .map((field) => normalizeOptionText(field.label))
    .filter((label) => label.length >= 2);
  return questions.filter((question) => {
    const normalizedQuestion = normalizeOptionText(question.question);
    if (answeredLabels.some((label) => normalizedQuestion.includes(label))) {
      return false; // 用户已覆盖题干中的事实时，不再换一种说法重复确认
    }
    if (question.fieldIds.length > 0) {
      return question.fieldIds.some((fieldId) => !answeredFieldIds.has(fieldId));
    }
    return true;
  });
}

/**
 * 补齐 AI 漏答或返回空值的字段，并按模式控制是否进入对话。
 */
function normalizeAnalysis(
  result: AIAnalysis,
  scannedFields: QuestionnaireField[],
  selectedMode: InquiryMode,
  previousAnalysis?: AIAnalysis,
  conversation: ConversationMessage[] = [],
): AIAnalysis {
  const answerMap = new Map(
    (previousAnalysis?.resolvedAnswers ?? []).map((answer) => [answer.fieldId, answer] as const),
  );
  for (const answer of result.resolvedAnswers) {
    if (!answerMap.has(answer.fieldId) || hasAnswerValue(answer.value)) {
      answerMap.set(answer.fieldId, answer); // 新答案有效时覆盖旧答案，避免空值冲掉上一轮结果
    }
  }
  const conversationAnswers = buildConversationInferredAnswers(scannedFields, conversation);
  for (const answer of conversationAnswers) {
    answerMap.set(answer.fieldId, answer); // 用户明确表达优先于模型上一轮推断
  }
  const fieldSummaryMap = new Map(
    [...(previousAnalysis?.fieldSummaries ?? []), ...result.fieldSummaries]
      .map((summary) => [summary.fieldId, summary] as const),
  ); // 新一轮字段归纳覆盖旧归纳
  const allFieldSummaries = Array.from(fieldSummaryMap.values()); // 使用合并后的字段摘要继续完成多轮对话
  const knownFieldIds = new Set(scannedFields.map((field) => field.id));
  const scannedFieldSummaries = scannedFields.map((field) => {
      const summary = fieldSummaryMap.get(field.id);
      const summaryType = summary?.type?.trim();
      return {
        fieldId: field.id,
        label: summary?.label?.trim() || field.label,
        description: summary?.description?.trim() || field.description,
        type: summaryType && !['unknown', '未知'].includes(summaryType.toLocaleLowerCase())
          ? summaryType
          : field.type, // AI 返回 unknown 时回退到代码扫描出的真实控件类型
        required: summary?.required ?? field.required,
        options: summary?.options?.length ? summary.options : field.options,
      };
    });
  const aiFieldSummaries = allFieldSummaries.filter(
    (summary) => Boolean(summary.fieldId.trim() && summary.label.trim()),
  );
  const extraFieldSummaries = aiFieldSummaries.filter((summary) => !knownFieldIds.has(summary.fieldId)); // 保留 AI 识别但暂时没有 DOM 映射的复杂字段
  const fieldSummaries = scannedFields.length > 0
    ? [...scannedFieldSummaries, ...extraFieldSummaries]
    : aiFieldSummaries; // 没有标准控件时保留 AI 从页面上下文识别出的字段摘要
  const aiFieldIds = new Set(aiFieldSummaries.map((summary) => summary.fieldId)); // 用摘要字段限制 AI 额外答案范围
  const mappedAnswers = scannedFields.map((field) => {
      const answer = answerMap.get(field.id);
      const canonicalValue = answer ? canonicalizeAnswerValue(field, answer.value) : null;
      if (answer && hasAnswerValue(canonicalValue) && isApplicableAnswer(field, canonicalValue)) {
        return {
          ...answer,
          fieldId: field.id,
          value: canonicalValue, // 单选和下拉统一显示页面实际选项
          source: answer.source === 'unknown' ? 'inference' : answer.source, // 空值标记之外的答案统一视为有效推断
        };
      }

      return {
        fieldId: field.id,
        value: buildFallbackValue(field),
        source: 'inference' as const,
        confidence: 0.25,
        note: '未从当前对话获得明确内容，已自动生成合理示例值。', // 明确告知这是前端兜底推断
      };
    });
  const mergedAnswers = Array.from(answerMap.values()); // 合并当前轮和上一轮答案
  const aiAnswers = mergedAnswers.filter(
    (answer) => aiFieldIds.has(answer.fieldId) && hasAnswerValue(answer.value),
  ).map((answer) => ({
    ...answer,
    source: answer.source === 'unknown' ? 'inference' as const : answer.source, // 复杂字段的未知来源统一标记为推断
  }));
  const generatedAIAnswers = aiFieldSummaries
    .filter((summary) => !knownFieldIds.has(summary.fieldId) && !hasAnswerValue(answerMap.get(summary.fieldId)?.value))
    .map((summary) => ({
      fieldId: summary.fieldId,
      value: buildFallbackValueFromMetadata(summary.label, summary.description, summary.type, summary.options),
      source: 'inference' as const,
      confidence: 0.2,
      note: 'AI 已识别字段，但未返回明确答案，已生成合理示例值供审核。', // 避免复杂字段在结果中留空
    }));
  const unmappedAnswers = [...aiAnswers, ...generatedAIAnswers]; // 无 DOM 映射的字段仍保留完整答案
  const resolvedAnswers = scannedFields.length > 0
    ? [
        ...mappedAnswers,
        ...unmappedAnswers.filter((answer) => !knownFieldIds.has(answer.fieldId)),
      ]
    : unmappedAnswers; // 无法建立控件映射时仍展示 AI 识别到的答案
  const warnings = extraFieldSummaries.length > 0
    ? [...new Set([
        ...(previousAnalysis?.warnings ?? []),
        ...result.warnings,
        '部分复杂字段已由 AI 识别，但当前页面暂未建立对应的控件回填映射。',
      ])]
    : [...new Set([...(previousAnalysis?.warnings ?? []), ...result.warnings])]; // 多轮对话保留之前的风险提示
  const questionFieldDescriptors = buildQuestionFieldDescriptors(scannedFields, fieldSummaries);
  const topicFieldIds = new Set(
    questionFieldDescriptors.filter((field) => isTopicQuestionField(field)).map((field) => field.fieldId),
  ); // 认真模式对主题领域不接受无用户依据的过度自信推断
  const filteredQuestions = removeResolvedQuestions(
    result.questions,
    conversationAnswers,
    questionFieldDescriptors,
  );
  const supplementalQuestions = buildSupplementalQuestions(
    scannedFields,
    fieldSummaries,
    filteredQuestions,
    new Set([
      ...conversationAnswers.map((answer) => answer.fieldId),
      ...Array.from(answerMap.values())
        .filter((answer) => hasAnswerValue(answer.value)
          && (answer.source === 'user'
            || answer.source === 'profile'
            || answer.confidence >= 0.85 && !topicFieldIds.has(answer.fieldId)))
        .map((answer) => answer.fieldId),
    ]), // 只跳过用户明确或 AI 高置信度已经解决的字段
    selectedMode,
  );

  return {
    ...result,
    fieldSummaries,
    resolvedAnswers,
    warnings,
    questions: limitConversationQuestions([...filteredQuestions, ...supplementalQuestions], selectedMode), // 先去重再补齐领域字段
  };
}

/**
 * 将 AI 的关键问题合并成一条对话消息，避免渲染成逐题填写表单。
 */
function buildConversationOpening(questions: DecisionQuestion[]): string {
  const questionLines = questions.map((question, index) => {
    const questionText = shortenQuestion(question.question || '请补充相关情况'); // 防止模型返回空问题造成无意义编号
    const options = question.options.length > 0
      ? `（${question.options.slice(0, 3).map((option) => shortenQuestion(option).slice(0, 20)).join('、')}${question.options.length > 3 ? '等' : ''}）` // 选项也保持短小，避免对话区被长文本挤满
      : '';
    return `${index + 1}. ${questionText}${options}`;
  });
  return [
    questions.length > 0
      ? '请直接回答下面的关键问题；其他没有提到的内容，我会根据上下文自动补全。'
      : '没有关键歧义。你可以补充情况，也可以直接应用这份答案。', // 没有关键歧义时仍保留对话入口
    ...questionLines,
  ].join('\n');
}

/**
 * 将 AI 问题压缩成适合浮窗展示的一句话。
 */
function shortenQuestion(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 50) return normalized;
  return `${normalized.slice(0, 47)}...`; // 防止模型把问题输出成长段说明
}

/**
 * 展开或收起 AI 识别出的页面字段摘要。
 */
function toggleFieldDetails(): void {
  showFieldDetails.value = !showFieldDetails.value;
}

/**
 * 展开或收起单个字段的详细说明。
 */
function toggleFieldSummary(fieldId: string): void {
  expandedFieldIds.value[fieldId] = !expandedFieldIds.value[fieldId];
}

/**
 * 展开或收起剩余答案，默认只展示前三项。
 */
function toggleAnswerList(): void {
  showAllAnswers.value = !showAllAnswers.value;
}

/**
 * 按模式限制单轮 AI 追问数量，认真模式的总轮次不设上限。
 */
function limitConversationQuestions(questions: DecisionQuestion[], selectedMode: InquiryMode): DecisionQuestion[] {
  const limits: Record<InquiryMode, number> = {
    casual: 0,
    normal: 3,
    serious: 3,
  };
  return questions.slice(0, limits[selectedMode]); // 每轮最多合并三个问题，避免一次输出长段落
}

/**
 * 监听后台发回的 AI 流式事件。
 */
function handleStreamMessage(incoming: unknown): void {
  const messageData = incoming as AIStreamMessage;
  if (
    messageData?.type !== 'AQ_AI_STREAM_EVENT' ||
    messageData.requestId !== currentRequestId.value ||
    messageData.phase !== currentPhase.value ||
    !messageData.event
  ) return;

  const event = messageData.event;
  if (event.type === 'status') {
    message.value = event.message ?? 'AI 正在处理';
    return;
  }

  if (event.type === 'chunk') {
    streamText.value += event.text ?? ''; // 将增量文本实时显示到浮窗
    return;
  }

  if (event.type === 'error') {
    stage.value = 'error';
    message.value = event.message ?? 'AI 请求失败';
    return;
  }

  if (event.type === 'done') {
    handleAICompleted(messageData.phase, event.text ?? streamText.value);
  }
}

/**
 * 处理一轮 AI 流式输出结束事件。
 */
async function handleAICompleted(phase: 'analyze' | 'complete', text: string): Promise<void> {
  try {
    const normalized = normalizeAnalysis(
      parseAIAnalysis(text),
      fields.value,
      mode.value,
      phase === 'complete' ? analysis.value ?? undefined : undefined,
      conversation.value,
    ); // 后续对话沿用上一轮复杂字段结果
    const canContinueConversation = phase === 'analyze'
      || mode.value === 'serious';
    const result = canContinueConversation ? normalized : { ...normalized, questions: [] }; // 正常模式收敛，认真模式按用户回复持续追问
    if (phase === 'analyze') {
      analysis.value = result;
      finalAnswers.value = result.resolvedAnswers;
      const shouldOpenConversation = mode.value !== 'casual';
      conversation.value = shouldOpenConversation
        ? [{ role: 'assistant', content: buildConversationOpening(result.questions) }]
        : [];
      chatInput.value = '';
      conversationRound.value = shouldOpenConversation ? 1 : 0; // 非敷衍模式允许用户补充自然语言上下文
      stage.value = shouldOpenConversation ? 'waiting' : 'ready';
      message.value = shouldOpenConversation ? '请在对话中补充关键信息，也可以直接应用初步答案' : 'AI 已生成整份答案，请检查后应用';
    } else {
      analysis.value = {
        ...(analysis.value ?? { summary: '', fieldSummaries: [], resolvedAnswers: [], questions: [], warnings: [] }),
        ...result,
        fieldSummaries: result.fieldSummaries.length > 0
          ? result.fieldSummaries
          : analysis.value?.fieldSummaries ?? [], // 补全响应未重复字段摘要时沿用上一轮识别结果
      };
      finalAnswers.value = result.resolvedAnswers;
      if (result.questions.length > 0) {
        conversation.value = [
          ...conversation.value,
          { role: 'assistant', content: buildConversationOpening(result.questions) },
        ];
        conversationRound.value += 1; // 认真模式继续下一轮对话
        stage.value = 'waiting';
        message.value = '请继续在对话中补充信息';
      } else {
        conversation.value = [
          ...conversation.value,
          { role: 'assistant', content: '已根据你的回答和上下文补全整份问卷；未明确提到的字段已使用合理推断。' }, // 明确告知对话补全已完成
        ];
        stage.value = 'ready';
        message.value = '对话已完成，整份答案已准备好，请检查后应用';
      }
    }
    await persistSession(stage.value === 'ready' ? 'ready_to_fill' : 'waiting_for_user');
  } catch {
    stage.value = 'error';
    message.value = 'AI 返回格式无法识别，请重试或检查模型配置';
  }
}

/**
 * 绑定后台流式消息监听器。
 */
function bindStreamListener(): void {
  browser.runtime.onMessage.addListener(handleStreamMessage); // 监听 Service Worker 的实时输出
}

/**
 * 解绑后台流式消息监听器。
 */
function unbindStreamListener(): void {
  browser.runtime.onMessage.removeListener(handleStreamMessage); // 页面销毁时释放监听器
}

/**
 * 等待动态问卷页面完成一轮渲染，避免按钮刚出现时扫描到空页面。
 */
function waitForScanResult(): Promise<ReturnType<typeof scanQuestionnaire>> {
  return new Promise((resolve) => {
    let attempt = 0;
    /**
     * 重新读取当前页面的题目控件。
     */
    const scan = () => {
      const result = scanQuestionnaire(document); // 每次重试都重新读取当前 DOM
      if (result.fields.length > 0 || attempt >= 3) {
        resolve(result);
        return;
      }
      attempt += 1;
      window.setTimeout(scan, 180); // 给异步渲染和分页切换留出时间
    };
    scan();
  });
}

/**
 * 扫描当前网页中的待填写字段。
 */
async function scanPage(): Promise<void> {
  streamText.value = '';
  analysis.value = null;
  finalAnswers.value = [];
  conversation.value = [];
  chatInput.value = '';
  pageContext.value = '';
  showFieldDetails.value = false;
  expandedFieldIds.value = {};
  showAllAnswers.value = false;
  conversationRound.value = 0;
  skippedFields.value = [];
  filledCount.value = 0;
  currentRequestId.value = ''; // 清除旧请求标识，避免翻页后的旧响应回填到新页面
  currentPhase.value = null;
  const result = await waitForScanResult();
  fields.value = result.fields;
  pageContext.value = result.pageContext;

  const visiblePageText = document.body?.innerText?.trim() ?? ''; // 有页面内容就允许交给 AI 识别复杂表单
  if (result.fields.length === 0 && result.formScore === 0 && visiblePageText.length < 24) {
    stage.value = 'error';
    message.value = '当前页面没有足够内容供 AI 识别表单字段';
    return;
  }

  stage.value = 'scanned';
  message.value = result.fields.length > 0
    ? `发现 ${result.fields.length} 个候选字段，可以开始 AI 识别`
    : '未识别到标准控件，将交给 AI 从页面内容归纳字段'; // 复杂网页先交给 AI 识别页面上下文
  await persistSession('scanned', result);
}

/**
 * 调用 AI 识别当前问卷并生成追问。
 */
async function analyzePage(): Promise<void> {
  await scanPage(); // 每次识别前都重扫，兼容问卷翻页和动态更新
  if (fields.value.length === 0 && !pageContext.value.trim()) return;

  try {
    const settings = await getSettings();
    if (!settings.ai.apiKey || !settings.ai.baseURL || !settings.ai.model) {
      throw new Error('请先打开设置填写 AI 配置。');
    }

    const prompt = buildAnalysisPrompt(
      fields.value,
      mode.value,
      document.title,
      window.location.href,
      pageContext.value,
    );
    currentRequestId.value = createRequestId('analyze');
    currentPhase.value = 'analyze';
    streamText.value = '';
    stage.value = 'analyzing';
    message.value = 'AI 正在识别问卷内容';
    await persistSession('analyzing');

    const response = (await browser.runtime.sendMessage({
      type: 'AQ_AI_STREAM_REQUEST',
      requestId: currentRequestId.value,
      phase: 'analyze',
      payload: prompt,
    })) as { ok?: boolean; message?: string } | undefined;
    if (response?.ok === false) throw new Error(response.message || '后台没有启动 AI 请求。');
  } catch (error) {
    stage.value = 'error';
    message.value = error instanceof Error ? error.message : 'AI 请求启动失败，请重新加载扩展。';
  }
}

/**
 * 将用户的一段自然语言回复发送给 AI 并统一补全问卷答案。
 */
async function sendConversationMessage(): Promise<void> {
  if (!analysis.value) return;
  const content = chatInput.value.trim();
  if (!content || stage.value !== 'waiting') return;

  conversation.value.push({ role: 'user', content }); // 将用户的自然语言回复加入对话上下文
  chatInput.value = '';
  try {
    const settings = await getSettings();
    if (!settings.ai.apiKey || !settings.ai.baseURL || !settings.ai.model) {
      throw new Error('请先打开设置填写 AI 配置。');
    }

    const prompt = buildCompletionPrompt(
      fields.value,
      analysis.value.fieldSummaries, // 传递 AI 归纳字段，支持复杂页面继续对话
      analysis.value.resolvedAnswers,
      analysis.value.questions,
      conversation.value,
      mode.value,
      conversationRound.value,
      pageContext.value, // 传递页面上下文，避免 AI 只看到临时字段编号
    );

    currentRequestId.value = createRequestId('complete');
    currentPhase.value = 'complete';
    streamText.value = '';
    stage.value = 'completing';
    message.value = 'AI 正在根据这段对话补全整份问卷';
    await persistSession('analyzing');

    const response = (await browser.runtime.sendMessage({
      type: 'AQ_AI_STREAM_REQUEST',
      requestId: currentRequestId.value,
      phase: 'complete',
      payload: prompt,
    })) as { ok?: boolean; message?: string } | undefined;
    if (response?.ok === false) throw new Error(response.message || '后台没有启动 AI 请求。');
  } catch (error) {
    stage.value = 'error';
    message.value = error instanceof Error ? error.message : 'AI 请求启动失败，请重新加载扩展。';
  }
}

/**
 * 将当前页面和识别结果保存为临时问卷会话。
 */
async function persistSession(
  status: QuestionnaireSession['status'],
  scanResult?: ReturnType<typeof scanQuestionnaire>,
): Promise<void> {
  const now = new Date().toISOString();
  const session: QuestionnaireSession = {
    sessionId: `session-${Date.now()}`,
    pageTitle: document.title || '未命名页面',
    url: window.location.href,
    status,
    snapshot: {
      pageTitle: document.title || '未命名页面',
      url: window.location.href,
      formScore: scanResult?.formScore ?? Math.min(fields.value.length * 4, 100),
      fields: serializeFields(scanResult?.fields ?? fields.value),
      capturedAt: now,
    },
    analysis: analysis.value ?? undefined,
    finalAnswers: finalAnswers.value,
    createdAt: now,
    updatedAt: now,
  };
  await saveSession(session); // 保存当前会话，页面刷新后仍可清理或查看
}

/**
 * 将最终答案应用到当前网页。
 */
async function fillPage(): Promise<void> {
  if (fields.value.length === 0) {
    message.value = 'AI 已完成页面归纳，但当前页面没有建立可回填的控件映射。';
    return;
  }
  const answerMap = Object.fromEntries(finalAnswers.value.map((answer) => [answer.fieldId, answer.value]));
  const result = applyAnswers(fields.value, answerMap); // 由扩展固定逻辑执行填写
  filledCount.value = result.filled;
  skippedFields.value = result.skipped;
  stage.value = 'filled';
  message.value = result.skipped.length > 0 ? '填写完成，仍有字段需要人工补充' : '填写完成，请人工审核后提交';
  await persistSession('filled');
}

/**
 * 打开扩展配置页。
 */
async function openOptions(): Promise<void> {
  await browser.runtime.openOptionsPage(); // 打开 AI 和浮窗配置页面
}

/**
 * 清除当前页面的识别结果。
 */
async function resetPanel(): Promise<void> {
  stage.value = 'idle';
  message.value = '点击扫描当前页面';
  streamText.value = '';
  currentRequestId.value = ''; // 清理旧请求，忽略其后续流式事件
  currentPhase.value = null;
  fields.value = [];
  pageContext.value = '';
  analysis.value = null;
  finalAnswers.value = [];
  conversation.value = [];
  chatInput.value = '';
  showFieldDetails.value = false;
  expandedFieldIds.value = {};
  showAllAnswers.value = false;
  conversationRound.value = 0;
  skippedFields.value = [];
  filledCount.value = 0;
  await browser.storage.local.remove('aq-current-session'); // 清除本次问卷工作区
}

/**
 * 将答案值转换为页面展示文本。
 */
function formatAnswer(value: unknown): string {
  if (Array.isArray(value)) return value.join('、');
  if (value === true) return '是';
  if (value === false) return '否';
  if (value === null || value === undefined || value === '') return '未知';
  return String(value);
}

/**
 * 加载浮窗初始配置并绑定实时消息监听器。
 */
async function initializePanel(): Promise<void> {
  const settings = await getSettings();
  mode.value = settings.inquiryMode; // 首次打开时展示用户保存的询问模式
  bindStreamListener();
}

onMounted(() => {
  void initializePanel();
});
onUnmounted(unbindStreamListener);
</script>

<template>
  <div class="aq-shell">
    <button v-if="!isOpen" class="aq-launcher" type="button" title="打开 Auto Questionnaire" @click="isOpen = true">
      <Sparkles :size="21" />
      <span class="aq-launcher-dot"></span>
    </button>

    <section v-else class="aq-panel" aria-label="Auto Questionnaire 浮窗">
      <header class="aq-header">
        <div class="aq-brand">
          <span class="aq-brand-mark"><Bot :size="17" /></span>
          <div>
            <strong>Auto Questionnaire</strong>
            <small>AI 问卷辅助填写</small>
          </div>
        </div>
        <div class="aq-header-actions">
          <button class="aq-icon-button" type="button" title="打开设置" @click="openOptions">
            <Settings2 :size="16" />
          </button>
          <button class="aq-icon-button" type="button" title="关闭浮窗" @click="isOpen = false">
            <X :size="17" />
          </button>
        </div>
      </header>

      <div class="aq-toolbar">
        <label class="aq-mode-select">
          <span>询问模式</span>
          <select v-model="mode" :disabled="isBusy">
            <option v-for="item in modeOptions" :key="item.value" :value="item.value">
              {{ item.label }} · {{ item.description }}
            </option>
          </select>
        </label>
        <button class="aq-primary-button" type="button" :disabled="isBusy" @click="analyzePage">
          <LoaderCircle v-if="isBusy" class="aq-spin" :size="15" />
          <ScanSearch v-else :size="15" />
          {{ fields.length > 0 ? '重新扫描并识别' : '扫描并识别' }}
        </button>
      </div>

      <div class="aq-status" :class="`is-${stage}`">
        <span class="aq-status-icon">
          <CircleAlert v-if="stage === 'error'" :size="15" />
          <Check v-else-if="stage === 'filled' || stage === 'ready'" :size="15" />
          <LoaderCircle v-else-if="isBusy" class="aq-spin" :size="15" />
          <ClipboardCheck v-else :size="15" />
        </span>
        <span>{{ message }}</span>
      </div>

      <div v-if="streamText && isBusy" class="aq-stream">
        <div class="aq-section-label">实时输出</div>
        <pre>{{ streamText }}</pre>
      </div>

      <div v-if="analysis?.summary" class="aq-summary">
        <div class="aq-summary-heading">
          <Sparkles :size="15" />
          <strong>AI 问卷摘要</strong>
        </div>
        <p>{{ analysis.summary }}</p>
      </div>

      <div v-if="fieldSummaryList.length > 0" class="aq-section aq-fields-section">
        <div class="aq-section-heading">
          <div class="aq-heading-copy">
            <span>{{ analysis ? 'AI 识别字段' : '候选字段' }}</span>
            <em>{{ fieldSummaryList.length }} 个</em>
          </div>
          <button class="aq-section-toggle" type="button" :aria-expanded="showFieldDetails" title="展开或收起字段摘要" @click="toggleFieldDetails">
            <ChevronUp v-if="showFieldDetails" :size="15" />
            <ChevronDown v-else :size="15" />
          </button>
        </div>
        <div v-if="showFieldDetails" class="aq-field-list">
          <template v-for="field in fieldSummaryList" :key="field.fieldId">
            <button class="aq-field-row" type="button" @click="toggleFieldSummary(field.fieldId)">
              <span class="aq-field-type">{{ field.type }}</span>
              <span class="aq-field-label">{{ field.label }}</span>
              <span v-if="field.required" class="aq-required">必填</span>
              <ChevronUp v-if="expandedFieldIds[field.fieldId]" :size="14" />
              <ChevronDown v-else :size="14" />
            </button>
            <div v-if="expandedFieldIds[field.fieldId]" class="aq-field-detail">
              <p>{{ field.description || 'AI 未提供额外说明。' }}</p>
              <small v-if="field.options.length > 0">选项：{{ field.options.join('、') }}</small>
            </div>
          </template>
        </div>
      </div>

      <div v-if="analysis && fields.length === 0" class="aq-warning">
        <CircleAlert :size="15" />
        <span>AI 已从页面内容完成字段归纳，但当前页面控件未建立可回填映射，暂不能自动填写。</span>
      </div>

      <div v-if="conversation.length > 0" class="aq-section aq-conversation-section">
        <div class="aq-section-heading">
          <span>AI 询问</span>
          <em>{{ stage === 'waiting' ? '等待回复' : `${conversation.length} 条消息` }}</em>
        </div>
        <div class="aq-chat-list">
          <div v-for="(item, index) in conversation" :key="`${item.role}-${index}`" class="aq-chat-message" :class="`is-${item.role}`">
            <span class="aq-chat-role">{{ item.role === 'assistant' ? 'AI' : '你' }}</span>
            <p>{{ item.content }}</p>
          </div>
        </div>
        <div v-if="stage === 'waiting'" class="aq-chat-compose">
          <textarea
            v-model="chatInput"
            rows="3"
            placeholder="直接描述你的情况或偏好；没有提到的内容会自动合理补全。"
            @keydown.enter.exact.prevent="sendConversationMessage"
          ></textarea>
          <button class="aq-secondary-button" type="button" :disabled="isBusy || !chatInput.trim()" @click="sendConversationMessage">
            <Send :size="15" />
            发送并生成答案
          </button>
        </div>
      </div>

      <div v-if="answerList.length > 0" class="aq-section">
        <div class="aq-section-heading">
          <span>待填写答案</span>
          <em>{{ answerList.length }} 项</em>
          <button v-if="answerList.length > 3" class="aq-answer-toggle" type="button" @click="toggleAnswerList">
            {{ showAllAnswers ? '收起' : `展开其余 ${answerList.length - 3} 项` }}
            <ChevronUp v-if="showAllAnswers" :size="13" />
            <ChevronDown v-else :size="13" />
          </button>
        </div>
        <div class="aq-answer-list">
          <div v-for="answer in visibleAnswers" :key="answer.fieldId" class="aq-answer-row">
            <span>{{ fieldSummaryList.find((field) => field.fieldId === answer.fieldId)?.label ?? fields.find((field) => field.id === answer.fieldId)?.label ?? answer.fieldId }}</span>
            <strong>{{ formatAnswer(answer.value) }}</strong>
          </div>
        </div>
      </div>

      <div v-if="analysis?.warnings?.length" class="aq-warning">
        <CircleAlert :size="15" />
        <span>{{ analysis.warnings.join('；') }}</span>
      </div>

      <div v-if="skippedFields.length > 0" class="aq-warning">
        <CircleAlert :size="15" />
        <span>需要手动补充：{{ skippedFields.join('、') }}</span>
      </div>

      <footer class="aq-footer">
        <button class="aq-text-button" type="button" :disabled="isBusy" @click="resetPanel">
          <RotateCcw :size="14" />
          清空
        </button>
        <button class="aq-fill-button" type="button" :disabled="answerList.length === 0 || fields.length === 0 || isBusy" @click="fillPage">
          <Check :size="15" />
          {{ stage === 'filled' ? `已填写 ${filledCount} 项` : '应用答案' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style>
:host {
  all: initial;
  font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif;
}

* {
  box-sizing: border-box;
}

button,
select,
textarea {
  font: inherit;
}

.aq-shell {
  position: fixed;
  z-index: 2147483647;
  right: 20px;
  bottom: 20px;
  color: #17212b;
  font-size: 13px;
}

.aq-launcher {
  position: relative;
  display: grid;
  width: 46px;
  height: 46px;
  place-items: center;
  border: 1px solid #d8e2ea;
  border-radius: 50%;
  background: #0f766e;
  color: #fff;
  cursor: pointer;
  box-shadow: 0 10px 26px rgb(15 118 110 / 24%);
}

.aq-launcher:hover {
  background: #115e59;
}

.aq-launcher-dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 8px;
  height: 8px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: #f59e0b;
}

.aq-panel {
  width: min(390px, calc(100vw - 32px));
  max-height: min(720px, calc(100vh - 32px));
  overflow: auto;
  border: 1px solid #d9e2e8;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 18px 50px rgb(23 33 43 / 18%);
}

.aq-header,
.aq-footer,
.aq-toolbar,
.aq-section-heading,
.aq-answer-row,
.aq-field-row {
  display: flex;
  align-items: center;
}

.aq-header {
  justify-content: space-between;
  padding: 14px 15px 12px;
  border-bottom: 1px solid #edf1f4;
}

.aq-brand,
.aq-header-actions,
.aq-status,
.aq-warning,
.aq-text-button,
.aq-fill-button,
.aq-primary-button,
.aq-secondary-button {
  display: flex;
  align-items: center;
}

.aq-brand {
  gap: 9px;
}

.aq-brand-mark {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 7px;
  background: #e6f3f1;
  color: #0f766e;
}

.aq-brand strong,
.aq-brand small {
  display: block;
}

.aq-brand strong {
  font-size: 13px;
  line-height: 1.2;
}

.aq-brand small {
  margin-top: 2px;
  color: #7a8994;
  font-size: 11px;
}

.aq-header-actions {
  gap: 3px;
}

.aq-icon-button,
.aq-text-button {
  border: 0;
  background: transparent;
  color: #71808b;
  cursor: pointer;
}

.aq-icon-button {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 6px;
}

.aq-icon-button:hover {
  background: #f1f5f7;
  color: #0f766e;
}

.aq-toolbar {
  gap: 8px;
  padding: 12px 15px;
  background: #fbfcfd;
}

.aq-mode-select {
  min-width: 0;
  flex: 1;
}

.aq-mode-select span,
.aq-section-label {
  display: block;
  color: #73828c;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
}

.aq-mode-select select,
.aq-chat-compose textarea {
  width: 100%;
  border: 1px solid #dce5ea;
  border-radius: 6px;
  outline: none;
  background: #fff;
  color: #263641;
}

.aq-mode-select select {
  height: 32px;
  margin-top: 4px;
  padding: 0 8px;
  font-size: 12px;
}

.aq-mode-select select:focus,
.aq-chat-compose textarea:focus {
  border-color: #2b9c91;
  box-shadow: 0 0 0 2px rgb(43 156 145 / 12%);
}

.aq-primary-button,
.aq-secondary-button,
.aq-fill-button {
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}

.aq-primary-button {
  align-self: end;
  padding: 0 10px;
  background: #0f766e;
  color: #fff;
  font-size: 12px;
}

.aq-secondary-button {
  padding: 0 12px;
  border-color: #cfe3e0;
  background: #f1faf8;
  color: #0f766e;
  font-size: 12px;
}

.aq-fill-button {
  padding: 0 13px;
  background: #0f766e;
  color: #fff;
  font-size: 12px;
}

.aq-primary-button:hover,
.aq-fill-button:hover {
  background: #115e59;
}

.aq-secondary-button:hover {
  background: #e6f3f1;
}

button:disabled,
select:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.aq-status {
  gap: 8px;
  margin: 12px 15px 0;
  padding: 9px 10px;
  border: 1px solid #e2ebef;
  border-radius: 7px;
  background: #f7fafb;
  color: #52636e;
  line-height: 1.35;
}

.aq-status.is-error {
  border-color: #f5d6d1;
  background: #fff8f7;
  color: #b42318;
}

.aq-status.is-ready,
.aq-status.is-filled {
  border-color: #cfe3e0;
  background: #f1faf8;
  color: #0f766e;
}

.aq-status-icon {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
}

.aq-section,
.aq-summary,
.aq-stream,
.aq-warning {
  margin: 12px 15px 0;
}

.aq-section-heading {
  justify-content: space-between;
  color: #31424d;
  font-size: 12px;
  font-weight: 700;
}

.aq-heading-copy {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.aq-section-heading em {
  color: #8b9aa3;
  font-size: 11px;
  font-style: normal;
  font-weight: 500;
}

.aq-section-toggle,
.aq-answer-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 0;
  background: transparent;
  color: #0f766e;
  cursor: pointer;
  font-size: 10px;
}

.aq-section-toggle {
  width: 26px;
  height: 26px;
  justify-content: center;
  border-radius: 6px;
}

.aq-section-toggle:hover,
.aq-answer-toggle:hover {
  background: #e6f3f1;
}

.aq-answer-toggle {
  margin-left: auto;
  padding: 3px 4px;
}

.aq-field-list,
.aq-answer-list {
  margin-top: 7px;
  overflow: hidden;
  border: 1px solid #e8eef1;
  border-radius: 7px;
}

.aq-field-row,
.aq-answer-row {
  gap: 7px;
  min-height: 31px;
  padding: 6px 8px;
  border-bottom: 1px solid #eef2f4;
  font-size: 11px;
}

.aq-field-row {
  width: 100%;
  border: 0;
  border-bottom: 1px solid #eef2f4;
  background: #fff;
  color: #31424d;
  cursor: pointer;
  text-align: left;
}

.aq-field-row:hover {
  background: #f7fbfa;
}

.aq-field-row:last-child,
.aq-answer-row:last-child {
  border-bottom: 0;
}

.aq-field-type {
  min-width: 52px;
  color: #8a99a2;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
}

.aq-field-label,
.aq-answer-row span {
  min-width: 0;
  overflow: hidden;
  flex: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aq-required {
  color: #c2410c;
  font-size: 10px;
}

.aq-field-detail {
  padding: 7px 9px 8px 68px;
  border-bottom: 1px solid #eef2f4;
  background: #fbfcfd;
}

.aq-field-detail p,
.aq-field-detail small {
  margin: 0;
  color: #6f808a;
  font-size: 10px;
  line-height: 1.45;
}

.aq-field-detail small {
  display: block;
  margin-top: 3px;
}

.aq-answer-row strong {
  max-width: 52%;
  overflow: hidden;
  color: #0f766e;
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aq-muted {
  margin: 0;
  padding: 7px 8px;
  color: #8b9aa3;
  font-size: 11px;
}

.aq-summary {
  padding: 12px 13px;
  border: 1px solid #a9d6d0;
  border-left: 4px solid #0f766e;
  border-radius: 8px;
  background: #eef9f7;
  box-shadow: 0 4px 14px rgb(15 118 110 / 8%);
}

.aq-summary-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #0f766e;
  font-size: 12px;
}

.aq-summary-heading strong {
  font-size: 12px;
}

.aq-summary p {
  margin: 5px 0 0;
  color: #3f5b60;
  font-size: 12px;
  line-height: 1.5;
}

.aq-conversation-section {
  padding: 10px;
  border: 1px solid #c2dedb;
  border-radius: 8px;
  background: #f6fbfa;
}

.aq-stream pre {
  max-height: 130px;
  margin: 5px 0 0;
  overflow: auto;
  padding: 8px;
  border-radius: 6px;
  background: #18242b;
  color: #d9f3ed;
  font-size: 10px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.aq-chat-list {
  display: grid;
  gap: 7px;
  margin-top: 8px;
  max-height: 230px;
  overflow: auto;
}

.aq-chat-message {
  display: grid;
  grid-template-columns: 25px minmax(0, 1fr);
  gap: 7px;
  padding: 8px;
  border: 1px solid #e8eef1;
  border-radius: 7px;
  background: #fbfcfd;
}

.aq-chat-message.is-user {
  border-color: #cfe3e0;
  background: #f1faf8;
}

.aq-chat-role {
  display: grid;
  width: 25px;
  height: 22px;
  place-items: center;
  border-radius: 5px;
  background: #e6f3f1;
  color: #0f766e;
  font-size: 10px;
  font-weight: 700;
}

.aq-chat-message.is-user .aq-chat-role {
  background: #d9e9e6;
}

.aq-chat-message p {
  min-width: 0;
  margin: 2px 0 0;
  color: #52636e;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.aq-chat-compose {
  display: grid;
  gap: 7px;
  margin-top: 10px;
}

.aq-chat-compose textarea {
  min-height: 70px;
  padding: 8px;
  font-size: 11px;
  line-height: 1.45;
  resize: vertical;
}

.aq-chat-compose .aq-secondary-button {
  justify-self: end;
}

.aq-warning {
  gap: 7px;
  padding: 8px 9px;
  border: 1px solid #f1dfb6;
  border-radius: 6px;
  background: #fffaf0;
  color: #996c12;
  font-size: 11px;
  line-height: 1.4;
}

.aq-footer {
  justify-content: space-between;
  gap: 8px;
  margin-top: 14px;
  padding: 11px 15px 14px;
  border-top: 1px solid #edf1f4;
}

.aq-text-button {
  gap: 5px;
  padding: 4px 2px;
  font-size: 11px;
}

.aq-text-button:hover {
  color: #0f766e;
}

.aq-spin {
  animation: aq-spin 0.9s linear infinite;
}

@keyframes aq-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
