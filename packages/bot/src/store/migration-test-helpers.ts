import type Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

/** Build the same historical schema that Store.runMigrations produced. */
export function migrateFixtureTo(db: Database.Database, targetVersion: number): void {
  const migrations = MIGRATIONS.filter((migration) => migration.version <= targetVersion);
  if (migrations.at(-1)?.version !== targetVersion) {
    throw new Error(`unknown migration target v${targetVersion}`);
  }

  db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
  const recordVersion = db.prepare("INSERT INTO schema_version(version) VALUES (?)");
  for (const migration of migrations) {
    db.transaction(() => {
      db.exec(migration.sql);
      recordVersion.run(migration.version);
    })();
  }
}
