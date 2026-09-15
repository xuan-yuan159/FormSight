<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ExternalLink, ScanSearch, Settings2, Sparkles, ToggleRight } from '@lucide/vue';
import { browser } from 'wxt/browser';
import { getSettings, saveSettings } from '../../src/shared/storage';
import type { UserSettings } from '../../src/shared/types';

const settings = ref<UserSettings | null>(null);
const activeTab = ref('');
const notice = ref('');

/**
 * 加载弹窗中的当前设置和活动标签页。
 */
async function loadPopup(): Promise<void> {
  try {
    settings.value = await getSettings();
    const tabs = await browser.tabs.query({ active: true, currentWindow: true }); // 读取当前活动标签页
    activeTab.value = tabs[0]?.title ?? '当前页面';
  } catch (error) {
    notice.value = error instanceof Error ? error.message : '读取扩展状态失败，请重新打开弹窗。';
  }
}

/**
 * 切换页面浮窗状态。
 */
async function toggleFloating(): Promise<void> {
  if (!settings.value) return;
  const nextValue = !settings.value.floatingEnabled;
  try {
    settings.value.floatingEnabled = nextValue;
    await saveSettings(settings.value); // 保存浮窗开关
    notice.value = nextValue ? '浮窗已开启，新页面会自动显示。' : '浮窗已关闭。';
  } catch (error) {
    settings.value.floatingEnabled = !nextValue; // 保存失败时恢复界面状态
    notice.value = error instanceof Error ? error.message : '保存浮窗设置失败。';
  }
}

/**
 * 打开完整配置页。
 */
async function openOptions(): Promise<void> {
  await browser.runtime.openOptionsPage(); // 打开扩展配置页
  window.close(); // 配置页打开后关闭弹窗
}

/**
 * 提示用户在当前页面打开浮窗操作。
 */
function showUsage(): void {
  notice.value = '请回到网页，点击右下角悬浮图标开始扫描。';
}

onMounted(loadPopup);
</script>

<template>
  <main class="popup-shell">
    <header class="popup-header">
      <div class="popup-brand">
        <span><Sparkles :size="17" /></span>
        <div>
          <strong>一问成卷</strong>
          <small>AI 问卷辅助填写</small>
        </div>
      </div>
      <button class="icon-button" type="button" title="设置" @click="openOptions">
        <Settings2 :size="16" />
      </button>
    </header>

    <section class="page-context">
      <span>当前页面</span>
      <strong>{{ activeTab || '正在读取...' }}</strong>
    </section>

    <section v-if="settings" class="control-list">
      <button class="control-row" type="button" @click="toggleFloating">
        <span class="control-icon"><ToggleRight :size="17" /></span>
        <span class="control-copy">
          <strong>页面浮窗</strong>
          <small>{{ settings.floatingEnabled ? '已开启' : '已关闭' }}</small>
        </span>
        <span class="switch" :class="{ active: settings.floatingEnabled }"><i></i></span>
      </button>

      <button class="control-row" type="button" @click="showUsage">
        <span class="control-icon"><ScanSearch :size="17" /></span>
        <span class="control-copy">
          <strong>开始识别</strong>
          <small>回到网页使用右下角浮窗</small>
        </span>
      </button>
    </section>

    <p v-if="notice" class="notice">{{ notice }}</p>

    <footer class="popup-footer">
      <button class="text-button" type="button" @click="openOptions">
        <ExternalLink :size="14" />
        打开完整设置
      </button>
    </footer>
  </main>
</template>

<style>
* {
  box-sizing: border-box;
}

body {
  width: 330px;
  margin: 0;
  background: #fff;
  color: #17212b;
  font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif;
}

button {
  font: inherit;
}

.popup-shell {
  min-height: 270px;
}

.popup-header,
.popup-brand,
.popup-footer,
.control-row,
.control-icon,
.icon-button,
.text-button {
  display: flex;
  align-items: center;
}

.popup-header {
  justify-content: space-between;
  padding: 15px 16px 13px;
  border-bottom: 1px solid #edf1f4;
}

.popup-brand {
  gap: 9px;
}

.popup-brand > span {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 7px;
  background: #e6f3f1;
  color: #0f766e;
}

.popup-brand strong,
.popup-brand small,
.control-copy strong,
.control-copy small,
.page-context span,
.page-context strong {
  display: block;
}

.popup-brand strong {
  font-size: 13px;
}

.popup-brand small,
.page-context span,
.control-copy small {
  margin-top: 3px;
  color: #7e8e98;
  font-size: 11px;
}

.icon-button {
  width: 28px;
  height: 28px;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #768791;
  cursor: pointer;
}

.icon-button:hover {
  background: #f1f5f7;
  color: #0f766e;
}

.page-context {
  padding: 13px 16px 10px;
}

.page-context strong {
  overflow: hidden;
  margin-top: 4px;
  color: #334650;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.control-list {
  padding: 0 10px;
}

.control-row {
  width: 100%;
  gap: 10px;
  padding: 11px 7px;
  border: 0;
  border-top: 1px solid #eef2f4;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.control-row:hover {
  background: #f8fbfa;
}

.control-icon {
  width: 29px;
  height: 29px;
  justify-content: center;
  border-radius: 7px;
  background: #f1f6f7;
  color: #0f766e;
}

.control-copy {
  min-width: 0;
  flex: 1;
}

.control-copy strong {
  color: #30414b;
  font-size: 12px;
}

.switch {
  display: flex;
  width: 30px;
  height: 18px;
  align-items: center;
  padding: 2px;
  border-radius: 10px;
  background: #d7e1e5;
  transition: background 0.15s ease;
}

.switch i {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgb(0 0 0 / 15%);
  transition: transform 0.15s ease;
}

.switch.active {
  background: #0f766e;
}

.switch.active i {
  transform: translateX(12px);
}

.notice {
  margin: 9px 16px 0;
  padding: 8px 9px;
  border-radius: 6px;
  background: #f1faf8;
  color: #0f766e;
  font-size: 11px;
  line-height: 1.4;
}

.popup-footer {
  justify-content: flex-end;
  padding: 12px 16px 15px;
}

.text-button {
  gap: 5px;
  border: 0;
  background: transparent;
  color: #0f766e;
  cursor: pointer;
  font-size: 11px;
}
</style>
