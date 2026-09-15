import type {
  FieldType,
  QuestionnaireField,
  QuestionnaireOption,
  ScanResult,
} from '../shared/types';

interface ScanCandidate {
  element: HTMLElement;
  kind: 'choice' | 'text' | 'select' | 'contenteditable';
  choiceType?: 'single' | 'multiple';
}

interface ChoiceGroup {
  container: HTMLElement;
  choiceType: 'single' | 'multiple';
  candidates: ScanCandidate[];
}

interface FieldEntry {
  order: number;
  candidate?: ScanCandidate;
  group?: ChoiceGroup;
}

const CONTROL_SELECTOR = [
  'input:not([type="hidden"]):not([type="password"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"])',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[aria-haspopup="listbox"]',
].join(',');

const QUESTION_TITLE_SELECTOR = [
  '.question-title',
  '.question-title-text',
  '.question-header',
  '.question-label',
  '.question-text',
  '.topic-title',
  '.question-name',
  '.q-title',
  '[data-question-title]',
  '[data-testid*="question"]',
  'legend',
  '.form-label',
  '.el-form-item__label',
  '.ant-form-item-label',
  '.field-label',
  '[class*="question-title"]',
  '[class*="form-label"]',
  '[class*="field-label"]',
].join(',');

/**
 * 清理题干和选项文本，避免把页面装饰和大量空白交给 AI。
 */
function cleanText(value: string, limit = 180): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * 将两个可能带有标点和空格差异的答案转换为可比较文本。
 */
function normalizeText(value: string): string {
  return cleanText(value, 240)
    .toLocaleLowerCase()
    .replace(/[\s\u3000，。、“”‘’（）()【】\[\]：:；;、\/\\|_-]+/g, '');
}

/**
 * 读取元素的可见文字，兼容普通 DOM 和部分前端框架节点。
 */
function getElementText(element: HTMLElement): string {
  return cleanText(element.innerText || element.textContent || '', 320);
}

/**
 * 获取元素对应的原生单选或复选控件。
 */
function getNativeChoice(element: HTMLElement): HTMLInputElement | null {
  if (element instanceof HTMLInputElement && ['radio', 'checkbox'].includes(element.type)) {
    return element;
  }

  return element.querySelector<HTMLInputElement>('input[type="radio"], input[type="checkbox"]');
}

/**
 * 获取自定义单选或复选节点的实际外层容器。
 */
function getChoiceRoot(element: HTMLElement): HTMLElement {
  const root = element.closest<HTMLElement>(
    '[role="radio"], [role="checkbox"], label, .ws-radio, .ws-checkbox, .option-box, .radio-item, .checkbox-item',
  );
  return root ?? element;
}

/**
 * 判断节点是否是单选或复选类型。
 */
function getChoiceType(element: HTMLElement): 'single' | 'multiple' | null {
  const role = element.getAttribute('role');
  if (role === 'radio') return 'single';
  if (role === 'checkbox') return 'multiple';

  const nativeChoice = getNativeChoice(element);
  if (nativeChoice?.type === 'radio') return 'single';
  if (nativeChoice?.type === 'checkbox') return 'multiple';
  return null;
}

/**
 * 判断元素是否被页面禁用。
 */
function isDisabledElement(element: HTMLElement): boolean {
  const nativeChoice = getNativeChoice(element);
  return Boolean(
    (element as HTMLInputElement).disabled ||
      nativeChoice?.disabled ||
      element.getAttribute('aria-disabled') === 'true' ||
      getChoiceRoot(element).getAttribute('aria-disabled') === 'true',
  );
}

/**
 * 判断元素是否被页面隐藏，允许自定义选项内部的隐藏原生 input 参与扫描。
 */
