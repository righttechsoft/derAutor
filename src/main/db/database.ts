import { DatabaseSync } from 'node:sqlite'

let db: DatabaseSync | null = null
let txDepth = 0

const MIGRATIONS: string[] = [
  // 0001_init
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    language TEXT NOT NULL,
    target_words INTEGER NOT NULL,
    illustrations INTEGER NOT NULL DEFAULT 0,
    genre_hint TEXT NOT NULL DEFAULT '',
    world_input TEXT NOT NULL,
    premise_input TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'clarify',
    status TEXT NOT NULL DEFAULT 'idle',
    chapter_count INTEGER,
    review_round INTEGER NOT NULL DEFAULT 0,
    authors_room_unlocked INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    chapter INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    is_current INTEGER NOT NULL DEFAULT 1,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, kind, chapter, version)
  );
  CREATE INDEX idx_artifacts_lookup ON artifacts(project_id, kind, chapter, is_current);

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    input_hash TEXT NOT NULL,
    result_artifact_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    UNIQUE(project_id, step_key)
  );
  CREATE INDEX idx_jobs_status ON jobs(project_id, status);

  CREATE TABLE llm_calls (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    job_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_llm_calls_project ON llm_calls(project_id);

  CREATE TABLE clarify_messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE review_issues (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    chapter INTEGER,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    fix_instruction TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
  );

  CREATE TABLE images (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    chapter INTEGER,
    prompt TEXT NOT NULL,
    jpeg BLOB,
    width INTEGER,
    height INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    UNIQUE(project_id, kind, chapter)
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 0002_source_project — world reuse: which finished project this book's world
  // continues. Plain TEXT on purpose: no FK (a CASCADE would delete the sequel
  // with its source), and a dangling id is harmless because the world_seed
  // artifact is a full copy of everything the pipeline needs.
  `ALTER TABLE projects ADD COLUMN source_project_id TEXT;`,
  // 0003_guided — guided (co-writing) mode: the pipeline stops after each step for
  // the author to approve/regenerate/edit/refine. pending_step names the step
  // currently awaiting a decision. guided_messages holds the per-step refine chat.
  `
  ALTER TABLE projects ADD COLUMN guided INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE projects ADD COLUMN pending_step TEXT;

  CREATE TABLE guided_messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_guided_messages_step ON guided_messages(project_id, step_key);
  `,
  // 0004_style — free-text authorial style directive (voice, register, hard prose
  // constraints), folded into the style guide that drives all prose.
  `ALTER TABLE projects ADD COLUMN style_input TEXT NOT NULL DEFAULT '';`,
  // 0005_edit_variants — named clones of a finished book for post-finish editing;
  // the original stays frozen, edits target the clone. edit_copy disambiguates
  // from translations/sequels, which also set source_project_id.
  `
  ALTER TABLE projects ADD COLUMN edit_copy INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE projects ADD COLUMN edit_label TEXT;
  `
]

function migrate(database: DatabaseSync): void {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    database.exec('BEGIN')
    try {
      database.exec(MIGRATIONS[v])
      database.exec(`PRAGMA user_version = ${v + 1}`)
      database.exec('COMMIT')
    } catch (err) {
      database.exec('ROLLBACK')
      throw err
    }
  }
}

/** Electron-free by design so repos are unit-testable; the caller supplies the path. */
export function initDatabase(dbPath: string): DatabaseSync {
  if (db) return db
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function closeDatabase(): void {
  db?.close()
  db = null
}

/** Re-entrant transaction wrapper: only the outermost call opens/commits. */
export function inTransaction<T>(fn: () => T): T {
  const d = getDb()
  if (txDepth > 0) {
    txDepth++
    try {
      return fn()
    } finally {
      txDepth--
    }
  }
  d.exec('BEGIN')
  txDepth = 1
  try {
    const result = fn()
    d.exec('COMMIT')
    return result
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  } finally {
    txDepth = 0
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function newId(): string {
  return crypto.randomUUID()
}
