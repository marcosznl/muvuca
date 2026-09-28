// Configuração (vem do .env via start.sh) e limites do app
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.PORT || 3000);
// Só o Caddy (no mesmo Mac) conversa com este servidor
export const HOST = process.env.HOST || '127.0.0.1';
// Credenciais do LiveKit
export const API_KEY = process.env.LIVEKIT_API_KEY;
export const API_SECRET = process.env.LIVEKIT_API_SECRET;
export const LIVEKIT_HTTP_URL = process.env.LIVEKIT_HTTP_URL || 'http://127.0.0.1:7880';
// Endereço público do LiveKit; se vazio, usa o mesmo host da página na porta 7880 (modo local)
export const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
// Código de acesso: quem cria conta com ele entra no servidor principal
export const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
export const OWNER_USERNAME = process.env.OWNER_USERNAME || '';
export const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'malegna.db');
// Emojis, fotos e anexos ficam ao lado do banco (um banco de teste nunca mexe nos arquivos reais)
export const DATA_DIR = path.dirname(DB_FILE);
export const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(ROOT, 'public'));
export const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
export const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';

export const LIMITS = {
  serversOwned: 10,
  channelsPerType: 30,
  categories: 20,
  roles: 30,
  msgLength: 2000,
  serverName: 40,
  channelName: 30,
  roleName: 30,
};
export const MSG_RATE = { count: 5, windowMs: 5000 };      // até 5 mensagens a cada 5s
export const ACTION_RATE = { count: 20, windowMs: 10_000 }; // ações de gerenciamento
export const VOICE_POLL_MS = 1500;

if (!API_KEY || !API_SECRET) throw new Error('Defina LIVEKIT_API_KEY e LIVEKIT_API_SECRET no .env');
if (!ACCESS_PASSWORD) throw new Error('Defina ACCESS_PASSWORD no .env');