function isVisibleElement(element: HTMLElement, documentRef: Document): boolean {
  const choiceType = getChoiceType(element);
  const visibleTarget = choiceType ? getChoiceRoot(element) : element;
  let current: HTMLElement | null = visibleTarget;
  const view = documentRef.defaultView;

  while (current && current !== documentRef.documentElement) {
    if (current.hidden) return false;
    const style = view?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    current = current.parentElement;
  }

  const rect = visibleTarget.getBoundingClientRect();
  return (rect.width > 0 && rect.height > 0) || visibleTarget.getClientRects().length > 0;
}

/**
 * 读取 aria-label 或 aria-labelledby 中的辅助文本。
 */
function getAriaLabel(element: HTMLElement, documentRef: Document): string {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return cleanText(ariaLabel);

  const labelledBy = element.getAttribute('aria-labelledby');
  if (!labelledBy) return '';

  return cleanText(
    labelledBy
      .split(/\s+/)
      .map((id) => documentRef.getElementById(id)?.textContent ?? '')
      .join(' '),
  );
}

/**
 * 获取原生控件通过 label[for] 关联的题目文字。
 */
function getLabelByFor(element: HTMLElement, documentRef: Document): string {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
    return '';
  }
  if (!element.id) return '';

  const label = Array.from(documentRef.querySelectorAll<HTMLLabelElement>('label[for]')).find(
    (item) => item.htmlFor === element.id,
  );
  return cleanText(label?.textContent ?? '');
}

/**
 * 获取选项节点附近的文字，兼容问卷网等使用隐藏 input 的自定义控件。
 */
function getOptionLabel(element: HTMLElement): string {
  const root = getChoiceRoot(element);
  const title = root.querySelector<HTMLElement>(
    '.option-title, .ws-radio__label, .ws-checkbox__label, .option-label, [class*="option-title"], [class*="option-label"]',
  );
  const rootText = getElementText(title ?? root);
  if (rootText) return rootText;

  const nativeChoice = getNativeChoice(element);
  return cleanText(nativeChoice?.value ?? element.getAttribute('data-value') ?? '');
}

/**
 * 获取输入节点附近最有可能代表题目的文字。
 */
function getElementLabel(element: HTMLElement, documentRef: Document): string {
  const labelByFor = getLabelByFor(element, documentRef);
  const closestLabel = cleanText(element.closest('label')?.textContent ?? '');
  const ariaLabel = getAriaLabel(element, documentRef);
  const choiceLabel = getChoiceType(element) ? getOptionLabel(element) : '';
  const input = element as HTMLInputElement;
  const placeholder = cleanText(input.placeholder ?? '');
  const parentText = cleanText(element.parentElement?.innerText ?? '');

  return [labelByFor, closestLabel, ariaLabel, choiceLabel, placeholder, parentText].find(Boolean) ?? '';
}

/**
 * 判断祖先节点是否像一个独立的问卷题目容器。
 */
function isQuestionContainer(element: HTMLElement): boolean {
  if (element.tagName === 'FIELDSET') return true;

  const marker = `${element.id} ${element.className}`.toLocaleLowerCase();
  return /question-box|question-wrap|question-item|question-container|question-group|questionnaire-item|survey-question|survey-item|form-item|form-group|field-item|field-group|topic-item|problem-item|^q_/.test(
    marker,
  );
}

/**
 * 找到容器内部最可能代表题干的节点。
 */
function getQuestionTitleElement(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(QUESTION_TITLE_SELECTOR);
}

/**
 * 从控件向上寻找题目容器，优先选择同时包含题干的节点。
 */
function getQuestionContainer(element: HTMLElement): HTMLElement {
  let current: HTMLElement | null = element;
  let fallback: HTMLElement = element.parentElement ?? element;

  for (let depth = 0; current && depth < 20; depth += 1) {
    if (isQuestionContainer(current)) {
      fallback = current;
      if (getQuestionTitleElement(current) || current.tagName === 'FIELDSET') return current;
    }
    current = current.parentElement;
  }

  return fallback;
}

/**
 * 获取题目文字，并在没有标准题干 class 时回退到可访问性文本。
 */
