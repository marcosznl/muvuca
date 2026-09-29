// Banco de dados (SQLite embutido no Node.js): contas, servidores, canais, cargos, convites e mensagens.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_PERMS, PERMS } from './public/js/permissions.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const PAGE_SIZE = 50;

// Ids públicos: usuários viram "u<número>" (é também a identidade no LiveKit)
export const uid = (n) => `u${n}`;
export const unum = (id) => Number(String(id).slice(1));
const randomId = (prefix) => `${prefix}-${crypto.randomBytes(5).toString('hex')}`;

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      display_name  TEXT    NOT NULL,
      password_hash TEXT    NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT    PRIMARY KEY,  -- só o hash do token fica salvo
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS servers (
      id         TEXT    PRIMARY KEY,
      name       TEXT    NOT NULL,
      color      TEXT    NOT NULL,
      owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      server_id TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (server_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS roles (
      id          TEXT    PRIMARY KEY,
      server_id   TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      color       TEXT,
      position    INTEGER NOT NULL,          -- maior = mais alto; @everyone fica em 0
      permissions INTEGER NOT NULL,
      is_default  INTEGER NOT NULL DEFAULT 0 -- o cargo @everyone
    );

    CREATE TABLE IF NOT EXISTS member_roles (
      server_id TEXT    NOT NULL,
      user_id   INTEGER NOT NULL,
      role_id   TEXT    NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, role_id),
      FOREIGN KEY (server_id, user_id) REFERENCES members(server_id, user_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS categories (
      id         TEXT    PRIMARY KEY,
      server_id  TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      position   INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      id         TEXT    PRIMARY KEY,        -- também é o nome da sala no LiveKit (canais de voz)
      server_id  TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      type       TEXT    NOT NULL CHECK (type IN ('text', 'voice', 'music')),
      name       TEXT    NOT NULL,
      position   INTEGER NOT NULL,           -- ordem dentro da categoria
      created_at INTEGER NOT NULL,
      category_id TEXT REFERENCES categories(id) ON DELETE SET NULL -- NULL = fora de categoria (no topo)
    );

    CREATE TABLE IF NOT EXISTS invites (
      code       TEXT    PRIMARY KEY,
      server_id  TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      uses       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY,
      channel_id  TEXT    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author_name TEXT    NOT NULL,          -- nome no envio (usado em mensagens importadas)
      text        TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_by_channel ON messages(channel_id, id);

    CREATE TABLE IF NOT EXISTS music_plays (
      id         INTEGER PRIMARY KEY,
      channel_id TEXT    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      video_id   TEXT    NOT NULL,
      title      TEXT    NOT NULL,
      dj_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      started_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS plays_by_channel ON music_plays(channel_id, id);

    CREATE TABLE IF NOT EXISTS emojis (
      id         TEXT    PRIMARY KEY,        -- também é o nome do arquivo em data/emojis/
      server_id  TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      animated   INTEGER NOT NULL DEFAULT 0,
      mime       TEXT    NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS emojis_by_server ON emojis(server_id);

    -- Anexos do chat: imagens, vídeos, voz e documentos (arquivo em data/files/<id>); sem mensagem = envio pendente
    CREATE TABLE IF NOT EXISTS files (
      id         TEXT    PRIMARY KEY,
      owner_id   INTEGER NOT NULL,
      channel_id TEXT    NOT NULL,
      message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      kind       TEXT    NOT NULL,
      mime       TEXT    NOT NULL,
      size       INTEGER NOT NULL,
      width      INTEGER,
      height     INTEGER,
      name       TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_by_message ON files(message_id);

    -- Fotos de perfil e ícones de servidor (arquivo em data/images/<id>)
    CREATE TABLE IF NOT EXISTS images (
      id         TEXT    PRIMARY KEY,
      mime       TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    -- Reações com emoji nas mensagens (emoji comum ou código de emoji do servidor)
    CREATE TABLE IF NOT EXISTS reactions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji      TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );

    -- Até onde cada pessoa leu em cada canal (para as não lidas sobreviverem a recarregar a página)
    CREATE TABLE IF NOT EXISTS read_state (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      last_read  INTEGER NOT NULL,
      PRIMARY KEY (user_id, channel_id)
    );

    -- Partidas terminadas (para o placar da semana)
    CREATE TABLE IF NOT EXISTS game_results (
      id         INTEGER PRIMARY KEY,
      game       TEXT    NOT NULL,
      winner_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS game_players (
      result_id INTEGER NOT NULL REFERENCES game_results(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (result_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS game_results_by_time ON game_results(created_at);

    -- Sons do soundboard de cada servidor (arquivo em data/sounds/<id>)
    CREATE TABLE IF NOT EXISTS sounds (
      id         TEXT    PRIMARY KEY,
      server_id  TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      emoji      TEXT,
      mime       TEXT    NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );

    -- Votos das enquetes (a enquete em si fica no meta da mensagem)
    CREATE TABLE IF NOT EXISTS poll_votes (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      option     INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id, option)
    );

    -- Canais ou servidores silenciados por cada pessoa (sem destaque, som ou notificação)
    CREATE TABLE IF NOT EXISTS mutes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target  TEXT    NOT NULL,
      PRIMARY KEY (user_id, target)
    );

    -- Amizades: um par por linha (a < b); accepted = 0 é pedido esperando resposta de quem não pediu
    CREATE TABLE IF NOT EXISTS friends (
      a          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      b          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requester  INTEGER NOT NULL,
      accepted   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (a, b)
    );
    CREATE INDEX IF NOT EXISTS friends_by_b ON friends(b);

    -- Notificações no celular (Web Push): um registro por aparelho
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint   TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      keys       TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  migrate(db);
  const store = new Store(db);
  store.ensureDmCalls();
  return store;
}

// Taxa de bits da voz (kbps): o mesmo limite vale no site (controle deslizante)
export const VOICE_BITRATE = { min: 16, max: 320, default: 128 };
// Limite de pessoas por canal de voz (0 = sem limite, até o teto do LiveKit em livekit.yaml)
export const VOICE_LIMIT_MAX = 25;

const DEFAULT_CATEGORIES = [['text', 'Canais de texto'], ['voice', 'Canais de voz'], ['music', 'Canais de música']];

// Ajustes em bancos criados por versões anteriores
function migrate(db) {
  // Canais de música: o CHECK antigo só aceitava 'text' e 'voice' (SQLite não altera CHECK, então recria a tabela)
  const channelsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channels'").get()?.sql ?? '';
  if (!channelsSql.includes("'music'")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE channels_new (
        id         TEXT    PRIMARY KEY,
        server_id  TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        type       TEXT    NOT NULL CHECK (type IN ('text', 'voice', 'music')),
        name       TEXT    NOT NULL,
        position   INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO channels_new SELECT id, server_id, type, name, position, created_at FROM channels;
      DROP TABLE channels;
      ALTER TABLE channels_new RENAME TO channels;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
  // Categorias de canais: antes eram fixas por tipo; viram categorias de verdade com o mesmo nome
  const chCols = db.prepare('PRAGMA table_info(channels)').all().map((c) => c.name);
  if (!chCols.includes('category_id')) {
    db.exec('ALTER TABLE channels ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL');
  }
  // Foto de perfil e ícone do servidor
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
  if (!db.prepare('PRAGMA table_info(servers)').all().some((c) => c.name === 'icon')) db.exec('ALTER TABLE servers ADD COLUMN icon TEXT');
  // Anexos (lista em JSON na própria mensagem)
  if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'attachments')) db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
  // Mensagens fixadas
  const msgCols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!msgCols.includes('pinned_at')) db.exec('ALTER TABLE messages ADD COLUMN pinned_at INTEGER');
  // Permissão nova "Fixar mensagens" entra no @everyone dos servidores que já existiam
  if (!db.prepare("SELECT value FROM meta WHERE key = 'perm_pin'").get()) {
    db.prepare('UPDATE roles SET permissions = permissions | ? WHERE is_default = 1').run(PERMS.PIN_MESSAGES);
    db.prepare("INSERT INTO meta (key, value) VALUES ('perm_pin', ?)").run(new Date().toISOString());
  }
  // Respostas (reply): id da mensagem respondida (sem chave estrangeira: a original pode ser apagada)
  if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'reply_to')) db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER');
  // Mensagens editadas
  if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'edited_at')) db.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER');
  // Perfil: "Sobre mim" e cor do banner
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('bio')) db.exec('ALTER TABLE users ADD COLUMN bio TEXT');
  if (!userCols.includes('banner')) db.exec('ALTER TABLE users ADD COLUMN banner TEXT');
  // Banner com imagem (ou GIF), como no Discord; a cor fica por baixo enquanto carrega
  if (!userCols.includes('banner_image')) db.exec('ALTER TABLE users ADD COLUMN banner_image TEXT');
  // Qualidade do áudio por canal de voz (kbps; NULL = padrão)
  if (!db.prepare('PRAGMA table_info(channels)').all().some((c) => c.name === 'user_limit')) db.exec('ALTER TABLE channels ADD COLUMN user_limit INTEGER');
  if (!db.prepare('PRAGMA table_info(channels)').all().some((c) => c.name === 'bitrate')) {
    db.exec('ALTER TABLE channels ADD COLUMN bitrate INTEGER');
  }
  if (!db.prepare("SELECT value FROM meta WHERE key = 'categories_v1'").get()) {
    db.exec('BEGIN');
    const addCat = db.prepare('INSERT INTO categories (id, server_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)');
    const assign = db.prepare('UPDATE channels SET category_id = ? WHERE server_id = ? AND type = ? AND category_id IS NULL');
    const hasType = db.prepare('SELECT 1 FROM channels WHERE server_id = ? AND type = ? LIMIT 1');
    for (const { id: serverId } of db.prepare('SELECT id FROM servers').all()) {
      let pos = 0;
      for (const [type, name] of DEFAULT_CATEGORIES) {
        if (type === 'music' && !hasType.get(serverId, type)) continue;
        const catId = randomId('k');
        addCat.run(catId, serverId, name, pos++, Date.now());
        assign.run(catId, serverId, type);
      }
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('categories_v1', ?)").run(new Date().toISOString());
    db.exec('COMMIT');
  }
  // Mensagens de sistema ("fulano está tocando...")
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!cols.includes('system')) db.exec('ALTER TABLE messages ADD COLUMN system INTEGER NOT NULL DEFAULT 0');
  // Boas-vindas: avisos de entrada/saída e de sala de jogo (ligados por padrão, texto personalizável)
  const srvCols = db.prepare('PRAGMA table_info(servers)').all().map((c) => c.name);
  if (!srvCols.includes('welcome_on')) {
    db.exec(`ALTER TABLE servers ADD COLUMN welcome_on INTEGER NOT NULL DEFAULT 1;
             ALTER TABLE servers ADD COLUMN welcome_channel TEXT;
             ALTER TABLE servers ADD COLUMN welcome_text TEXT;
             ALTER TABLE servers ADD COLUMN leave_text TEXT;
             ALTER TABLE servers ADD COLUMN game_announce INTEGER NOT NULL DEFAULT 1;`);
  }
  // Placar: vitória de várias pessoas na mesma partida (ex.: os inocentes no impostor)
  if (!db.prepare('PRAGMA table_info(game_players)').all().some((c) => c.name === 'won')) db.exec('ALTER TABLE game_players ADD COLUMN won INTEGER NOT NULL DEFAULT 0');
  // Mensagens diretas: "servidores" escondidos (kind = 'dm'); e tópico dos canais
  if (!db.prepare('PRAGMA table_info(servers)').all().some((c) => c.name === 'kind')) db.exec("ALTER TABLE servers ADD COLUMN kind TEXT NOT NULL DEFAULT 'server'");
  if (!db.prepare('PRAGMA table_info(channels)').all().some((c) => c.name === 'topic')) db.exec('ALTER TABLE channels ADD COLUMN topic TEXT');
  // Nome escolhido para o grupo (sem nome: mostra os nomes das pessoas)
  if (!db.prepare('PRAGMA table_info(servers)').all().some((c) => c.name === 'dm_name')) db.exec('ALTER TABLE servers ADD COLUMN dm_name TEXT');
  // Convites com validade e limite de usos (os antigos continuam sem limite)
  const invCols = db.prepare('PRAGMA table_info(invites)').all().map((c) => c.name);
  if (!invCols.includes('expires_at')) db.exec('ALTER TABLE invites ADD COLUMN expires_at INTEGER; ALTER TABLE invites ADD COLUMN max_uses INTEGER;');
  // Dados extras de mensagens de sistema (ex.: a sala de jogo anunciada)
  if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'meta')) db.exec('ALTER TABLE messages ADD COLUMN meta TEXT');
  // Status: online / ausente / não perturbe / invisível, e um texto livre
  const uCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!uCols.includes('presence')) db.exec("ALTER TABLE users ADD COLUMN presence TEXT NOT NULL DEFAULT 'online'");
  if (!uCols.includes('status_text')) db.exec('ALTER TABLE users ADD COLUMN status_text TEXT');
  // Não lidas: quem já existia começa com tudo lido (senão o histórico inteiro viraria "novo")
  if (!db.prepare("SELECT value FROM meta WHERE key = 'read_state_v1'").get()) {
    db.exec(`INSERT OR IGNORE INTO read_state (user_id, channel_id, last_read)
             SELECT mem.user_id, c.id, COALESCE((SELECT MAX(id) FROM messages WHERE channel_id = c.id), 0)
             FROM members mem JOIN channels c ON c.server_id = mem.server_id WHERE c.type != 'voice'`);
    db.prepare("INSERT INTO meta (key, value) VALUES ('read_state_v1', ?)").run(new Date().toISOString());
  }
  // Permissão nova "Tocar como DJ" entra no @everyone dos servidores que já existiam
  const done = db.prepare("SELECT value FROM meta WHERE key = 'perm_music_dj'").get();
  if (!done) {
    db.prepare('UPDATE roles SET permissions = permissions | ? WHERE is_default = 1').run(PERMS.MUSIC_DJ);
    db.prepare("INSERT INTO meta (key, value) VALUES ('perm_music_dj', ?)").run(new Date().toISOString());
  }
}

