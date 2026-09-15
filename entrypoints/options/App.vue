<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { Check, KeyRound, Save, Send, ShieldCheck, Sparkles, Trash2 } from '@lucide/vue';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, INQUIRY_MODE_DESCRIPTIONS, INQUIRY_MODE_LABELS } from '../../src/shared/constants';
import { normalizeAIConfig } from '../../src/shared/prompts';
import { getSettings, saveSettings } from '../../src/shared/storage';
import type { AIConnectionTestResponse, InquiryMode, UserSettings } from '../../src/shared/types';

const settings = reactive<UserSettings>(structuredClone(DEFAULT_SETTINGS));
const statusMessage = ref('');
const statusType = ref<'idle' | 'success' | 'error'>('idle');
const testing = ref(false);
const saved = ref(false);

const modeOptions: InquiryMode[] = ['casual', 'normal', 'serious']; // 设置页只保留三种询问模式

/**
 * 加载本地扩展配置。
 */
async function loadSettings(): Promise<void> {
  try {
    const current = await getSettings();
    Object.assign(settings, current); // 将本地配置同步到表单
    Object.assign(settings.ai, current.ai); // 同步 AI 配置对象
  } catch (error) {
    statusType.value = 'error';
    statusMessage.value = error instanceof Error ? error.message : '读取配置失败，请重新加载扩展。';
  }
}

/**
 * 保存扩展配置。
 */
async function save(): Promise<void> {
  try {
    await saveSettings(settings); // 保存 AI 和浮窗配置
    saved.value = true;
    statusType.value = 'success';
    statusMessage.value = '配置已保存。';
    window.setTimeout(() => {
      saved.value = false;
    }, 1600);
  } catch (error) {
    statusType.value = 'error';
    statusMessage.value = error instanceof Error ? error.message : '保存配置失败，请重试。';
  }
}

/**
 * 测试当前 AI 配置是否可以正常请求。
 */
async function testConnection(): Promise<void> {
  testing.value = true;
  statusType.value = 'idle';
  statusMessage.value = '正在连接 AI 服务...';
  try {
    const config = normalizeAIConfig(settings.ai); // 测试前统一清理地址、Key 和数值配置
    if (!config.baseURL || !config.model || !config.apiKey) {
      throw new Error('请先填写 Base URL、Model 和 API Key。');
    }
    const response = (await browser.runtime.sendMessage({
      type: 'AQ_AI_TEST_REQUEST',
      config,
    })) as AIConnectionTestResponse;
    if (!response || typeof response.ok !== 'boolean') {
      throw new Error('后台未返回连接测试结果，请重新加载扩展后再试。');
    }
    statusType.value = response.ok ? 'success' : 'error';
    statusMessage.value = response.message || (response.ok ? '连接成功。' : '连接失败。'); // 防止后台返回空消息导致界面无提示
  } catch (error) {
    statusType.value = 'error';
    statusMessage.value = error instanceof Error ? error.message : '连接测试失败。';
  } finally {
    testing.value = false;
  }
}

/**
 * 清除当前配置中的 API Key。
 */
function clearApiKey(): void {
  settings.ai.apiKey = '';
  statusType.value = 'idle';
  statusMessage.value = 'API Key 已清空，保存后生效。';
}

onMounted(loadSettings);
</script>

