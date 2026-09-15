import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: '一问成卷',
    short_name: 'FormSight',
    icons: {
      16: 'icons/icon-16.png', // 浏览器菜单使用小尺寸扩展图标
      32: 'icons/icon-32.png', // 浏览器工具栏使用中小尺寸扩展图标
      48: 'icons/icon-48.png', // 扩展管理页使用标准尺寸图标
      128: 'icons/icon-128.png', // 安装页和商店展示使用大尺寸图标
      256: 'icons/icon-256.png', // 保留高清品牌图标资源
    },
    description: '使用 AI 辅助识别和填写网页问卷，最终由用户人工审核。', // 扩展描述
    version: '0.1.1', // 扩展版本
    permissions: ['storage', 'tabs'], // 扩展基础权限
    host_permissions: ['http://*/*', 'https://*/*'], // 支持网页浮窗和 AI API 请求
    web_accessible_resources: [
      {
        resources: ['icons/icon-48.png'], // 允许网页加载浮窗使用的品牌图标
        matches: ['http://*/*', 'https://*/*'], // 仅对普通网页开放品牌图标资源
      },
    ],
    action: {
      default_title: '一问成卷 · FormSight', // 工具栏按钮提示
      default_popup: 'popup.html', // 工具栏弹窗页面
      default_icon: {
        16: 'icons/icon-16.png', // 工具栏小尺寸图标
        32: 'icons/icon-32.png', // 工具栏标准图标
        48: 'icons/icon-48.png', // 高 DPI 工具栏图标
      },
    },
  },
});