// ---------- Senhas e tokens ----------

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

const publicUser = (row) => row && {
  id: uid(row.id), username: row.username, name: row.display_name,
  avatar: row.avatar ?? null, bio: row.bio ?? '', banner: row.banner ?? null, bannerImage: row.banner_image ?? null,
  presence: row.presence ?? 'online', statusText: row.status_text ?? '',
};

// Tipos de mensagem de sistema (coluna messages.system)
// Conversa direta: mensagens, fixar e ligar (voz, câmera e tela)
const DM_PERMS = PERMS.SEND_MESSAGES | PERMS.PIN_MESSAGES | PERMS.CONNECT | PERMS.SPEAK | PERMS.VIDEO;

export const SYSTEM = { music: 1, join: 2, leave: 3, game: 4, call: 5, rename: 6 };
const SYSTEM_KIND = Object.fromEntries(Object.entries(SYSTEM).map(([k, v]) => [v, k]));

// Textos padrão dos avisos ({user} = quem chegou/saiu, {server} = nome do servidor)
export const WELCOME_DEFAULTS = {
  join: '👋 {user} chegou! Boas-vindas ao {server}.',
  leave: '🚪 {user} saiu do servidor.',
};

const toMessage = (row) => ({
  id: row.id,
  channel: row.channel_id,
  userId: row.system ? 'system' : row.user_id ? uid(row.user_id) : `imp:${row.author_name}`,
  name: row.display_name ?? row.author_name,
  text: row.text,
  ts: row.created_at,
  ...(row.edited_at ? { editedAt: row.edited_at } : {}),
  ...(row.pinned_at ? { pinnedAt: row.pinned_at } : {}),
  ...(row.attachments ? { attachments: JSON.parse(row.attachments).map((a) => ({ ...a, url: `/file/${a.id}` })) } : {}),
  // Resposta: um resumo da original (ou "apagada", se ela não existe mais)
  ...(row.reply_to ? {
    reply: row.reply_id
      ? { id: row.reply_id, userId: row.reply_user_id ? uid(row.reply_user_id) : `imp:${row.reply_name}`, name: row.reply_name, text: String(row.reply_text).slice(0, 200) }
      : { id: row.reply_to, deleted: true },
  } : {}),
  ...(row.system ? { system: true, kind: SYSTEM_KIND[row.system] ?? 'music' } : {}),
  ...(row.meta ? { meta: JSON.parse(row.meta) } : {}),
});

