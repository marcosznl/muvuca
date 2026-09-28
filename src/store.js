// O banco aberto (um só para o servidor todo) e o servidor principal
import fs from 'node:fs/promises';
import path from 'node:path';
import { openDb } from '../db.js';
import { DB_FILE, DATA_DIR, ROOT } from './config.js';

export const db = openDb(DB_FILE);

const legacyConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'channels.json'), 'utf8'));
export const HOME_SERVER = db.seedHomeServer(legacyConfig);

// O histórico antigo fica ao lado do banco (assim um banco de teste nunca mexe no arquivo real)
const imported = db.importLegacyChat(path.join(DATA_DIR, 'chat.json'));
if (imported) console.log(`Histórico antigo importado: ${imported} mensagens`);