function getQuestionLabel(element: HTMLElement, container: HTMLElement, documentRef: Document): string {
  const title = getQuestionTitleElement(container);
  const titleText = cleanText(title?.innerText || title?.textContent || '', 240);
  if (titleText) return titleText;

  const containerAria = getAriaLabel(container, documentRef);
  if (containerAria) return containerAria;

  return getElementLabel(element, documentRef);
}

/**
 * 判断题目是否必填，兼容 required、aria-required 和题干星号标记。
 */
function isRequiredField(element: HTMLElement, container: HTMLElement): boolean {
  const nativeChoice = getNativeChoice(element);
  const titleText = getElementText(getQuestionTitleElement(container) ?? container);
  return Boolean(
    (element as HTMLInputElement).required ||
      nativeChoice?.required ||
      element.getAttribute('aria-required') === 'true' ||
      container.getAttribute('aria-required') === 'true' ||
      /[*＊]|必填|必答|必须/.test(titleText),
  );
}

/**
 * 将 HTML 控件映射为问卷字段类型。
 */
function getFieldType(element: HTMLElement): FieldType {
  const role = element.getAttribute('role');
  if (role === 'radio') return 'single';
  if (role === 'checkbox') return 'multiple';
  if (role === 'combobox' || element.getAttribute('aria-haspopup') === 'listbox') return 'select';
  if (element.isContentEditable || (role === 'textbox' && !('value' in element))) return 'contenteditable';
  if (element.tagName === 'TEXTAREA') return 'textarea';
  if (element.tagName === 'SELECT') return 'select';

  const inputType = (element as HTMLInputElement).type?.toLowerCase();
  if (inputType === 'radio') return 'single';
  if (inputType === 'checkbox') return 'multiple';
  if (inputType === 'email') return 'email';
  if (inputType === 'number' || inputType === 'range') return 'number';
  if (
    inputType === 'text' ||
    inputType === 'search' ||
    inputType === 'url' ||
    inputType === 'tel' ||
    inputType === 'date' ||
    inputType === 'datetime-local' ||
    inputType === 'month' ||
    inputType === 'week' ||
    inputType === 'time' ||
    !inputType
  ) return 'text';
  return 'unknown';
}

/**
 * 读取控件当前值。
 */
