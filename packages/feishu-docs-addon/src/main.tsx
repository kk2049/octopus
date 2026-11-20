import { createRoot } from 'react-dom/client';
import { AgentCard } from './Card';
import { FeishuDocsHost, type Surface } from './host';
import { BridgeApi } from './api';
import './style.css';
declare const __FIXTURE__: boolean;

/** Each Feishu view has its own HTML entry: index (inline card), modal (large view), float (side card). */
const surface = (document.body.dataset.surface ?? 'inline') as Surface;

async function main() {
  const root = createRoot(document.getElementById('root')!);
  try {
    if (__FIXTURE__) {
      const { createFixture } = await import('./preview-fixture');
      root.render(<AgentCard {...createFixture(surface)} preview/>);
    } else {
      const host = new FeishuDocsHost(surface);
      root.render(<AgentCard host={host} api={new BridgeApi(import.meta.env.VITE_OCTOPUS_DOCS_API, () => host.loginCode())}/>);
    }
  } catch (error) { root.render(<p role="alert" style={{ padding: 16 }}>{error instanceof Error ? error.message : '卡片初始化失败'}</p>); }
}
void main();
