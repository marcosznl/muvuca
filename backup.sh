#!/bin/zsh
# Backup do Muvuca: banco de dados (cópia consistente, mesmo com o site no ar), emojis e fotos.
# Além da cópia local, manda uma para o iCloud Drive (pasta "Muvuca Backups", as 7 mais recentes).
# Fica só o backup mais recente em data/backups/; os anteriores são apagados
# depois que o novo é conferido (se o novo sair com defeito, os antigos ficam).
# Roda sozinho todo dia às 4h (serviço com.marcos.malegna.backup) ou à mão: ./backup.sh
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

DEST=data/backups
name="malegna-$(date +%F_%H%M).tar.gz"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$DEST"

# Cópia do banco + conferência de integridade (VACUUM INTO não trava quem está usando o site)
if ! node --input-type=module -e "
  import { DatabaseSync } from 'node:sqlite';
  const live = new DatabaseSync('data/malegna.db');
  live.exec(\"VACUUM INTO '$work/malegna.db'\");
  live.close();
  const copy = new DatabaseSync('$work/malegna.db', { readOnly: true });
  const ok = copy.prepare('PRAGMA integrity_check').get().integrity_check;
  if (ok !== 'ok') { console.error('integridade:', ok); process.exit(1); }
"; then
  echo "[backup $(date '+%F %T')] FALHOU ao copiar o banco; os backups anteriores foram mantidos"
  exit 1
fi

# Emojis e fotos de perfil/ícones, e a chave das notificações (sem ela, os celulares teriam que ativar de novo)
for dir in emojis images; do
  [[ -d "data/$dir" ]] && cp -R "data/$dir" "$work/"
done
[[ -f data/vapid.json ]] && cp data/vapid.json "$work/"

tar -czf "$DEST/$name.tmp" -C "$work" . && tar -tzf "$DEST/$name.tmp" >/dev/null || {
  rm -f "$DEST/$name.tmp"
  echo "[backup $(date '+%F %T')] FALHOU ao compactar; os backups anteriores foram mantidos"
  exit 1
}
mv "$DEST/$name.tmp" "$DEST/$name"

# O novo está bom: apaga os anteriores (e as cópias manuais antigas da pasta data/)
find "$DEST" -name 'malegna-*.tar.gz' ! -name "$name" -delete
rm -f data/malegna-antes-*.db(N) data/backup-antes-*.db(N)

# Logs do serviço: acima de 20 MB, guarda só o último pedaço
for log in logs/*.log(N); do
  if (( $(stat -f %z "$log") > 20 * 1024 * 1024 )); then
    # reescreve o mesmo arquivo (o serviço continua escrevendo nele)
    tail -c 5000000 "$log" > "$log.tmp" && cat "$log.tmp" > "$log"; rm -f "$log.tmp"
  fi
done

# Cópia fora do Mac: iCloud Drive (se o disco do Mac morrer, o backup sobrevive). Guarda os 7 mais recentes.
CLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Muvuca Backups"
cloud_note=""
if [[ -d "$HOME/Library/Mobile Documents/com~apple~CloudDocs" ]]; then
  if mkdir -p "$CLOUD" && cp "$DEST/$name" "$CLOUD/$name.tmp" && mv "$CLOUD/$name.tmp" "$CLOUD/$name"; then
    # Só apaga dentro da pasta do iCloud, e só arquivos malegna-*.tar.gz (os mais antigos além dos 7)
    old_ones=("$CLOUD"/malegna-*.tar.gz(N.Om))
    (( ${#old_ones} > 7 )) && rm -f -- "${old_ones[@]:0:${#old_ones}-7}"
    cloud_note=" + cópia no iCloud"
  else
    rm -f "$CLOUD/$name.tmp"
    cloud_note=" (AVISO: não deu para copiar para o iCloud)"
  fi
fi

echo "[backup $(date '+%F %T')] ok: $DEST/$name ($(du -h "$DEST/$name" | cut -f1))$cloud_note"
