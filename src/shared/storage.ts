import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, SESSION_KEY, SETTINGS_KEY } from './constants';
import type { QuestionnaireSession, UserSettings } from './types';

/**
 * 合并用户配置和默认配置，避免旧版本缺少新字段。
 */
function mergeSettings(value?: Partial<UserSettings>): UserSettings {
  const candidateMode = value?.inquiryMode;
  const inquiryMode = typeof candidateMode === 'string' && ['casual', 'normal', 'serious'].includes(candidateMode)
    ? candidateMode
    : DEFAULT_SETTINGS.inquiryMode;

  return {
    ...DEFAULT_SETTINGS,
    ...value,
    inquiryMode, // 修复旧版本或手动修改存储造成的非法模式
    floatingEnabled: typeof value?.floatingEnabled === 'boolean' ? value.floatingEnabled : DEFAULT_SETTINGS.floatingEnabled, // 统一浮窗开关类型
    scanAllPages: typeof value?.scanAllPages === 'boolean' ? value.scanAllPages : DEFAULT_SETTINGS.scanAllPages, // 统一扫描开关类型
    ai: {
      ...DEFAULT_SETTINGS.ai,
      ...(value?.ai ?? {}),
    },
  };
}

/**
 * 读取扩展设置。
 */
export async function getSettings(): Promise<UserSettings> {
  const result = await browser.storage.local.get(SETTINGS_KEY); // 从浏览器本地存储读取配置
  return mergeSettings(result[SETTINGS_KEY] as Partial<UserSettings> | undefined);
}

/**
 * 保存扩展设置。
 */
export async function saveSettings(settings: UserSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings }); // 保存用户配置到本地
}

/**
 * 保存当前问卷临时会话。
 */
export async function saveSession(session: QuestionnaireSession): Promise<void> {
  await browser.storage.local.set({ [SESSION_KEY]: session }); // 使用本地存储模拟临时工作区
}

/**
 * 读取当前问卷临时会话。
 */
export async function getSession(): Promise<QuestionnaireSession | null> {
  const result = await browser.storage.local.get(SESSION_KEY); // 读取临时问卷会话
  return (result[SESSION_KEY] as QuestionnaireSession | undefined) ?? null;
}

/**
 * 清除当前问卷临时会话。
 */
export async function clearSession(): Promise<void> {
  await browser.storage.local.remove(SESSION_KEY); // 清除临时问卷数据
}
