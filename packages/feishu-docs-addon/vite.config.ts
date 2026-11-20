import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const entry = (name: string) => fileURLToPath(new URL(`./${name}.html`, import.meta.url));

/** The official offline-web descriptors (the same two files @lark-opdev/block-docs-addon-webpack-utils emits). */
function nativeManifest(): Plugin {
  return {
    name: 'feishu-docs-offline-web', apply: 'build',
    generateBundle() {
      const appid = process.env.FEISHU_APP_ID;
      const blockTypeID = process.env.FEISHU_BLOCK_TYPE_ID;
      const origin = process.env.VITE_OCTOPUS_DOCS_API;
      if (!appid?.match(/^cli_[a-zA-Z0-9]+$/) || !blockTypeID?.match(/^blk_[a-zA-Z0-9]+$/)) {
        throw new Error('Set the actual FEISHU_APP_ID and FEISHU_BLOCK_TYPE_ID before packaging');
      }
      if (!origin || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin) {
        throw new Error('VITE_OCTOPUS_DOCS_API must be the configured HTTPS origin');
      }
      const configs = {
        'project.config.json': { appid, projectname: 'Octopus Agent', blocks: ['index'] },
        'index.json': {
          blockTypeID, blockRenderType: 'offlineWeb',
          offlineWebConfig: {
            initialHeight: 560,
            contributes: {
              // Inline card: the reader resizes its height; its layout fills whatever height it gets.
              addPanel: { view: 'index.html', initialHeight: 560, useHostLoading: true, resizeType: 'vertical' },
              // Large reading view, opened with View.Action.openModal({ key: 'view', width }).
              modal: { view: 'modal.html', initialHeight: 760 },
              // Side card that stays open while the document scrolls; Feishu fixes its width (~320px).
              floatCard: { view: 'float.html', initialHeight: 720 },
            },
          },
        },
      };
      for (const [fileName, value] of Object.entries(configs)) {
        this.emitFile({ type: 'asset', fileName, source: JSON.stringify(value, null, 2) });
      }
    },
  };
}

export default defineConfig(({ mode, command }) => {
  if (command === 'build' && mode === 'fixture') throw new Error('Fixture data cannot be packaged');
  return {
    plugins: [react(), ...(mode === 'native' ? [nativeManifest()] : [])],
    base: './',
    define: { __FIXTURE__: JSON.stringify(mode === 'fixture') },
    server: { host: '127.0.0.1', port: 5187, strictPort: true },
    // PDF.js runs in a module worker; it is a separate chunk loaded only when a PDF is opened.
    worker: { format: 'es' },
    build: { target: 'es2022', rollupOptions: { input: { index: entry('index'), modal: entry('modal'), float: entry('float') } } },
  };
});
