import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'Auto Questionnaire',
    short_name: 'Auto Questionnaire',
    description: '使用 AI 辅助识别和填写网页问卷，最终由用户人工审核。', // 扩展描述
    version: '0.1.0', // 扩展版本
    permissions: ['storage', 'tabs'], // 扩展基础权限
    host_permissions: ['http://*/*', 'https://*/*'], // 支持网页浮窗和 AI API 请求
    action: {
      default_title: 'Auto Questionnaire', // 工具栏按钮提示
      default_popup: 'popup.html', // 工具栏弹窗页面
    },
  },
});