function getCurrentValue(element: HTMLElement): string {
  if (element.isContentEditable) return element.textContent?.trim() ?? '';
  if (element instanceof HTMLSelectElement) {
    return Array.from(element.selectedOptions)
      .map((option) => cleanText(option.textContent ?? option.value))
      .join('、');
  }
  if (element instanceof HTMLInputElement && ['radio', 'checkbox'].includes(element.type)) {
    return element.checked ? 'true' : 'false';
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value ?? '';
  return element.getAttribute('aria-valuetext') ?? element.textContent?.trim() ?? '';
}

/**
 * 读取原生或自定义下拉框的选项。
 */
function getSelectOptions(element: HTMLElement): QuestionnaireOption[] {
  if (element instanceof HTMLSelectElement) {
    return Array.from(element.options).map((option) => ({
      label: cleanText(option.textContent ?? option.value),
      value: option.value,
    }));
  }

  const listId = element.getAttribute('aria-controls') || element.getAttribute('aria-owns');
  const optionRoot = listId ? element.ownerDocument.getElementById(listId) ?? element : element;
  return Array.from(optionRoot.querySelectorAll<HTMLElement>('[role="option"]')).map((option) => ({
    label: getElementText(option),
    value: option.getAttribute('data-value') ?? option.getAttribute('value') ?? getElementText(option),
    element: option,
  }));
}

/**
 * 判断单选或复选选项当前是否已选中。
 */
function isChoiceSelected(element: HTMLElement): boolean {
  const nativeChoice = getNativeChoice(element);
  if (nativeChoice) return nativeChoice.checked;

  return (
    element.getAttribute('aria-checked') === 'true' ||
    element.getAttribute('aria-selected') === 'true' ||
    /(^|\s)(checked|selected|active|is-checked|is-selected)(\s|$)/i.test(element.className)
  );
}

/**
 * 为页面控件生成稳定的本次扫描字段 ID。
 */
function makeFieldId(element: HTMLElement, index: number): string {
  const existing = element.dataset.aqFieldId;
  if (existing) return existing;
  const id = `aq-field-${index + 1}`;
  element.dataset.aqFieldId = id; // 在题目节点上写入稳定扫描标记
  return id;
}

/**
 * 排除网页导航、搜索和筛选区域，避免把普通网页搜索框误判成问卷题目。
 */
function isNavigationField(element: HTMLElement): boolean {
  const input = element instanceof HTMLInputElement ? element : null;
  const marker = `${element.id} ${element.className} ${input?.name ?? ''} ${input?.placeholder ?? ''}`.toLocaleLowerCase();
  const navigationAncestor = element.closest<HTMLElement>(
    'header, nav, [role="navigation"], [role="search"], .search-box, .template-search, [class*="search"], [class*="filter"]',
  );
  return Boolean(navigationAncestor || input?.type === 'search' || /搜索模板|搜索关键词|筛选条件/.test(marker));
}

/**
 * 收集原生控件和常见 ARIA 自定义控件，并过滤扩展不可填写的节点。
 */
function collectCandidates(documentRef: Document): ScanCandidate[] {
  const nodes = Array.from(documentRef.querySelectorAll<HTMLElement>(CONTROL_SELECTOR));
  const candidates: ScanCandidate[] = [];

  for (const element of nodes) {
    const role = element.getAttribute('role');
    const isNativeControl = /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName);
    const customParent = isNativeControl
      ? element.closest<HTMLElement>('[role="radio"], [role="checkbox"]')
      : null;

    if (customParent && customParent !== element) continue; // 自定义控件已有外层语义节点，避免重复扫描
    if (
      (role === 'textbox' || role === 'combobox') &&
      element.querySelector('input, textarea, select')
    ) continue; // 优先使用自定义容器内部的真实输入节点
    if (isNavigationField(element)) continue; // 页面导航控件不属于问卷字段
    if (isDisabledElement(element)) continue;

    const choiceType = getChoiceType(element);
    if (!isVisibleElement(element, documentRef)) continue;

    if (choiceType) {
      candidates.push({ element, kind: 'choice', choiceType });
      continue;
    }

    const fieldType = getFieldType(element);
    if (fieldType === 'select') {
      candidates.push({ element, kind: 'select' });
      continue;
    }
    if (fieldType === 'contenteditable') {
      candidates.push({ element, kind: 'contenteditable' });
      continue;
    }
    if (['text', 'textarea', 'number', 'email'].includes(fieldType) || role === 'textbox') {
      candidates.push({ element, kind: 'text' });
    }
  }

  return candidates;
}

/**
 * 创建字段定位信息，供 AI 理解字段来源和临时会话保存使用。
 */
function createLocator(fieldId: string, label: string, element: HTMLElement): QuestionnaireField['locator'] {
  const native = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
    ? element
    : getNativeChoice(element);

  return {
    fieldId,
    label,
    name: native?.name || element.getAttribute('name') || undefined,
    id: native?.id || element.id || undefined,
    tagName: element.tagName.toLowerCase(),
  };
}

/**
 * 构造单个文本、下拉框或可编辑区域字段。
 */
