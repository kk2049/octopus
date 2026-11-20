import { expect, it, vi } from 'vitest';
import type { DocMiniApp, DocumentPermission, RecordData, ViewportChangeEvent } from '@lark-opdev/block-docs-addon-api';
import { FeishuDocsHost } from './host';

const share = `ds_${'B'.repeat(43)}`;
const binding = { v: 2, share, title: '论文', owner: 'lht', device: 'laptop', provider: 'codex', doc: 'doc' };

function setup(editable = true, surface: 'inline' | 'modal' | 'float' = 'inline') {
  let recordChange!: (record: RecordData) => void;
  let viewport!: (event: ViewportChangeEvent) => void;
  const sdk = {
    getActiveDocumentRef: vi.fn(async () => ({ docToken: 'doc', docType: 'docx' })),
    getActiveBlock: vi.fn(async () => ({ id: 7 })),
    Record: {
      onRecordChange: vi.fn(async (fn) => { recordChange = fn; }), offRecordChange: vi.fn(async () => {}),
      getRecord: vi.fn(async (): Promise<RecordData> => ({})), setRecord: vi.fn(async (changes: Array<{ type: string; data: { value?: unknown } }>) => (changes[0].type === 'remove' ? {} : { octopusAgent: changes[0].data.value })),
    },
    Service: {
      Permission: { getDocumentPermission: vi.fn(async () => ({ editable }) as DocumentPermission), onDocumentPermissionChange: vi.fn(async () => {}), offDocumentPermissionChange: vi.fn(async () => {}) },
      User: { login: vi.fn(async () => 'code'), getUserInfo: vi.fn(async () => ({ nickName: ' 张三 ' }) as { nickName: unknown }) },
      FloatCard: { enterFloatCard: vi.fn(async () => {}) }, Hyperlink: { open: vi.fn(async () => {}) },
    },
    Env: { DarkMode: { getIsDarkMode: vi.fn(async () => true), onDarkModeChange: vi.fn(async () => {}), offDarkModeChange: vi.fn(async () => {}) } },
    Viewport: { onViewportChange: vi.fn(async (fn) => { viewport = fn; }), offViewportChange: vi.fn(async () => {}) },
    View: { Action: { openModal: vi.fn(async () => ({ source: 'user-action', data: null })) } },
    LifeCycle: { notifyAppReady: vi.fn(async () => {}) },
    Bridge: { updateHeight: vi.fn(async (_height?: number) => {}) },
  };
  const host = new FeishuDocsHost(surface, sdk as unknown as DocMiniApp);
  return { sdk, host, record: (r: RecordData) => recordChange(r), viewport: (ids: number[]) => viewport({ viewportBlockIds: ids }) };
}

it('subscribes before reading, so a collaborator change during start-up is not lost', async () => {
  const { sdk, host, record } = setup();
  let finish!: (v: RecordData) => void;
  sdk.Record.getRecord.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const changes: unknown[] = [];
  const init = host.initialize((s) => changes.push(s.binding));
  await vi.waitFor(() => expect(sdk.Record.getRecord).toHaveBeenCalled());
  record({ octopusAgent: binding });
  finish({ octopusAgent: binding });
  expect(await init).toMatchObject({ doc: 'doc', editable: true, dark: true, binding: { share, doc: 'doc' } });
  expect(changes[0]).toMatchObject({ share });
  await host.close();
});

it('writes only its own Record key, as insert, replace or remove', async () => {
  const { sdk, host } = setup();
  await host.initialize(vi.fn());
  const { v: _v, doc: _doc, ...fields } = binding;
  expect((await host.bind(fields)).binding).toMatchObject({ share, doc: 'doc' });
  expect(sdk.Record.setRecord).toHaveBeenLastCalledWith([{ type: 'insert', data: { path: ['octopusAgent'], value: { v: 2, ...fields, doc: 'doc' } } }]);
  sdk.Record.getRecord.mockResolvedValueOnce({ octopusAgent: binding, other: 1 });
  await host.bind(fields);
  expect(sdk.Record.setRecord).toHaveBeenLastCalledWith([expect.objectContaining({ type: 'replace' })]);
  sdk.Record.getRecord.mockResolvedValueOnce({ octopusAgent: binding });
  expect((await host.bind(null)).binding).toBeNull();
  expect(sdk.Record.setRecord).toHaveBeenLastCalledWith([{ type: 'remove', data: { path: ['octopusAgent'] } }]);
});

