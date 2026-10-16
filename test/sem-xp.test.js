// O XP saiu do Muvuca: banco antigo perde a coluna e o histórico de XP, mas os minutos em call continuam
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../db.js';

test('banco com XP (versão antiga): tira o XP e guarda os minutos em call', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muvuca-semxp-')), 'teste.db');
  openDb(file).db.close();
  // Como era antes: coluna xp e tabela xp_events
  const old = new DatabaseSync(file);
  old.exec(`ALTER TABLE users ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE xp_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL);
    INSERT INTO xp_events (at, user_id, amount, reason) VALUES (1000, 7, 3, 'voice'), (2000, 7, 3, 'voice'), (3000, 7, 20, 'message'), (4000, 8, 50, 'game-won');`);
  old.close();
  const db = openDb(file).db;
  assert.ok(!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'xp'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'xp_events'").get().n, 0);
  assert.deepEqual(db.prepare('SELECT at, user_id FROM call_minutes ORDER BY at').all().map((r) => ({ ...r })), [{ at: 1000, user_id: 7 }, { at: 2000, user_id: 7 }]);
  db.close();
  // Abrir de novo não muda nada (a mudança só acontece uma vez)
  const again = openDb(file).db;
  assert.equal(again.prepare('SELECT COUNT(*) n FROM call_minutes').get().n, 2);
  again.close();
});