function buildSimpleField(
  candidate: ScanCandidate,
  fieldIndex: number,
  documentRef: Document,
): QuestionnaireField {
  const element = candidate.element;
  const container = getQuestionContainer(element);
  const type = getFieldType(element);
  const label = getQuestionLabel(element, container, documentRef) || `未命名字段 ${fieldIndex + 1}`;
  const runtimeOptions = type === 'select' ? getSelectOptions(element) : [];
  const description = runtimeOptions.length > 0
    ? `${label}；选项：${runtimeOptions.map((option) => option.label).join('、')}`
    : cleanText(`${label} ${getElementText(container)}`, 300);
  const fieldId = makeFieldId(element, fieldIndex);

  return {
    id: fieldId,
    label,
    description,
    type,
    required: isRequiredField(element, container),
    options: runtimeOptions.map((option) => option.label),
    currentValue: getCurrentValue(element),
    locator: createLocator(fieldId, label, element),
    element,
    runtimeOptions,
  };
}

/**
 * 构造一个题目级单选或多选字段，把多个选项归并到同一题目。
 */
function buildChoiceField(
  group: ChoiceGroup,
  fieldIndex: number,
  documentRef: Document,
): QuestionnaireField {
  const firstElement = group.candidates[0]?.element ?? group.container;
  const label = getQuestionLabel(firstElement, group.container, documentRef) || `未命名字段 ${fieldIndex + 1}`;
  const runtimeOptions: QuestionnaireOption[] = group.candidates
    .map((candidate) => ({
      label: getOptionLabel(candidate.element),
      value: getNativeChoice(candidate.element)?.value || candidate.element.getAttribute('data-value') || getOptionLabel(candidate.element),
      element: candidate.element,
    }))
    .filter((option, index, options) => option.label && options.findIndex((item) => normalizeText(item.label) === normalizeText(option.label)) === index);
  const selectedOptions = runtimeOptions.filter((option) => option.element && isChoiceSelected(option.element));
  const fieldId = makeFieldId(firstElement, fieldIndex); // 用首个选项节点避免同一题容器内不同控件 ID 冲突
  const description = cleanText(`${label}；选项：${runtimeOptions.map((option) => option.label).join('、')}`, 360);

  return {
    id: fieldId,
    label,
    description,
    type: group.choiceType,
    required: group.candidates.some((candidate) => isRequiredField(candidate.element, group.container)),
    options: runtimeOptions.map((option) => option.label),
    currentValue: selectedOptions.map((option) => option.label).join('、'),
    locator: createLocator(fieldId, label, firstElement),
    element: group.container,
    runtimeOptions,
  };
}

/**
 * 读取当前页面中的标准表单字段和自定义问卷控件。
 */
export function scanQuestionnaire(documentRef: Document): ScanResult {
  const candidates = collectCandidates(documentRef);
  const entries: FieldEntry[] = [];
  const groups = new Map<string, ChoiceGroup>();
  const containerKeys = new WeakMap<HTMLElement, number>();
  let nextContainerKey = 1;

  for (const [index, candidate] of candidates.entries()) {
    if (candidate.kind !== 'choice') {
      entries.push({ order: index, candidate });
      continue;
    }

    const container = getQuestionContainer(candidate.element);
    const containerKey = containerKeys.get(container) ?? nextContainerKey++;
    containerKeys.set(container, containerKey); // 用题目容器合并同一题的所有选项
    const nativeChoice = getNativeChoice(candidate.element);
    const choiceName = nativeChoice?.name || candidate.element.getAttribute('name') || '';
    const groupKey = choiceName
      ? `${candidate.choiceType}:name:${choiceName}`
      : `${candidate.choiceType}:container:${containerKey}`; // 优先使用 name 防止无 class 页面把多题合并
    let group = groups.get(groupKey);

    if (!group) {
      group = { container, choiceType: candidate.choiceType ?? 'single', candidates: [] };
      groups.set(groupKey, group);
      entries.push({ order: index, group });
    }
    group.candidates.push(candidate);
  }

  entries.sort((left, right) => left.order - right.order); // 按页面出现顺序交给 AI
  const fields = entries.map((entry, index) =>
    entry.group
      ? buildChoiceField(entry.group, index, documentRef)
      : buildSimpleField(entry.candidate as ScanCandidate, index, documentRef),
  );
  const formScore = calculateFormScore(documentRef, fields);

  return {
    pageTitle: documentRef.title || '未命名页面',
    url: documentRef.location?.href || '',
    formScore,
    pageContext: collectPageContext(documentRef),
    fields,
  };
}

