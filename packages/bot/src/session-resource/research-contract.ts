/** Reviewed first-party profile. Generic declared Apps retain their empty contract. */
import { contractDigestOf } from '@claude-bot/engine';
import type { SubjectCatalogEntry } from '../permissions/catalog.js';
import { sessionResourceCatalogFor } from './catalog.js';

export const RESEARCH_SESSION_PROFILE = Object.freeze({
  app: 'research-program', publisher: 'octopus:first-party',
  operations: ['read_session', 'append_session', 'upload_session_file'],
  autoAllow: ['read_session', 'append_session', 'upload_session_file'],
});
export const RESEARCH_SESSION_CONTRACT = Object.freeze({ ...RESEARCH_SESSION_PROFILE, actions: {}, agents: {}, delivery: [] });
export const RESEARCH_SESSION_CONTRACT_DIGEST = contractDigestOf(RESEARCH_SESSION_CONTRACT);
export const RESEARCH_SESSION_PROFILE_ID = 'research-sessions/v1';

export function isResearchSessionContract(app: string, publisher: string, digest: string): boolean {
  return app === RESEARCH_SESSION_PROFILE.app && publisher === RESEARCH_SESSION_PROFILE.publisher && digest === RESEARCH_SESSION_CONTRACT_DIGEST;
}

export const RESEARCH_SESSION_SUBJECT: SubjectCatalogEntry = {
  info: { type: 'app', id: RESEARCH_SESSION_PROFILE.app, publisher: RESEARCH_SESSION_PROFILE.publisher, title: '自动科研项目台',
    description: '浏览、继续和上传文件到项目中明确绑定的本人 Runner 会话。实时内容仅对当前授权用户可见。', enforced: true },
  catalog: sessionResourceCatalogFor({ ...RESEARCH_SESSION_PROFILE, deliveries: [] }),
  declared: () => RESEARCH_SESSION_PROFILE.operations,
  userManaged: true,
  grantIdentity: { publisher: RESEARCH_SESSION_PROFILE.publisher, contractDigest: RESEARCH_SESSION_CONTRACT_DIGEST },
};