it('reads a document-share card from its own Record key, an unreadable one included', async () => {
  const { sdk, host, record } = setup();
  const anchor = `dsa_${'S'.repeat(43)}`;
  sdk.Record.getRecord.mockResolvedValueOnce({ octopusShare: { v: 1, anchor } });
  const seen: unknown[] = [];
  expect(await host.initialize((s) => seen.push(s.docShare))).toMatchObject({ docShare: { v: 1, anchor }, binding: null, board: null });
  record({ octopusShare: { v: 3, anchor } });
  expect(seen.at(-1)).toEqual({ invalid: 'version' });
  record({ octopusAgent: binding });
  expect(seen.at(-1)).toBeNull();
  await host.close();
});

it('refuses to change the card for a reader without edit permission', async () => {
  const { sdk, host } = setup(false);
  await host.initialize(vi.fn());
  await expect(host.bind(null)).rejects.toThrow('编辑权限');
  expect(sdk.Record.setRecord).not.toHaveBeenCalled();
});

it('reports whether the inline card is on screen, opens the large view, and unsubscribes on close', async () => {
  const { sdk, host, viewport } = setup();
  const seen: boolean[] = [];
  await host.initialize((s) => seen.push(s.visible));
  viewport([1, 2]); viewport([7]);
  expect(seen.slice(-2)).toEqual([false, true]);
  await host.expand('论文');
  expect(sdk.View.Action.openModal).toHaveBeenCalledWith({ key: 'view', title: '论文', width: 1040 });
  await host.close();
  expect(sdk.Record.offRecordChange).toHaveBeenCalled();
  expect(sdk.Service.Permission.offDocumentPermissionChange).toHaveBeenCalled();
  expect(sdk.Viewport.offViewportChange).toHaveBeenCalled();
  expect(sdk.Env.DarkMode.offDarkModeChange).toHaveBeenCalled();
});

it('asks nothing of a desktop host: the block keeps its height and the card fills it', async () => {
  const desktop = setup();
  await desktop.host.initialize(vi.fn());
  await desktop.host.fitHeight(394);
  expect(desktop.sdk.Bridge.updateHeight).not.toHaveBeenCalled();
});

it('asks a mobile host to fit the inline card to a height, and only the inline card; a refusal changes nothing', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Lark/7.30.0');
  const inline = setup();
  await inline.host.initialize(vi.fn());
  await inline.host.fitHeight(393.6);
  expect(inline.sdk.Bridge.updateHeight).toHaveBeenCalledWith(394);
  inline.sdk.Bridge.updateHeight.mockRejectedValueOnce(new Error('not supported'));
  await expect(inline.host.fitHeight(200)).resolves.toBeUndefined();
  inline.sdk.Bridge.updateHeight.mockImplementationOnce(() => { throw new Error('no bridge'); });
  await expect(inline.host.fitHeight(200)).resolves.toBeUndefined();
  await inline.host.fitHeight(Number.NaN);
  expect(inline.sdk.Bridge.updateHeight).toHaveBeenCalledTimes(3);
  await inline.host.close();
  await inline.host.fitHeight(300);
  expect(inline.sdk.Bridge.updateHeight).toHaveBeenCalledTimes(3);

  for (const surface of ['modal', 'float'] as const) {
    const other = setup(true, surface);
    await other.host.initialize(vi.fn());
    await other.host.fitHeight(300);
    expect(other.sdk.Bridge.updateHeight).not.toHaveBeenCalled();
  }
});

it('tells the reader\'s Feishu name, or nothing when the host will not say', async () => {
  const { sdk, host } = setup();
  expect(await host.readerName()).toBe('张三');
  sdk.Service.User.getUserInfo.mockRejectedValueOnce(new Error('no permission'));
  expect(await host.readerName()).toBe('');
  sdk.Service.User.getUserInfo.mockResolvedValueOnce({ nickName: 42 });
  expect(await host.readerName()).toBe('');
});
