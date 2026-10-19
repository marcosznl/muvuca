#!/bin/zsh
# Backup do Muvuca: banco de dados (cópia consistente, mesmo com o site no ar), emojis, fotos
# e a chave das notificações, num .tar.gz em ~/Backups/Muvuca (fora da pasta do projeto).
# Os anexos do chat (fotos, vídeos, documentos) vão para ~/Backups/Muvuca/anexos, um espelho de data/files.
# Guarda só um backup: o anterior é apagado depois que o novo é conferido (se o novo sair com defeito,
# o anterior fica).
# Roda sozinho todo dia às 4h (serviço muvuca.server.backup) ou à mão: ./backup.sh
umask 077 # backups (banco, chaves) só legíveis pelo seu usuário
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

DEST="$HOME/Backups/Muvuca"
name="muvuca-$(date +%F_%H%M).tar.gz"
# O banco se chamava malegna.db (o servidor renomeia ao subir)
dbfile=data/muvuca.db
[[ ! -f $dbfile && -f data/malegna.db ]] && dbfile=data/malegna.db
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$DEST" || { echo "[backup $(date '+%F %T')] FALHOU: não deu para criar $DEST"; exit 1; }

# Cópia do banco + conferência de integridade (VACUUM INTO não trava quem está usando o site)
if ! node --input-type=module -e "
  import { DatabaseSync } from 'node:sqlite';
  const live = new DatabaseSync('$dbfile');
  live.exec(\"VACUUM INTO '$work/muvuca.db'\");
  live.close();
  const copy = new DatabaseSync('$work/muvuca.db', { readOnly: true });
  const ok = copy.prepare('PRAGMA integrity_check').get().integrity_check;
  if (ok !== 'ok') { console.error('integridade:', ok); process.exit(1); }
"; then
  echo "[backup $(date '+%F %T')] FALHOU ao copiar o banco; os backups anteriores foram mantidos"
  exit 1
fi

# Emojis, fotos de perfil/ícones e a chave das notificações
# (sem ela, os celulares teriam que ativar as notificações de novo)
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

# Um backup só: apaga os outros muvuca-AAAA-MM-DD_HHMM.tar.gz (e os malegna-… de antes do nome novo) da pasta (lista explícita, nunca de "ls",
# conferindo o caminho de cada um), depois que o novo já foi conferido
keep_only_latest() {
  local dir=$1 newest=$2 f
  for f in "$dir"/(muvuca|malegna)-<->-<->-<->_<->.tar.gz(N); do
    [[ $f != "$newest" && $f == "$dir"/(muvuca|malegna)-<->-<->-<->_<->.tar.gz && -f $f ]] && rm -f -- "$f"
  done
}
keep_only_latest "$DEST" "$DEST/$name"

# Anexos do chat: espelho de data/files (o que foi apagado aqui sai de lá também). Se data/files estiver
# vazia, não espelha: pode ser a pasta que sumiu, e aí o espelho apagaria a única cópia
note=""
if [[ -d data/files && -n $(print -l data/files/*(N[1])) ]]; then
  mkdir -p "$DEST/anexos" && rsync -a --delete data/files/ "$DEST/anexos/" \
    && note=" + anexos" || note=" (AVISO: anexos não copiados)"
fi

# Logs do serviço: acima de 20 MB, guarda só o último pedaço
for log in logs/*.log(N); do
  if (( $(stat -f %z "$log") > 20 * 1024 * 1024 )); then
    # reescreve o mesmo arquivo (o serviço continua escrevendo nele)
    tail -c 5000000 "$log" > "$log.tmp" && cat "$log.tmp" > "$log"; rm -f "$log.tmp"
  fi
done

echo "[backup $(date '+%F %T')] ok: $DEST/$name ($(du -h "$DEST/$name" | cut -f1))$note"
