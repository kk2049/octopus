import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Store } from './store.js';
import { migrateFixtureTo } from './migration-test-helpers.js';

describe('discussion migration', () => {
  it('upgrades v71 transactionally and retains users and durable group intent across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'discussion-migration-')), file = join(dir, 'db');
    try {
      const old = new Database(file); migrateFixtureTo(old, 71);
      old.prepare('INSERT INTO users(username, uid, home_dir, created_at) VALUES (?,?,?,?)').run('lht', 1001, '/x', 'before'); old.close();
      let store = new Store(file);
      expect(store.getUser('lht')?.created_at).toBe('before'); store.close();
      const db = new Database(file);
      db.prepare('INSERT INTO discussions(id,owner,request_id,status,updated_at,record) VALUES (?,?,?,?,?,?)').run('meeting-1', 'lht', 'request', 'creating', 'now', JSON.stringify({ id: 'meeting-1', status: 'creating' }));
      expect(() => db.prepare('INSERT INTO discussions(id,owner,request_id,status,updated_at,record) VALUES (?,?,?,?,?,?)').run('meeting-2', 'lht', 'request', 'creating', 'now', '{}')).toThrow('UNIQUE');
      expect(() => db.prepare("INSERT INTO discussion_outbox(id,discussion_id,text,status) VALUES ('out','meeting-1','text','invented')").run()).toThrow('CHECK');
      expect(db.prepare('SELECT 1 AS n FROM schema_version WHERE version = 72').get()).toEqual({ n: 1 }); db.close();
      store = new Store(file); expect(store.discussions.byRequest('lht', 'request')?.id).toBe('meeting-1'); store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