// Votos de enquete por opção: [{ option, users: [ids] }]
function groupVotes(rows) {
  const byMsg = new Map();
  for (const r of rows) {
    if (!byMsg.has(r.message_id)) byMsg.set(r.message_id, new Map());
    const m = byMsg.get(r.message_id);
    if (!m.has(r.option)) m.set(r.option, []);
    m.get(r.option).push(uid(r.user_id));
  }
  return (id) => [...(byMsg.get(id) ?? [])].map(([option, users]) => ({ option, users }));
}

// Junta as reações por emoji, na ordem em que apareceram: [{ emoji, users: [ids] }]
function groupReactions(rows) {
  const byMsg = new Map();
  for (const r of rows) {
    if (!byMsg.has(r.message_id)) byMsg.set(r.message_id, new Map());
    const m = byMsg.get(r.message_id);
    if (!m.has(r.emoji)) m.set(r.emoji, []);
    m.get(r.emoji).push(uid(r.user_id));
  }
  return (id) => [...(byMsg.get(id) ?? [])].map(([emoji, users]) => ({ emoji, users }));
}

const SERVER_COLORS = ['#5865f2', '#eb459e', '#57f287', '#fee75c', '#ed4245', '#3ba55c', '#faa61a', '#9b59b6'];

class Store {
  constructor(db) {
    this.db = db;
    const p = (sql) => db.prepare(sql);
    this.q = {
      // usuários e sessões
      userByName: p('SELECT * FROM users WHERE username = ?'),
      userById: p('SELECT * FROM users WHERE id = ?'),
      countUsers: p('SELECT COUNT(*) AS n FROM users'),
      insertUser: p('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)'),
      insertSession: p('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
      sessionUser: p(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                      WHERE s.token_hash = ? AND s.expires_at > ?`),
      deleteSession: p('DELETE FROM sessions WHERE token_hash = ?'),
      deleteOtherSessions: p('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
      setPassword: p('UPDATE users SET password_hash = ? WHERE id = ?'),
      gamePlays: p('SELECT game, COUNT(*) AS n FROM game_results WHERE created_at > ? GROUP BY game'),
      purgeSessions: p('DELETE FROM sessions WHERE expires_at <= ?'),
      // servidores e membros
      server: p('SELECT * FROM servers WHERE id = ?'),
      insertServer: p('INSERT INTO servers (id, name, color, owner_id, created_at) VALUES (?, ?, ?, ?, ?)'),
      updateServer: p('UPDATE servers SET name = ?, color = ? WHERE id = ?'),
      setOwner: p('UPDATE servers SET owner_id = ? WHERE id = ?'),
      deleteServer: p('DELETE FROM servers WHERE id = ?'),
      ownedCount: p('SELECT COUNT(*) AS n FROM servers WHERE owner_id = ?'),
      serversOfUser: p('SELECT server_id FROM members WHERE user_id = ? ORDER BY joined_at'),
      members: p(`SELECT u.id, u.username, u.display_name, u.avatar, u.bio, u.banner, u.banner_image, u.status_text, m.joined_at FROM members m JOIN users u ON u.id = m.user_id
                  WHERE m.server_id = ? ORDER BY m.joined_at`),
      memberRoles: p('SELECT user_id, role_id FROM member_roles WHERE server_id = ?'),
      isMember: p('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?'),
      insertMember: p('INSERT OR IGNORE INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)'),
      deleteMember: p('DELETE FROM members WHERE server_id = ? AND user_id = ?'),
      clearMemberRoles: p('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?'),
      insertMemberRole: p('INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)'),
      // cargos
      roles: p('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC'),
      role: p('SELECT * FROM roles WHERE id = ?'),
      insertRole: p(`INSERT INTO roles (id, server_id, name, color, position, permissions, is_default)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`),
      updateRole: p('UPDATE roles SET name = ?, color = ?, permissions = ? WHERE id = ?'),
      setRolePosition: p('UPDATE roles SET position = ? WHERE id = ?'),
      shiftRolesUp: p('UPDATE roles SET position = position + 1 WHERE server_id = ? AND is_default = 0'),
      deleteRole: p('DELETE FROM roles WHERE id = ?'),
      countRoles: p('SELECT COUNT(*) AS n FROM roles WHERE server_id = ?'),
      // canais
      channels: p('SELECT * FROM channels WHERE server_id = ? ORDER BY position, created_at'),
      channelsIn: p('SELECT id FROM channels WHERE server_id = ? AND category_id IS ? ORDER BY position, created_at'),
      setChannelPlace: p('UPDATE channels SET category_id = ?, position = ? WHERE id = ?'),
      channel: p('SELECT * FROM channels WHERE id = ?'),
      allVoiceChannels: p("SELECT id, server_id FROM channels WHERE type = 'voice'"),
      allMusicChannels: p("SELECT id, server_id FROM channels WHERE type = 'music'"),
      countChannels: p('SELECT COUNT(*) AS n FROM channels WHERE server_id = ? AND type = ?'),
      maxChannelPos: p('SELECT COALESCE(MAX(position), -1) AS p FROM channels WHERE server_id = ? AND category_id IS ?'),
      insertChannel: p('INSERT INTO channels (id, server_id, type, name, position, created_at, category_id) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      renameChannel: p('UPDATE channels SET name = ? WHERE id = ?'),
      setChannelBitrate: p('UPDATE channels SET bitrate = ? WHERE id = ?'),
      deleteChannel: p('DELETE FROM channels WHERE id = ?'),
      // categorias
      categories: p('SELECT * FROM categories WHERE server_id = ? ORDER BY position, created_at'),
      category: p('SELECT * FROM categories WHERE id = ?'),
      countCategories: p('SELECT COUNT(*) AS n FROM categories WHERE server_id = ?'),
      maxCategoryPos: p('SELECT COALESCE(MAX(position), -1) AS p FROM categories WHERE server_id = ?'),
      insertCategory: p('INSERT INTO categories (id, server_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)'),
      renameCategory: p('UPDATE categories SET name = ? WHERE id = ?'),
      setCategoryPos: p('UPDATE categories SET position = ? WHERE id = ?'),
      deleteCategory: p('DELETE FROM categories WHERE id = ?'),
      // convites
      insertInvite: p('INSERT INTO invites (code, server_id, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)'),
      // Só vale se não venceu e ainda tem usos
      invite: p(`SELECT i.code, i.server_id, s.name, s.color, s.icon,
                        (SELECT COUNT(*) FROM members m WHERE m.server_id = s.id) AS member_count
                 FROM invites i JOIN servers s ON s.id = i.server_id
                 WHERE i.code = ? AND (i.expires_at IS NULL OR i.expires_at > ?) AND (i.max_uses IS NULL OR i.uses < i.max_uses)`),
      invitesOf: p(`SELECT i.*, u.display_name FROM invites i LEFT JOIN users u ON u.id = i.created_by
                    WHERE i.server_id = ? AND (i.expires_at IS NULL OR i.expires_at > ?) AND (i.max_uses IS NULL OR i.uses < i.max_uses)
                    ORDER BY i.created_at DESC`),
      inviteRow: p('SELECT * FROM invites WHERE code = ?'),
      deleteInvite: p('DELETE FROM invites WHERE code = ?'),
      useInvite: p('UPDATE invites SET uses = uses + 1 WHERE code = ?'),
      // mensagens
      insertMessage: p('INSERT INTO messages (channel_id, user_id, author_name, text, created_at, reply_to, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      // anexos
      insertFile: p(`INSERT INTO files (id, owner_id, channel_id, kind, mime, size, width, height, name, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      file: p('SELECT * FROM files WHERE id = ?'),
      attachFile: p('UPDATE files SET message_id = ? WHERE id = ?'),
      filesOfMessage: p('SELECT id FROM files WHERE message_id = ?'),
      staleFiles: p('SELECT id FROM files WHERE message_id IS NULL AND created_at < ?'),
      deleteFile: p('DELETE FROM files WHERE id = ?'),
      insertSystemMessage: p("INSERT INTO messages (channel_id, user_id, author_name, text, created_at, system) VALUES (?, NULL, '', ?, ?, 1)"),
      insertPlay: p('INSERT INTO music_plays (channel_id, video_id, title, dj_id, started_at) VALUES (?, ?, ?, ?, ?)'),
      recentPlays: p(`SELECT p.video_id, p.title, p.started_at, u.display_name FROM music_plays p
                      LEFT JOIN users u ON u.id = p.dj_id WHERE p.channel_id = ? ORDER BY p.id DESC LIMIT ?`),
      editMessage: p('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?'),
      pinMessage: p('UPDATE messages SET pinned_at = ? WHERE id = ?'),
      countPins: p('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL'),
      pinnedIds: p('SELECT id FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC'),
      deleteMessage: p('DELETE FROM messages WHERE id = ?'),
      messageRow: p('SELECT m.*, c.server_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?'),
      messageById: p(`SELECT m.*, u.display_name,
                              r.id AS reply_id, r.user_id AS reply_user_id, r.text AS reply_text,
                              COALESCE(ru.display_name, r.author_name) AS reply_name
                       FROM messages m LEFT JOIN users u ON u.id = m.user_id
                       LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.user_id WHERE m.id = ?`),
      messagesBefore: p(`SELECT m.*, u.display_name,
                              r.id AS reply_id, r.user_id AS reply_user_id, r.text AS reply_text,
                              COALESCE(ru.display_name, r.author_name) AS reply_name
                       FROM messages m LEFT JOIN users u ON u.id = m.user_id
                       LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.user_id
                         WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`),
      // emojis
      emojis: p('SELECT * FROM emojis WHERE server_id = ? ORDER BY created_at'),
      emoji: p('SELECT * FROM emojis WHERE id = ?'),
      emojisOfServerIds: p('SELECT id FROM emojis WHERE server_id = ?'),
      countEmojis: p('SELECT COUNT(*) AS n FROM emojis WHERE server_id = ? AND animated = ?'),
      emojiByName: p('SELECT 1 FROM emojis WHERE server_id = ? AND name = ? COLLATE NOCASE AND id != ?'),
      insertEmoji: p('INSERT INTO emojis (id, server_id, name, animated, mime, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      renameEmoji: p('UPDATE emojis SET name = ? WHERE id = ?'),
      deleteEmoji: p('DELETE FROM emojis WHERE id = ?'),
      // imagens (foto de perfil, ícone do servidor)
      insertImage: p('INSERT INTO images (id, mime, created_at) VALUES (?, ?, ?)'),
      image: p('SELECT * FROM images WHERE id = ?'),
      deleteImage: p('DELETE FROM images WHERE id = ?'),
      setAvatar: p('UPDATE users SET avatar = ? WHERE id = ?'),
      setBannerImage: p('UPDATE users SET banner_image = ? WHERE id = ?'),
      updateProfile: p('UPDATE users SET display_name = ?, bio = ?, banner = ? WHERE id = ?'),
      setServerIcon: p('UPDATE servers SET icon = ? WHERE id = ?'),
      // reações
      reactionsOf: p('SELECT message_id, user_id, emoji FROM reactions WHERE message_id = ? ORDER BY created_at'),
      reactionsIn: p(`SELECT r.message_id, r.user_id, r.emoji FROM reactions r JOIN messages m ON m.id = r.message_id
                      WHERE m.channel_id = ? AND r.message_id BETWEEN ? AND ? ORDER BY r.created_at`),
      addReaction: p('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)'),
      removeReaction: p('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
      countReactionKinds: p('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?'),
      hasReactionKind: p('SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ? LIMIT 1'),
      // não lidas
      markRead: p(`INSERT INTO read_state (user_id, channel_id, last_read) VALUES (?, ?, ?)
                   ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read = MAX(last_read, excluded.last_read)`),
      readStateOf: p('SELECT channel_id, last_read FROM read_state WHERE user_id = ?'),
      unreadCounts: p(`SELECT m.channel_id, COUNT(*) AS n,
                              SUM(CASE WHEN m.text LIKE '%' || ? || '%' THEN 1 ELSE 0 END) AS mentions
                       FROM messages m JOIN channels c ON c.id = m.channel_id
                       JOIN members mem ON mem.server_id = c.server_id AND mem.user_id = ?
                       LEFT JOIN read_state r ON r.user_id = mem.user_id AND r.channel_id = m.channel_id
                       WHERE m.id > COALESCE(r.last_read, 0) AND m.created_at > mem.joined_at
                         AND m.system = 0 AND (m.user_id IS NULL OR m.user_id != mem.user_id)
                       GROUP BY m.channel_id`),
      lastMessageId: p('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel_id = ?'),
      // busca
      search: p(`SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id
                 WHERE c.server_id = ? AND c.type != 'voice' AND m.system = 0 AND m.text LIKE ? ESCAPE '\\'
                   AND (? IS NULL OR m.user_id = ?) AND (? IS NULL OR m.channel_id = ?)
                 ORDER BY m.id DESC LIMIT ?`),
      // boas-vindas e status
      setWelcome: p('UPDATE servers SET welcome_on = ?, welcome_channel = ?, welcome_text = ?, leave_text = ?, game_announce = ? WHERE id = ?'),
      setPresence: p('UPDATE users SET presence = ? WHERE id = ?'),
      setStatusText: p('UPDATE users SET status_text = ? WHERE id = ?'),
      insertSystemMeta: p("INSERT INTO messages (channel_id, user_id, author_name, text, created_at, system, meta) VALUES (?, NULL, '', ?, ?, ?, ?)"),
      // placar dos jogos
      insertResult: p('INSERT INTO game_results (game, winner_id, created_at) VALUES (?, ?, ?)'),
      insertResultPlayer: p('INSERT OR IGNORE INTO game_players (result_id, user_id, won) VALUES (?, ?, ?)'),
      statsOf: p(`SELECT gr.game, COUNT(*) AS played,
                         SUM(CASE WHEN gp.won = 1 OR gr.winner_id = gp.user_id THEN 1 ELSE 0 END) AS wins
                  FROM game_players gp JOIN game_results gr ON gr.id = gp.result_id WHERE gp.user_id = ? GROUP BY gr.game`),
      leaderboard: p(`SELECT gp.user_id, u.display_name, COUNT(*) AS played,
                             SUM(CASE WHEN gp.won = 1 OR gr.winner_id = gp.user_id THEN 1 ELSE 0 END) AS wins
                      FROM game_players gp JOIN game_results gr ON gr.id = gp.result_id JOIN users u ON u.id = gp.user_id
                      WHERE gr.created_at >= ? GROUP BY gp.user_id ORDER BY wins DESC, played DESC LIMIT ?`),
      // notificações
      addPushSub: p(`INSERT INTO push_subs (endpoint, user_id, keys, created_at) VALUES (?, ?, ?, ?)
                     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys`),
      pushSubsOf: p('SELECT endpoint, keys FROM push_subs WHERE user_id = ?'),
      deletePushSub: p('DELETE FROM push_subs WHERE endpoint = ?'),
      deleteUserPushSub: p('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?'),
      // soundboard
      soundsOf: p('SELECT * FROM sounds WHERE server_id = ? ORDER BY created_at'),
      sound: p('SELECT * FROM sounds WHERE id = ?'),
      insertSound: p('INSERT INTO sounds (id, server_id, name, emoji, mime, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      deleteSound: p('DELETE FROM sounds WHERE id = ?'),
      soundIdsOf: p('SELECT id FROM sounds WHERE server_id = ?'),
      // enquetes
      insertPoll: p('INSERT INTO messages (channel_id, user_id, author_name, text, created_at, meta) VALUES (?, ?, ?, ?, ?, ?)'),
      votesOf: p('SELECT message_id, user_id, option FROM poll_votes WHERE message_id = ? ORDER BY rowid'),
      votesIn: p(`SELECT v.message_id, v.user_id, v.option FROM poll_votes v JOIN messages m ON m.id = v.message_id
                  WHERE m.channel_id = ? AND v.message_id BETWEEN ? AND ? ORDER BY v.rowid`),
      addVote: p('INSERT OR IGNORE INTO poll_votes (message_id, user_id, option) VALUES (?, ?, ?)'),
      removeVote: p('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ? AND option = ?'),
      clearVotes: p('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?'),
      setMsgMeta: p('UPDATE messages SET meta = ? WHERE id = ?'),
      // mensagens diretas, tópico e silenciados
      setKind: p('UPDATE servers SET kind = ?, welcome_on = 0, game_announce = 0 WHERE id = ?'),
      setRolePerms: p('UPDATE roles SET permissions = ? WHERE server_id = ? AND is_default = 1'),
      findDm: p(`SELECT s.id FROM servers s WHERE s.kind = 'dm'
                   AND (SELECT COUNT(*) FROM members m WHERE m.server_id = s.id) = 2
                   AND EXISTS (SELECT 1 FROM members m WHERE m.server_id = s.id AND m.user_id = ?)
                   AND EXISTS (SELECT 1 FROM members m WHERE m.server_id = s.id AND m.user_id = ?)`),
      shareServer: p(`SELECT 1 FROM members a JOIN members b ON a.server_id = b.server_id JOIN servers s ON s.id = a.server_id
                      WHERE a.user_id = ? AND b.user_id = ? AND s.kind = 'server' LIMIT 1`),
      setTopic: p('UPDATE channels SET topic = ? WHERE id = ?'),
      friendRows: p(`SELECT u.*, f.requester, f.accepted FROM friends f JOIN users u ON u.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END
                     WHERE f.a = ? OR f.b = ?`),
      friendPair: p('SELECT * FROM friends WHERE a = ? AND b = ?'),
      insertFriend: p('INSERT INTO friends (a, b, requester, accepted, created_at) VALUES (?, ?, ?, 0, ?)'),
      acceptFriend: p('UPDATE friends SET accepted = 1 WHERE a = ? AND b = ?'),
      deleteFriend: p('DELETE FROM friends WHERE a = ? AND b = ?'),
      mutesOf: p('SELECT target FROM mutes WHERE user_id = ?'),
      addMute: p('INSERT OR IGNORE INTO mutes (user_id, target) VALUES (?, ?)'),
      removeMute: p('DELETE FROM mutes WHERE user_id = ? AND target = ?'),
      isMuted: p('SELECT 1 FROM mutes WHERE user_id = ? AND target IN (?, ?)'),
      // meta
      getMeta: p('SELECT value FROM meta WHERE key = ?'),
      setMeta: p('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  meta(key) { return this.q.getMeta.get(key)?.value ?? null; }
  setMeta(key, value) { this.q.setMeta.run(key, value); }

  // ---------- Contas ----------

  async createUser({ username, displayName, password }) {
    const hash = await hashPassword(password);
    const { lastInsertRowid } = this.q.insertUser.run(username, displayName, hash, Date.now());
    return publicUser(this.q.userById.get(lastInsertRowid));
  }

  usernameTaken(username) { return !!this.q.userByName.get(username); }
  userName(id) { return this.q.userById.get(unum(id))?.display_name ?? 'Alguém'; }
  userCount() { return this.q.countUsers.get().n; }

  async checkLogin(username, password) {
    const row = this.q.userByName.get(username);
    if (!row) {
      await hashPassword(password); // gasta o mesmo tempo, para não revelar se o usuário existe
      return null;
    }
    return (await verifyPassword(password, row.password_hash)) ? publicUser(row) : null;
  }

  createSession(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.q.insertSession.run(hashToken(token), unum(user.id), now, now + SESSION_DAYS * 86_400_000);
    return token;
  }

  userBySession(token) {
    if (!token) return null;
    return publicUser(this.q.sessionUser.get(hashToken(String(token)), Date.now()));
  }

  deleteSession(token) { if (token) this.q.deleteSession.run(hashToken(String(token))); }
  // Troca de senha: confere a atual, grava a nova e derruba as outras sessões (fica só a de quem trocou)
  async checkPassword(userId, password) {
    const row = this.q.userById.get(unum(userId));
    return !!row && verifyPassword(password, row.password_hash);
  }
  async setPassword(userId, password) { this.q.setPassword.run(await hashPassword(password), unum(userId)); }
  // Partidas de cada jogo nos últimos `days` dias (só para ordenar a lista; não vai para o site)
  gamePlays(days = 90) {
    return Object.fromEntries(this.q.gamePlays.all(Date.now() - days * 86_400_000).map((r) => [r.game, r.n]));
  }
  deleteOtherSessions(userId, keepToken) { return this.q.deleteOtherSessions.run(unum(userId), hashToken(String(keepToken))).changes; }
  purgeExpiredSessions() { this.q.purgeSessions.run(Date.now()); }

  // ---------- Servidores ----------

  // Cria o servidor com o cargo @everyone, um canal de texto e um de voz
  createServer({ name, owner, id = randomId('s'), withDefaultChannels = true }) {
    return this.transaction(() => {
      const color = SERVER_COLORS[crypto.randomInt(SERVER_COLORS.length)];
      this.q.insertServer.run(id, name, color, owner ? unum(owner.id) : null, Date.now());
      this.q.insertRole.run(randomId('r'), id, '@everyone', null, 0, DEFAULT_PERMS, 1);
      if (owner) this.q.insertMember.run(id, unum(owner.id), Date.now());
      if (withDefaultChannels) {
        const textCat = this.createCategory(id, 'Canais de texto');
        const voiceCat = this.createCategory(id, 'Canais de voz');
        this.createChannel({ serverId: id, type: 'text', name: 'geral', categoryId: textCat });
        this.createChannel({ serverId: id, type: 'voice', name: 'Geral', categoryId: voiceCat });
      }
      return id;
    });
  }

  server(id) { return this.q.server.get(String(id)); }
  updateServer(id, { name, color }) { this.q.updateServer.run(name, color, id); }
  deleteServer(id) { this.q.deleteServer.run(id); }
  setOwner(serverId, user) { this.q.setOwner.run(unum(user.id), serverId); }
  ownedCount(user) { return this.q.ownedCount.get(unum(user.id)).n; }

  serverIdsOf(user) { return this.q.serversOfUser.all(unum(user.id)).map((r) => r.server_id); }
  isMember(serverId, userId) { return !!this.q.isMember.get(serverId, unum(userId)); }
  addMember(serverId, user) { this.q.insertMember.run(serverId, unum(user.id), Date.now()); }
  removeMember(serverId, userId) { this.q.deleteMember.run(serverId, unum(userId)); }

  // Tudo o que o site precisa saber de um servidor (canais, cargos e membros)
  snapshot(serverId) {
    const s = this.server(serverId);
    if (!s) return null;
    const rolesByUser = new Map();
    for (const r of this.q.memberRoles.all(serverId)) {
      if (!rolesByUser.has(r.user_id)) rolesByUser.set(r.user_id, []);
      rolesByUser.get(r.user_id).push(r.role_id);
    }
    return {
      id: s.id,
      name: s.name,
      color: s.color,
      icon: s.icon ?? null,
      ownerId: s.owner_id ? uid(s.owner_id) : null,
      home: s.id === this.meta('home_server'), // o servidor principal não pode ser excluído
      kind: s.kind ?? 'server', // 'dm' = conversa privada (fica fora da coluna de servidores)
      dmName: s.dm_name ?? null,
      welcome: {
        on: s.welcome_on === 1, channelId: s.welcome_channel ?? null,
        joinText: s.welcome_text ?? WELCOME_DEFAULTS.join, leaveText: s.leave_text ?? WELCOME_DEFAULTS.leave,
        gameAnnounce: s.game_announce === 1,
      },
      categories: this.q.categories.all(serverId).map((k) => ({ id: k.id, name: k.name })),
      channels: this.q.channels.all(serverId).map((c) => ({
        id: c.id, type: c.type, name: c.name, categoryId: c.category_id, topic: c.topic ?? '',
        ...(c.type === 'voice' ? { bitrate: c.bitrate ?? VOICE_BITRATE.default, userLimit: c.user_limit ?? 0 } : {}),
      })),
      roles: this.q.roles.all(serverId).map((r) => ({
        id: r.id, name: r.name, color: r.color, position: r.position, permissions: r.permissions, isDefault: r.is_default === 1,
      })),
      sounds: this.q.soundsOf.all(serverId).map((x) => ({ id: x.id, name: x.name, emoji: x.emoji ?? '🔊' })),
      emojis: this.q.emojis.all(serverId).map((e) => ({
        id: e.id, name: e.name, animated: e.animated === 1, by: e.created_by ? uid(e.created_by) : null,
      })),
      members: this.q.members.all(serverId).map((m) => ({
        id: uid(m.id), username: m.username, name: m.display_name, avatar: m.avatar ?? null,
        bio: m.bio ?? '', banner: m.banner ?? null, bannerImage: m.banner_image ?? null, statusText: m.status_text ?? '', joinedAt: m.joined_at, roles: rolesByUser.get(m.id) ?? [],
      })),
    };
  }

  // ---------- Cargos ----------

  role(id) { return this.q.role.get(String(id)); }
  roleCount(serverId) { return this.q.countRoles.get(serverId).n; }

  // Cargo novo entra logo acima do @everyone, como no Discord
  createRole(serverId, { name, color = null, permissions = 0 }) {
    return this.transaction(() => {
      this.q.shiftRolesUp.run(serverId);
      const id = randomId('r');
      this.q.insertRole.run(id, serverId, name, color, 1, permissions, 0);
      return id;
    });
  }

  updateRole(id, { name, color, permissions }) { this.q.updateRole.run(name, color, permissions, id); }
  deleteRole(id) { this.q.deleteRole.run(id); }

  // Reordena os cargos (menos o @everyone): ids do mais baixo para o mais alto viram posições 1, 2, 3…
  setRoleOrder(ids) {
    this.transaction(() => ids.forEach((id, i) => this.q.setRolePosition.run(i + 1, id)));
  }

  swapRoles(a, b) {
    this.transaction(() => {
      this.q.setRolePosition.run(b.position, a.id);
      this.q.setRolePosition.run(a.position, b.id);
    });
  }

  setMemberRoles(serverId, userId, roleIds) {
    this.transaction(() => {
      this.q.clearMemberRoles.run(serverId, unum(userId));
      for (const r of roleIds) this.q.insertMemberRole.run(serverId, unum(userId), r);
    });
  }

  // ---------- Canais ----------

  channel(id) { return this.q.channel.get(String(id)); }
  voiceChannels() { return this.q.allVoiceChannels.all(); }
  musicChannels() { return this.q.allMusicChannels.all(); }
  countChannels(serverId, type) { return this.q.countChannels.get(serverId, type).n; }

  createChannel({ serverId, type, name, categoryId = null, id = randomId({ text: 't', voice: 'v', music: 'm' }[type]) }) {
    const position = this.q.maxChannelPos.get(serverId, categoryId).p + 1;
    this.q.insertChannel.run(id, serverId, type, name, position, Date.now(), categoryId);
    return id;
  }

  // Coloca o canal na categoria (null = sem categoria) na posição `index`, renumerando os vizinhos
  moveChannel(channel, categoryId, index) {
    this.transaction(() => {
      const ids = this.q.channelsIn.all(channel.server_id, categoryId).map((r) => r.id).filter((id) => id !== channel.id);
      ids.splice(Math.max(0, Math.min(index, ids.length)), 0, channel.id);
      ids.forEach((id, i) => this.q.setChannelPlace.run(categoryId, i, id));
    });
  }

  // ---------- Categorias ----------

  category(id) { return this.q.category.get(String(id)); }
  countCategories(serverId) { return this.q.countCategories.get(serverId).n; }

  createCategory(serverId, name) {
    const id = randomId('k');
    this.q.insertCategory.run(id, serverId, name, this.q.maxCategoryPos.get(serverId).p + 1, Date.now());
    return id;
  }

  renameCategory(id, name) { this.q.renameCategory.run(name, id); }

  // Os canais da categoria excluída vão para o fim da lista sem categoria
  deleteCategory(cat) {
    this.transaction(() => {
      let pos = this.q.maxChannelPos.get(cat.server_id, null).p + 1;
      for (const { id } of this.q.channelsIn.all(cat.server_id, cat.id)) this.q.setChannelPlace.run(null, pos++, id);
      this.q.deleteCategory.run(cat.id);
    });
  }

  moveCategory(cat, index) {
    this.transaction(() => {
      const ids = this.q.categories.all(cat.server_id).map((k) => k.id).filter((id) => id !== cat.id);
      ids.splice(Math.max(0, Math.min(index, ids.length)), 0, cat.id);
      ids.forEach((id, i) => this.q.setCategoryPos.run(i, id));
    });
  }

  renameChannel(id, name) { this.q.renameChannel.run(name, id); }
  setChannelBitrate(id, kbps) { this.q.setChannelBitrate.run(kbps, id); }
  setChannelLimit(id, limit) { this.db.prepare('UPDATE channels SET user_limit = ? WHERE id = ?').run(limit || null, id); }
  deleteChannel(id) { this.q.deleteChannel.run(id); } // as mensagens vão junto (ON DELETE CASCADE)

  // ---------- Anexos do chat ----------

  addFile({ id, user, channelId, kind, mime, size, width, height, name }) {
    this.q.insertFile.run(id, unum(user.id), channelId, kind, mime, size, width, height, name, Date.now());
  }
  file(id) { return this.q.file.get(String(id)); }
  filesOfMessage(messageId) { return this.q.filesOfMessage.all(Number(messageId)).map((r) => r.id); }
  staleFiles(before) { return this.q.staleFiles.all(before).map((r) => r.id); }
  deleteFile(id) { this.q.deleteFile.run(id); }

  // ---------- Imagens ----------

  addImage(mime) {
    const id = randomId('i');
    this.q.insertImage.run(id, mime, Date.now());
    return id;
  }
  image(id) { return this.q.image.get(String(id)); }
  deleteImage(id) { this.q.deleteImage.run(id); }

  // Trocam a imagem e devolvem a antiga (para apagar o arquivo)
  setAvatar(userId, imageId) {
    const old = this.q.userById.get(unum(userId))?.avatar ?? null;
    this.q.setAvatar.run(imageId, unum(userId));
    return old;
  }
  setBannerImage(userId, imageId) {
    const old = this.q.userById.get(unum(userId))?.banner_image ?? null;
    this.q.setBannerImage.run(imageId, unum(userId));
    return old;
  }
  setServerIcon(serverId, imageId) {
    const old = this.server(serverId)?.icon ?? null;
    this.q.setServerIcon.run(imageId, serverId);
    return old;
  }
  userById(id) { return publicUser(this.q.userById.get(unum(id))); }
  updateProfile(userId, { name, bio, banner }) { this.q.updateProfile.run(name, bio || null, banner, unum(userId)); }

  // ---------- Emojis ----------

  emoji(id) { return this.q.emoji.get(String(id)); }
  emojiIds(serverId) { return this.q.emojisOfServerIds.all(serverId).map((r) => r.id); }
  countEmojis(serverId, animated) { return this.q.countEmojis.get(serverId, animated ? 1 : 0).n; }
  emojiNameTaken(serverId, name, exceptId = '') { return !!this.q.emojiByName.get(serverId, name, exceptId); }

  createEmoji({ serverId, name, animated, mime, user }) {
    const id = randomId('e');
    this.q.insertEmoji.run(id, serverId, name, animated ? 1 : 0, mime, unum(user.id), Date.now());
    return id;
  }

  renameEmoji(id, name) { this.q.renameEmoji.run(name, id); }
  deleteEmoji(id) { this.q.deleteEmoji.run(id); }

  // ---------- Convites ----------

  // expiresIn: ms até vencer (null = nunca); maxUses: null = sem limite
  createInvite(serverId, user, { expiresIn = null, maxUses = null } = {}) {
    const code = crypto.randomBytes(6).toString('base64url');
    const now = Date.now();
    this.q.insertInvite.run(code, serverId, unum(user.id), now, expiresIn ? now + expiresIn : null, maxUses);
    return code;
  }

  invitesOf(serverId) {
    return this.q.invitesOf.all(serverId, Date.now()).map((r) => ({
      code: r.code, by: r.created_by ? uid(r.created_by) : null, byName: r.display_name ?? '?',
      createdAt: r.created_at, expiresAt: r.expires_at, uses: r.uses, maxUses: r.max_uses,
    }));
  }
  inviteRow(code) { return this.q.inviteRow.get(String(code)); }
  deleteInvite(code) { this.q.deleteInvite.run(String(code)); }

  invite(code) {
    const r = this.q.invite.get(String(code), Date.now());
    return r && { code: r.code, serverId: r.server_id, name: r.name, color: r.color, icon: r.icon, memberCount: r.member_count };
  }

  useInvite(code) { this.q.useInvite.run(code); }

  // ---------- Mensagens ----------

  addMessage({ channelId, user, text, replyTo = null, files = [] }) {
    const attachments = files.length
      ? JSON.stringify(files.map((f) => ({ id: f.id, kind: f.kind, mime: f.mime, size: f.size, width: f.width, height: f.height, name: f.name })))
      : null;
    const { lastInsertRowid } = this.transaction(() => {
      const res = this.q.insertMessage.run(channelId, unum(user.id), user.name, text, Date.now(), replyTo, attachments);
      for (const f of files) this.q.attachFile.run(res.lastInsertRowid, f.id);
      return res;
    });
    return toMessage(this.q.messageById.get(lastInsertRowid));
  }

  // Mensagem com as reações dela
  message(id) {
    const row = this.q.messageById.get(Number(id));
    if (!row) return null;
    const msg = { ...toMessage(row), reactions: groupReactions(this.q.reactionsOf.all(row.id))(row.id) };
    if (msg.meta?.poll) msg.votes = groupVotes(this.q.votesOf.all(row.id))(row.id);
    return msg;
  }

  // ---------- Soundboard ----------

  createSound({ serverId, name, emoji, mime, user }) {
    const id = randomId('snd');
    this.q.insertSound.run(id, serverId, name, emoji || null, mime, unum(user.id), Date.now());
    return id;
  }
  sound(id) { return this.q.sound.get(String(id)); }
  soundIds(serverId) { return this.q.soundIdsOf.all(serverId).map((r) => r.id); }
  deleteSound(id) { this.q.deleteSound.run(id); }

  // ---------- Enquetes ----------

  addPoll({ channelId, user, question, options, multi }) {
    const meta = JSON.stringify({ poll: { question, options, multi: !!multi, closed: false } });
    const { lastInsertRowid } = this.q.insertPoll.run(channelId, unum(user.id), user.name, `📊 ${question}`, Date.now(), meta);
    return this.message(lastInsertRowid);
  }

  // Votar: em escolha única troca o voto; clicar de novo na mesma opção tira o voto
  vote(messageId, userId, option, multi) {
    const id = Number(messageId);
    const mine = this.q.votesOf.all(id).filter((v) => v.user_id === unum(userId)).map((v) => v.option);
    if (mine.includes(option)) this.q.removeVote.run(id, unum(userId), option);
    else {
      if (!multi) this.q.clearVotes.run(id, unum(userId));
      this.q.addVote.run(id, unum(userId), option);
    }
    return groupVotes(this.q.votesOf.all(id))(id);
  }

  setMessageMeta(id, meta) { this.q.setMsgMeta.run(JSON.stringify(meta), Number(id)); return this.message(id); }

  // Liga/desliga uma reação; devolve a lista nova, ou null se passou do limite de emojis diferentes
  react(messageId, userId, emoji, on, maxKinds = 20) {
    const id = Number(messageId);
    if (on) {
      if (!this.q.hasReactionKind.get(id, emoji) && this.q.countReactionKinds.get(id).n >= maxKinds) return null;
      this.q.addReaction.run(id, unum(userId), emoji, Date.now());
    } else {
      this.q.removeReaction.run(id, unum(userId), emoji);
    }
    return groupReactions(this.q.reactionsOf.all(id))(id);
  }

  // Aviso do sistema no chat (ex.: "Liz está tocando: ...")
  // Mensagem com o servidor dela (para conferir permissões)
  messageRow(id) { return this.q.messageRow.get(Number(id)); }
  editMessage(id, text) {
    this.q.editMessage.run(text, Date.now(), Number(id));
    return this.message(id);
  }
  deleteMessage(id) { this.q.deleteMessage.run(Number(id)); }
  pinMessage(id, pinned) {
    this.q.pinMessage.run(pinned ? Date.now() : null, Number(id));
    return this.message(id);
  }
  countPins(channelId) { return this.q.countPins.get(channelId).n; }
  pinnedMessages(channelId) { return this.q.pinnedIds.all(channelId).map((r) => this.message(r.id)); }

  addSystemMessage(channelId, text, kind = SYSTEM.music, meta = null) {
    const { lastInsertRowid } = this.q.insertSystemMeta.run(channelId, text, Date.now(), kind, meta ? JSON.stringify(meta) : null);
    return toMessage(this.q.messageById.get(lastInsertRowid));
  }

  // ---------- Não lidas ----------

  markRead(userId, channelId, messageId) { this.q.markRead.run(unum(userId), channelId, Number(messageId)); }
  markChannelRead(userId, channelId) { this.markRead(userId, channelId, this.q.lastMessageId.get(channelId).id); }
  readState(userId) { return Object.fromEntries(this.q.readStateOf.all(unum(userId)).map((r) => [r.channel_id, r.last_read])); }
  // canal -> { n: quantas não lidas, mentions: quantas mencionam a pessoa }
  unread(userId) {
    return Object.fromEntries(this.q.unreadCounts.all(`<@${userId}>`, unum(userId)).map((r) => [r.channel_id, { n: r.n, mentions: r.mentions }]));
  }

  // ---------- Busca ----------

  // Mensagens do servidor com o texto (as mais novas primeiro); opcional: só de uma pessoa ou de um canal
  search(serverId, { text, userId = null, channelId = null, limit = 25 }) {
    const like = `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const who = userId ? unum(userId) : null;
    return this.q.search.all(serverId, like, who, who, channelId, channelId, limit).map((r) => this.message(r.id));
  }

  // ---------- Boas-vindas e status ----------

  setWelcome(serverId, { on, channelId, joinText, leaveText, gameAnnounce }) {
    this.q.setWelcome.run(on ? 1 : 0, channelId, joinText, leaveText, gameAnnounce ? 1 : 0, serverId);
  }
  setPresence(userId, presence) { this.q.setPresence.run(presence, unum(userId)); }
  setStatusText(userId, text) { this.q.setStatusText.run(text || null, unum(userId)); }

  // ---------- Mensagens diretas ----------

  // Conversa privada: só dá para escrever e fixar; ninguém é dono (ninguém administra)
  createDm(users, { name = null } = {}) {
    const id = this.createServer({ name: name ?? 'Conversa', owner: null, withDefaultChannels: false });
    this.q.setKind.run('dm', id);
    this.q.setRolePerms.run(DM_PERMS, id);
    for (const u of users) this.q.insertMember.run(id, unum(u.id), Date.now());
    this.createChannel({ serverId: id, type: 'text', name: 'conversa' });
    this.createChannel({ serverId: id, type: 'voice', name: 'chamada' }); // ligação direta
    return id;
  }
  // Conversas criadas antes das ligações: ganham o canal de chamada e as permissões de voz
  ensureDmCalls() {
    for (const { id } of this.db.prepare("SELECT id FROM servers WHERE kind = 'dm'").all()) {
      this.q.setRolePerms.run(DM_PERMS, id);
      if (!this.countChannels(id, 'voice')) this.createChannel({ serverId: id, type: 'voice', name: 'chamada' });
    }
  }
  setDmName(serverId, name) { this.db.prepare('UPDATE servers SET dm_name = ? WHERE id = ?').run(name || null, serverId); }
  dmCallChannel(serverId) { return this.snapshot(serverId)?.channels.find((c) => c.type === 'voice') ?? null; }
  findDm(a, b) { return this.q.findDm.get(unum(a), unum(b))?.id ?? null; }
  shareServer(a, b) { return !!this.q.shareServer.get(unum(a), unum(b)); }

  // ---------- Tópico do canal e silenciados ----------

  setTopic(channelId, topic) { this.q.setTopic.run(topic || null, channelId); }
  // Amizades: status 'friend' (aceita), 'incoming' (pediram para você) ou 'outgoing' (você pediu)
  friendsOf(userId) {
    const me = unum(userId);
    return this.q.friendRows.all(me, me, me).map((r) => ({
      user: publicUser(r),
      status: r.accepted ? 'friend' : r.requester === me ? 'outgoing' : 'incoming',
    }));
  }
  friendship(userA, userB) {
    const [x, y] = [unum(userA), unum(userB)];
    const row = this.q.friendPair.get(Math.min(x, y), Math.max(x, y));
    if (!row) return null;
    return row.accepted ? 'friend' : row.requester === x ? 'outgoing' : 'incoming';
  }
  // Pedir amizade; se a outra pessoa já tinha pedido, vira amizade na hora. Devolve o novo status.
  requestFriend(from, to) {
    const [x, y] = [unum(from), unum(to)];
    const [a, b] = [Math.min(x, y), Math.max(x, y)];
    const now = this.friendship(from, to);
    if (now === 'incoming') { this.q.acceptFriend.run(a, b); return 'friend'; }
    if (!now) this.q.insertFriend.run(a, b, x, Date.now());
    return now ?? 'outgoing';
  }
  acceptFriend(userId, otherId) {
    if (this.friendship(userId, otherId) !== 'incoming') return false;
    const [x, y] = [unum(userId), unum(otherId)];
    this.q.acceptFriend.run(Math.min(x, y), Math.max(x, y));
    return true;
  }
  removeFriend(userId, otherId) {
    const [x, y] = [unum(userId), unum(otherId)];
    return this.q.deleteFriend.run(Math.min(x, y), Math.max(x, y)).changes > 0;
  }
  userIdByUsername(username) {
    const r = this.q.userByName.get(String(username).toLowerCase());
    return r ? uid(r.id) : null;
  }

  mutes(userId) { return this.q.mutesOf.all(unum(userId)).map((r) => r.target); }
  setMute(userId, target, muted) { (muted ? this.q.addMute : this.q.removeMute).run(unum(userId), target); }
  isMuted(userId, channelId, serverId) { return !!this.q.isMuted.get(unum(userId), channelId, serverId); }

  // ---------- Placar dos jogos ----------

  // winners: uma pessoa, várias (lista) ou ninguém
  addGameResult(game, winners, playerIds) {
    const list = Array.isArray(winners) ? winners : winners ? [winners] : [];
    this.transaction(() => {
      const { lastInsertRowid } = this.q.insertResult.run(game, list.length === 1 ? unum(list[0]) : null, Date.now());
      for (const id of playerIds) this.q.insertResultPlayer.run(lastInsertRowid, unum(id), list.includes(id) ? 1 : 0);
    });
  }
  // Por jogo: quantas partidas e vitórias
  gameStats(userId) {
    return this.q.statsOf.all(unum(userId)).map((r) => ({ game: r.game, played: r.played, wins: r.wins }));
  }
  leaderboard(since, limit = 10) {
    return this.q.leaderboard.all(since, limit).map((r) => ({ userId: uid(r.user_id), name: r.display_name, wins: r.wins, played: r.played }));
  }

  // ---------- Notificações no celular ----------

  addPushSub(userId, endpoint, keys) { this.q.addPushSub.run(endpoint, unum(userId), JSON.stringify(keys), Date.now()); }
  pushSubs(userId) { return this.q.pushSubsOf.all(unum(userId)).map((r) => ({ endpoint: r.endpoint, keys: JSON.parse(r.keys) })); }
  deletePushSub(endpoint) { this.q.deletePushSub.run(endpoint); }
  deleteUserPushSub(userId, endpoint) { this.q.deleteUserPushSub.run(unum(userId), endpoint); }

  // ---------- Músicas tocadas ----------

  addPlay({ channelId, videoId, title, djId, startedAt }) {
    this.q.insertPlay.run(channelId, videoId, title, unum(djId), startedAt);
  }

  recentPlays(channelId, limit = 10) {
    return this.q.recentPlays.all(channelId, limit).map((r) => ({
      videoId: r.video_id, title: r.title, dj: r.display_name ?? '?', ts: r.started_at,
    }));
  }

  // Página de mensagens (mais antigas que `beforeId`), em ordem cronológica
  messages(channelId, beforeId = Number.MAX_SAFE_INTEGER) {
    const rows = this.q.messagesBefore.all(channelId, beforeId, PAGE_SIZE + 1);
    const hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE).reverse();
    const range = page.length ? [channelId, page[0].id, page[page.length - 1].id] : null;
    const reactionsOf = range ? groupReactions(this.q.reactionsIn.all(...range)) : () => [];
    const votesOf = range ? groupVotes(this.q.votesIn.all(...range)) : () => [];
    return {
      messages: page.map((r) => {
        const msg = { ...toMessage(r), reactions: reactionsOf(r.id) };
        if (msg.meta?.poll) msg.votes = votesOf(r.id);
        return msg;
      }),
      hasMore,
    };
  }

  // ---------- Migração da versão sem banco ----------

  // O primeiro servidor ("home") nasce do channels.json, mantendo os ids dos canais (histórico e salas de voz)
  seedHomeServer(config) {
    let homeId = this.meta('home_server');
    if (homeId && this.server(homeId)) return homeId;
    homeId = this.createServer({ name: config.serverName || 'Muvuca', owner: null, withDefaultChannels: false });
    const textCat = this.createCategory(homeId, 'Canais de texto');
    const voiceCat = this.createCategory(homeId, 'Canais de voz');
    for (const c of config.text ?? []) this.createChannel({ serverId: homeId, type: 'text', name: c.name, id: c.id, categoryId: textCat });
    for (const c of config.voice ?? []) this.createChannel({ serverId: homeId, type: 'voice', name: c.name, id: c.id, categoryId: voiceCat });
    this.setMeta('home_server', homeId);
    return homeId;
  }

  // Importa o histórico antigo (data/chat.json) uma única vez
  importLegacyChat(file) {
    if (this.meta('legacy_chat_imported') || !fs.existsSync(file)) return 0;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const count = this.transaction(() => {
      let n = 0;
      for (const [channelId, list] of Object.entries(saved)) {
        if (!this.channel(channelId)) continue;
        for (const m of list ?? []) {
          this.q.insertMessage.run(channelId, null, String(m.name), String(m.text), Number(m.ts), null, null);
          n++;
        }
      }
      this.setMeta('legacy_chat_imported', new Date().toISOString());
      return n;
    });
    fs.renameSync(file, `${file}.importado`);
    return count;
  }
}