/**
 * 收集页面可见文本，为 AI 识别复杂网页表单和字段关系提供上下文。
 */
function collectPageContext(documentRef: Document): string {
  const bodyText = documentRef.body?.innerText ?? '';
  const interactiveHints = collectInteractiveHints(documentRef); // 页面文字之外补充控件语义
  return [
    documentRef.title || '未命名页面',
    interactiveHints ? `交互控件线索：\n${interactiveHints}` : '', // 为复杂自定义控件补充页面文字中没有的语义信息
    '页面可见文本：',
    bodyText,
  ].join('\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 16000); // 限制页面上下文长度，避免复杂页面挤占答案输出空间
}

/**
 * 收集标准选择器遗漏的自定义控件可访问线索，交给 AI 辅助归纳复杂字段。
 */
function collectInteractiveHints(documentRef: Document): string {
  const selector = `${CONTROL_SELECTOR}, button`; // 同时覆盖标准控件和页面自定义按钮
  const nodes = Array.from(documentRef.querySelectorAll<HTMLElement>(selector))
    .filter((element) => isVisibleElement(element, documentRef))
    .slice(0, 120); // 限制线索数量，避免普通页面内容过度膨胀

  return nodes.map((element, index) => {
    const container = getQuestionContainer(element);
    const question = getQuestionLabel(element, container, documentRef);
    const input = element as HTMLInputElement;
    const metadata = [
      element.tagName.toLocaleLowerCase(),
      element.getAttribute('role'),
      input.type,
      input.name,
      element.getAttribute('aria-label'),
      input.placeholder,
      element.id,
    ].filter(Boolean).join(' ');
    const text = getElementText(element);
    const currentValue = element.getAttribute('aria-valuetext') || input.value || ''; // 提供自定义控件可能没有 innerText 的当前值
    return cleanText(`${index + 1}. ${metadata}；题目：${question}；内容：${text}；当前值：${currentValue}`, 260);
  }).filter(Boolean).join('\n');
}

/**
 * 根据表单数量、题目数量和页面操作文字计算疑似问卷得分。
 */
function calculateFormScore(documentRef: Document, fields: QuestionnaireField[]): number {
  const text = documentRef.body?.innerText ?? '';
  const actionWords = /(下一步|下一页|提交|完成|保存|问卷|调查|申请|报名|填写|表单|必填|请选择|questionnaire|survey|application|submit|next|required|please select)/i.test(text) ? 25 : 0; // 同时识别中英文复杂表单页面
  const structuralForm = documentRef.querySelector('form, [role="form"]') ? 20 : 0; // 语义表单即使没有标准控件也交给 AI 识别
  const requiredScore = Math.min(fields.filter((field) => field.required).length * 5, 25);
  const fieldScore = Math.min(fields.length * 4, 50);
  return Math.min(actionWords + structuralForm + requiredScore + fieldScore, 100);
}

/**
 * 将运行时字段序列化为可保存和发送给 AI 的字段。
 */
export function serializeFields(
  fields: QuestionnaireField[],
): Array<Omit<QuestionnaireField, 'element' | 'runtimeOptions'>> {
  return fields.map(({ element: _element, runtimeOptions: _runtimeOptions, ...field }) => field);
}

/**
 * 规范化答案文本，便于匹配选项和复选框。
 */
function normalizeAnswer(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'boolean') return [value ? 'true' : 'false'];
  if (value === null || value === undefined) return [];
  return [String(value).trim()].filter(Boolean);
}

/**
 * 判断 AI 答案是否对应某个问卷选项的文字或原始值。
 */
