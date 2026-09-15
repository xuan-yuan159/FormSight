import { createApp } from 'vue';
import { createShadowRootUi } from '#imports';
import FloatingPanel from '../src/ui/FloatingPanel.vue';
import { getSettings } from '../src/shared/storage';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'], // 在普通 HTTP 和 HTTPS 页面中注入浮窗
  runAt: 'document_idle', // 等待页面主要内容加载后再运行
  cssInjectionMode: 'ui', // 将浮窗样式注入 Shadow DOM
  /**
   * 初始化当前网页的问卷浮窗。
   */
  async main(ctx) {
    const settings = await getSettings();
    if (!settings.floatingEnabled || !settings.scanAllPages) return;

    const ui = await createShadowRootUi(ctx, {
      name: 'auto-questionnaire-ui',
      position: 'inline',
      anchor: 'body',
      /**
       * 创建 Vue 浮窗实例。
       */
      onMount: (container) => {
        const app = createApp(FloatingPanel);
        app.mount(container);
        return app;
      },
      /**
       * 卸载 Vue 浮窗实例。
       */
      onRemove: (app) => {
        app?.unmount();
      },
    });

    ui.mount(); // 页面中只挂载一个浮窗实例
  },
});
