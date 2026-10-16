// Cache do snapshot dos servidores: reaproveita enquanto nada muda, monta de novo quando muda
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, changesSnapshot } from '../db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muvuca-snap-'));
const db = openDb(path.join(dir, 'teste.db'));
const dono = await db.createUser({ username: 'dono', displayName: 'Dono', password: 'senha-de-teste' });
const serverId = db.createServer({ name: 'Turma', owner: dono });
const geral = db.snapshot(serverId).channels.find((c) => c.type === 'text');

test('sem mudança, o snapshot sai do cache', () => {
  assert.equal(db.snapshot(serverId), db.snapshot(serverId));
});

test('mensagem nova e login não refazem o snapshot', () => {
  const antes = db.snapshot(serverId);
  db.addMessage({ channelId: geral.id, user: dono, text: 'oi' });
  db.touchUser(dono.id);
  assert.equal(db.snapshot(serverId), antes);
});

test('mudança no servidor aparece na hora', () => {
  const antes = db.snapshot(serverId);
  db.setNick(serverId, dono.id, 'Chefe');
  const depois = db.snapshot(serverId);
  assert.notEqual(depois, antes);
  assert.equal(depois.members[0].name, 'Chefe');
  db.createChannel({ serverId, type: 'text', name: 'novo' });
  assert.ok(db.snapshot(serverId).channels.some((c) => c.name === 'novo'));
});

test('transação desfeita não deixa o snapshot com o que foi desfeito', () => {
  assert.throws(() => db.transaction(() => {
    db.setNick(serverId, dono.id, 'Fantasma');
    assert.equal(db.snapshot(serverId).members[0].name, 'Fantasma');
    throw new Error('desfaz');
  }));
  assert.equal(db.snapshot(serverId).members[0].name, 'Chefe');
});

test('quais instruções mexem no snapshot', () => {
  assert.equal(changesSnapshot('SELECT * FROM channels'), false);
  assert.equal(changesSnapshot('INSERT INTO messages (x) VALUES (?)'), false);
  assert.equal(changesSnapshot('UPDATE users SET last_seen = ? WHERE id = ?'), false);
  assert.equal(changesSnapshot('UPDATE users SET display_name = ? WHERE id = ?'), true);
  assert.equal(changesSnapshot('INSERT OR IGNORE INTO channel_roles (channel_id, role_id) VALUES (?, ?)'), true);
  assert.equal(changesSnapshot('DELETE FROM users WHERE id = ?'), true);
  assert.equal(changesSnapshot('VACUUM'), true); // na dúvida, mexe
});