<template>
  <main class="options-page">
    <header class="page-header">
      <div class="page-title">
        <span class="title-icon"><Sparkles :size="21" /></span>
        <div>
          <h1>一问成卷 <span>FormSight</span></h1>
          <p>Edge 浏览器问卷辅助填写工具</p>
        </div>
      </div>
      <div class="header-badge"><ShieldCheck :size="15" /> 人工确认提交</div>
    </header>

    <div class="page-layout">
      <section class="settings-section">
        <div class="section-heading">
          <div>
            <h2>AI 服务配置</h2>
            <p>扩展直接调用你配置的 OpenAI 兼容接口，不经过项目后端。</p>
          </div>
          <KeyRound :size="19" />
        </div>

        <div class="form-grid">
          <label class="form-field full-width">
            <span>Base URL</span>
            <input v-model="settings.ai.baseURL" type="url" placeholder="https://api.example.com/v1" />
            <small>通常填写到 v1，扩展会自动拼接 /chat/completions。</small>
          </label>

          <label class="form-field">
            <span>Model</span>
            <input v-model="settings.ai.model" type="text" placeholder="deepseek-chat" />
          </label>

          <label class="form-field">
            <span>API Key</span>
            <input v-model="settings.ai.apiKey" type="password" placeholder="输入你的 API Key" autocomplete="off" />
          </label>

          <label class="form-field">
            <span>Temperature</span>
            <input v-model.number="settings.ai.temperature" type="number" min="0" max="1" step="0.1" />
          </label>

          <label class="form-field">
            <span>最大输出 Token</span>
            <input v-model.number="settings.ai.maxTokens" type="number" min="1000" max="32000" step="500" />
          </label>
        </div>

        <div class="action-row">
          <button class="secondary-button" type="button" :disabled="testing" @click="testConnection">
            <Send :size="15" />
            {{ testing ? '测试中...' : '测试连接' }}
          </button>
          <button class="secondary-button danger-button" type="button" @click="clearApiKey">
            <Trash2 :size="15" />
            清除 Key
          </button>
        </div>
      </section>

      <section class="settings-section">
        <div class="section-heading">
          <div>
            <h2>问答和浮窗</h2>
            <p>控制 AI 对话确认程度；未提到的内容会自动合理补全。</p>
          </div>
        </div>

        <label class="form-field">
          <span>默认询问模式</span>
          <select v-model="settings.inquiryMode">
            <option v-for="mode in modeOptions" :key="mode" :value="mode">
              {{ INQUIRY_MODE_LABELS[mode] }}
            </option>
          </select>
          <small>{{ INQUIRY_MODE_DESCRIPTIONS[settings.inquiryMode] }}</small>
        </label>

        <div class="toggle-list">
          <label class="toggle-row">
            <span>
              <strong>显示页面浮窗</strong>
              <small>在普通网页右下角显示启动图标。</small>
            </span>
            <input v-model="settings.floatingEnabled" type="checkbox" />
            <i></i>
          </label>
          <label class="toggle-row">
            <span>
              <strong>扫描所有普通网页</strong>
              <small>浏览器内部页面和扩展页面不会被注入。</small>
            </span>
            <input v-model="settings.scanAllPages" type="checkbox" />
            <i></i>
          </label>
        </div>
      </section>

      <section class="privacy-note">
        <ShieldCheck :size="17" />
        <div>
          <strong>数据提示</strong>
          <p>没有项目后端，但问卷字段和用户回答会发送到你配置的 AI 服务商。API Key 保存在当前浏览器扩展本地，请使用低权限 Key，并在填写前人工检查敏感信息。</p>
        </div>
      </section>
    </div>

    <footer class="page-footer">
      <span :class="`status-${statusType}`">{{ statusMessage }}</span>
      <button class="save-button" type="button" @click="save">
        <Check v-if="saved" :size="16" />
        <Save v-else :size="16" />
        {{ saved ? '已保存' : '保存配置' }}
      </button>
    </footer>
  </main>
</template>

<style>
* {
  box-sizing: border-box;
}

body {
  min-width: 720px;
  margin: 0;
  background: #f4f7f8;
  color: #17212b;
  font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif;
}

button,
input,
select {
  font: inherit;
}

.options-page {
  min-height: 100vh;
}

.page-header {
  display: flex;
  max-width: 980px;
  align-items: center;
  justify-content: space-between;
  margin: 0 auto;
  padding: 34px 36px 26px;
}

.page-title,
.section-heading,
.header-badge,
.action-row,
.privacy-note,
.privacy-note > div,
.page-footer,
.save-button,
.secondary-button {
  display: flex;
  align-items: center;
}

.page-title {
  gap: 12px;
}

.title-icon {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: 9px;
  background: #dff1ee;
  color: #0f766e;
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  color: #20303a;
  font-size: 21px;
  letter-spacing: 0;
}

.page-title p,
.section-heading p {
  margin-top: 4px;
  color: #788994;
  font-size: 12px;
}