function optionMatches(answer: string, option: QuestionnaireOption): boolean {
  const normalizedAnswer = normalizeText(answer);
  const normalizedLabel = normalizeText(option.label);
  const normalizedValue = normalizeText(option.value);
  if (!normalizedAnswer || normalizedAnswer === 'true' || normalizedAnswer === 'false') return false;
  return (
    normalizedAnswer === normalizedLabel ||
    normalizedAnswer === normalizedValue ||
    (normalizedAnswer.includes(normalizedLabel) && normalizedLabel.length >= 2) ||
    (normalizedLabel.includes(normalizedAnswer) && normalizedAnswer.length >= 2)
  );
}

/**
 * 拆分模型可能用逗号或顿号连接的多选答案。
 */
function splitOptionAnswers(values: string[]): string[] {
  return values.flatMap((value) => value.split(/[,，、;；\n]+/)).map((value) => value.trim()).filter(Boolean);
}

/**
 * 找到 AI 答案对应的一个或多个选项。
 */
function findMatchingOptions(field: QuestionnaireField, values: string[]): QuestionnaireOption[] {
  const options = field.runtimeOptions ?? [];
  const answerValues = splitOptionAnswers(values);
  return options.filter((option) => answerValues.some((value) => optionMatches(value, option)));
}

/**
 * 设置原生或自定义单选、复选控件，并触发页面框架监听的事件。
 */
function setChoiceState(element: HTMLElement, checked: boolean, choiceType: 'single' | 'multiple'): void {
  const nativeChoice = getNativeChoice(element);
  if (nativeChoice) {
    if (choiceType === 'single' && !checked) return; // 原生单选由选中目标自动取消其他选项
    if (nativeChoice.checked !== checked) nativeChoice.click(); // 通过真实点击兼容 Vue、React 等框架
    if (nativeChoice.checked !== checked) {
      nativeChoice.checked = checked; // 某些自定义控件拦截 click 时回退到原生赋值
      nativeChoice.dispatchEvent(new Event('input', { bubbles: true })); // 通知输入状态变化
      nativeChoice.dispatchEvent(new Event('change', { bubbles: true })); // 通知题目状态变化
    }
    return;
  }

  if (isChoiceSelected(element) === checked) return;
  element.click(); // 自定义 ARIA 控件通常通过 click 处理内部状态
  element.setAttribute('aria-checked', String(checked)); // 保证无框架控件也有可见状态
  element.dispatchEvent(new Event('input', { bubbles: true })); // 通知自定义控件输入变化
  element.dispatchEvent(new Event('change', { bubbles: true })); // 通知自定义控件选择变化
}

/**
 * 将答案应用到题目级单选或多选字段。
 */
function applyChoiceAnswer(field: QuestionnaireField, values: string[]): boolean {
  const options = field.runtimeOptions ?? [];
  const matches = findMatchingOptions(field, values);
  const isBooleanTrue = values.includes('true');
  const isBooleanFalse = values.includes('false');
  if (options.length === 0) return false;

  if (matches.length === 0 && options.length === 1 && isBooleanTrue) {
    matches.push(options[0]); // 单独的同意复选框允许使用 true 答案
  }
  if (matches.length === 0 && options.length === 1 && isBooleanFalse && options[0].element) {
    setChoiceState(options[0].element, false, 'multiple'); // 单独的同意复选框允许使用 false 答案
    return true;
  }
  if (matches.length === 0) return false;

  const selectedMatches = field.type === 'single' ? matches.slice(0, 1) : matches;
  const matchedElements = new Set(selectedMatches.map((option) => option.element));
  for (const option of options) {
    if (!option.element) continue;
    const shouldCheck = matchedElements.has(option.element);
    setChoiceState(option.element, shouldCheck, field.type === 'single' ? 'single' : 'multiple');
  }
  return true;
}

/**
 * 打开并填写没有原生 select 的自定义下拉框。
 */
