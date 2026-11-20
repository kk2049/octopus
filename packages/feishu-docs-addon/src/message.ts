/**
 * A message sent from a card, as people read it. The bridge adds two lines
 * for the agent: who is speaking, when it is not the agent's owner, and which
 * document the card sits in. The card shows the speaker's name above the
 * message and leaves both lines out; the agent's transcript keeps them.
 */
const SPEAKER = /^【发言人：([^，】\n]{1,60})，经 [^】\n]{1,60} 授权】\n/;
const FROM_CARD = /\n\n（这条消息是从飞书云文档[^\n]*?里的 Agent 卡片发来的[^\n]*?）\s*$/;

export function spoken(text: string): { speaker?: string; body: string } {
  const head = SPEAKER.exec(text);
  const body = (head ? text.slice(head[0].length) : text).replace(FROM_CARD, '');
  return { ...(head ? { speaker: head[1] } : {}), body };
}