.header-badge {
  gap: 6px;
  padding: 7px 10px;
  border: 1px solid #cfe3e0;
  border-radius: 6px;
  background: #f1faf8;
  color: #0f766e;
  font-size: 11px;
}

.page-layout {
  display: grid;
  max-width: 980px;
  grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.8fr);
  gap: 16px;
  margin: 0 auto;
  padding: 0 36px 30px;
}

.settings-section,
.privacy-note {
  border: 1px solid #dfe8ec;
  border-radius: 8px;
  background: #fff;
}

.settings-section {
  padding: 20px;
}

.section-heading {
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 17px;
}

.section-heading h2 {
  color: #30414b;
  font-size: 15px;
}

.section-heading > svg {
  color: #0f766e;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 13px;
}

.form-field {
  display: grid;
  gap: 5px;
  color: #465761;
  font-size: 12px;
  font-weight: 600;
}

.form-field.full-width {
  grid-column: 1 / -1;
}

.form-field input,
.form-field select {
  width: 100%;
  height: 35px;
  padding: 0 10px;
  border: 1px solid #d9e4e8;
  border-radius: 6px;
  outline: none;
  background: #fff;
  color: #243640;
  font-size: 12px;
}

.form-field input:focus,
.form-field select:focus {
  border-color: #2b9c91;
  box-shadow: 0 0 0 2px rgb(43 156 145 / 12%);
}

.form-field small,
.toggle-row small {
  color: #8a99a2;
  font-size: 10px;
  font-weight: 400;
  line-height: 1.4;
}

.action-row {
  gap: 8px;
  margin-top: 16px;
}

.secondary-button,
.save-button {
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid #cfe3e0;
  border-radius: 6px;
  background: #f1faf8;
  color: #0f766e;
  cursor: pointer;
  font-size: 12px;
}

.secondary-button:hover,
.save-button:hover {
  background: #e5f3f0;
}

.danger-button {
  border-color: #ead7d2;
  background: #fff8f7;
  color: #a5483f;
}

.toggle-list {
  display: grid;
  gap: 2px;
  margin-top: 18px;
}

.toggle-row {
  position: relative;
  display: flex;
  min-height: 55px;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 9px 0;
  border-top: 1px solid #edf1f3;
  cursor: pointer;
}

.toggle-row span {
  display: grid;
  gap: 3px;
}

.toggle-row strong {
  color: #40515b;
  font-size: 12px;
}

.toggle-row input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.toggle-row i {
  display: flex;
  width: 34px;
  height: 20px;
  flex: 0 0 auto;
  align-items: center;
  padding: 2px;
  border-radius: 10px;
  background: #d7e1e5;
  transition: background 0.15s ease;
}

.toggle-row i::after {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgb(0 0 0 / 15%);
  content: "";
  transition: transform 0.15s ease;
}

.toggle-row input:checked + i {
  background: #0f766e;
}

.toggle-row input:checked + i::after {
  transform: translateX(14px);
}

.privacy-note {
  grid-column: 1 / -1;
  gap: 10px;
  padding: 14px 16px;
  background: #fbfcfd;
  color: #73838d;
}

.privacy-note > svg {
  flex: 0 0 auto;
  color: #0f766e;
}

.privacy-note > div {
  align-items: flex-start;
  flex-direction: column;
  gap: 3px;
}

.privacy-note strong {
  color: #52636e;
  font-size: 12px;
}

.privacy-note p {
  font-size: 11px;
  line-height: 1.5;
}

.page-footer {
  max-width: 980px;
  justify-content: space-between;
  margin: 0 auto;
  padding: 0 36px 32px;
}

.page-footer > span {
  font-size: 12px;
}

.status-idle {
  color: #7e8e98;
}

.status-success {
  color: #0f766e;
}

.status-error {
  color: #b42318;
}

.save-button {
  min-width: 110px;
  border-color: #0f766e;
  background: #0f766e;
  color: #fff;
}

.save-button:hover {
  background: #115e59;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

@media (max-width: 760px) {
  body {
    min-width: 0;
  }

  .page-header,
  .page-footer {
    padding-right: 20px;
    padding-left: 20px;
  }

  .page-layout {
    grid-template-columns: 1fr;
    padding-right: 20px;
    padding-left: 20px;
  }
}
</style>