function applyCustomSelectAnswer(field: QuestionnaireField, values: string[]): boolean {
  const element = field.element;
  if (!element || element instanceof HTMLSelectElement) return false;

  let options = field.runtimeOptions ?? getSelectOptions(element);
  let matches = findMatchingOptions({ ...field, runtimeOptions: options }, values);
  if (matches.length === 0) {
    element.click(); // 部分组件只有展开后才把 role=option 插入页面
    options = getSelectOptions(element);
    matches = findMatchingOptions({ ...field, runtimeOptions: options }, values);
  }
  if (matches.length === 0) return false;

  for (const option of matches) {
    option.element?.click(); // 使用组件公开的选项节点触发内部状态更新
  }
  return true;
}

/**
 * 设置文本输入值并触发网页框架常用的输入事件。
 */
function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, value); // 使用原生 setter 兼容 React 和 Vue 控件
  element.dispatchEvent(new Event('input', { bubbles: true })); // 通知页面输入值变化
  element.dispatchEvent(new Event('change', { bubbles: true })); // 通知页面字段已变更
}

/**
 * 设置自定义文本框或 contenteditable 节点的值。
 */
function setCustomTextValue(element: HTMLElement, value: string): void {
  if (element.isContentEditable) {
    element.textContent = value; // 填写可编辑区域
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); // 触发编辑事件
    return;
  }

  element.textContent = value; // 兼容没有原生 value 属性的 ARIA 文本框
  element.dispatchEvent(new Event('input', { bubbles: true })); // 通知自定义文本框输入变化
  element.dispatchEvent(new Event('change', { bubbles: true })); // 通知自定义文本框字段已变更
}

/**
 * 将 AI 答案填写到页面控件，并返回需要人工补充的字段。
 */
export function applyAnswers(
  fields: QuestionnaireField[],
  answers: Record<string, unknown>,
): { filled: number; skipped: string[] } {
  let filled = 0;
  const skipped: string[] = [];

  for (const field of fields) {
    const element = field.element;
    const values = normalizeAnswer(answers[field.id]);
    if (!element || !element.isConnected || values.length === 0 || field.type === 'unknown') {
      if (field.required) skipped.push(field.label); // 必填题没有答案时明确提示人工补充
      continue;
    }

    if ((field.type === 'single' || field.type === 'multiple') && applyChoiceAnswer(field, values)) {
      filled += 1; // 一个题目只计数一次，避免选项数量造成误导
      continue;
    }

    if (field.type === 'single' || field.type === 'multiple') {
      skipped.push(field.label); // 选项不匹配时不强行选择，交给人工审核
      continue;
    }

    const answerText = values.join('、');
    if (field.type === 'select' && element instanceof HTMLSelectElement) {
      const options = field.runtimeOptions ?? getSelectOptions(element);
      const matches = findMatchingOptions({ ...field, runtimeOptions: options }, values);
      if (matches.length === 0) {
        skipped.push(field.label);
        continue;
      }
      if (element.multiple) {
        const matchedValues = new Set(matches.map((option) => option.value));
        Array.from(element.options).forEach((option) => {
          option.selected = matchedValues.has(option.value); // 设置多选下拉框的选项状态
        });
      } else {
        element.value = matches[0].value; // 设置原生下拉框值
      }
      element.dispatchEvent(new Event('input', { bubbles: true })); // 通知下拉框输入变化
      element.dispatchEvent(new Event('change', { bubbles: true })); // 触发下拉框变更
      filled += 1;
      continue;
    }

    if (field.type === 'select' && applyCustomSelectAnswer(field, values)) {
      filled += 1; // 自定义下拉框同样按题目计数
      continue;
    }

    if (field.type === 'select') {
      skipped.push(field.label); // 无法匹配的自定义下拉框保留给人工处理
      continue;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      setInputValue(element, answerText);
      filled += 1;
      continue;
    }

    if (element.isContentEditable || element.getAttribute('role') === 'textbox') {
      setCustomTextValue(element, answerText);
      filled += 1;
      continue;
    }

    skipped.push(field.label);
  }

  return { filled, skipped };
}
