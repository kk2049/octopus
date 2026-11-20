import { describe, expect, it } from 'vitest';
import { spoken } from './message';

describe('spoken', () => {
  it('names a speaker and leaves out the lines written for the agent', () => {
    expect(spoken('【发言人：李雷，经 lht 授权】\n补一组 4-bit 的结果\n\n（这条消息是从飞书云文档《周报》里的 Agent 卡片发来的，document_id：Abc123；消息里说的“这个文档”就是它。）'))
      .toEqual({ speaker: '李雷', body: '补一组 4-bit 的结果' });
  });

  it('leaves an ordinary message, and the owner\'s own card message, as their words', () => {
    expect(spoken('继续')).toEqual({ body: '继续' });
    expect(spoken('改短一点\n\n（这条消息是从飞书云文档《周报》里的 Agent 卡片发来的；消息里说的“这个文档”就是它。）')).toEqual({ body: '改短一点' });
    // A bracket someone typed is not a speaker line.
    expect(spoken('【发言人：我】随便写的')).toEqual({ body: '【发言人：我】随便写的' });
  });
});
