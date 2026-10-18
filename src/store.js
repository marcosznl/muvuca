// O banco aberto (um só para o servidor todo) e o servidor principal
import fs from 'node:fs/promises';
import path from 'node:path';
import { openDb } from '../db.js';
import { DB_FILE, DATA_DIR, ROOT } from './config.js';

export const db = openDb(DB_FILE);

const legacyConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'channels.json'), 'utf8'));
export const HOME_SERVER = db.seedHomeServer(legacyConfig);
// Salas de DJ: área escondida da qual todo mundo é membro (os canais de música dos servidores viram salas)
export const DJ_SERVER = db.seedDjLobby();

// O soundboard saiu do Muvuca: os arquivos dos sons não servem mais (os backups antigos ainda têm)
await fs.rm(path.join(DATA_DIR, 'sounds'), { recursive: true, force: true });
