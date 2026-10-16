#!/bin/zsh
# Backup do Muvuca: banco de dados (cópia consistente, mesmo com o site no ar), emojis, fotos
# e a chave das notificações, num .tar.gz em ~/Backups/Muvuca (fora da pasta do projeto).
# Os anexos do chat (fotos, vídeos, documentos) vão para ~/Backups/Muvuca/anexos, só os novos a cada vez.
# Histórico: os 3 mais recentes, 1 por dia nos últimos 14 dias e 1 por mês nos últimos 6 meses
# (os anteriores só são apagados depois que o novo é conferido; se o novo sair com defeito, nada é apagado).
# Roda sozinho todo dia às 4h (serviço com.marcos.malegna.backup) ou à mão: ./backup.sh
umask 077 # backups (banco, chaves) só legíveis pelo seu usuário
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

DEST="$HOME/Backups/Muvuca"
name="malegna-$(date +%F_%H%M).tar.gz"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$DEST" || { echo "[backup $(date '+%F %T')] FALHOU: não deu para criar $DEST"; exit 1; }

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

# Histórico: mantém os 3 mais recentes, o último de cada um dos 14 dias mais recentes e o último de cada
# um dos 6 meses mais recentes; apaga o resto. Só mexe em arquivos malegna-AAAA-MM-DD_HHMM.tar.gz dentro
# da pasta pedida, a partir de uma lista explícita (nunca de "ls"), conferindo o caminho de cada um.
prune_history() {
  local dir=$1 f b day month i=0 keep
  local -A days months
  local -a files del
  files=("$dir"/malegna-<->-<->-<->_<->.tar.gz(N.On)) # do mais novo para o mais antigo (pelo nome)
  for f in $files; do
    b=${f:t}
    day=${b[9,18]}
    month=${b[9,15]}
    keep=0
    (( i < 3 )) && keep=1
    if [[ -z ${days[$day]} ]]; then days[$day]=1; (( ${#days} <= 14 )) && keep=1; fi
    if [[ -z ${months[$month]} ]]; then months[$month]=1; (( ${#months} <= 6 )) && keep=1; fi
    (( keep )) || del+=("$f")
    (( i++ ))
  done
  for f in $del; do
    [[ $f == "$dir"/malegna-<->-<->-<->_<->.tar.gz && -f $f ]] && rm -f -- "$f"
  done
}
prune_history "$DEST"
rm -f data/malegna-antes-*.db(N) data/backup-antes-*.db(N) # cópias manuais antigas da pasta data/

# Anexos do chat: espelho que só acrescenta (copia os novos; nunca apaga nada lá, mesmo se sumirem daqui)
note=""
if [[ -d data/files ]]; then
  mkdir -p "$DEST/anexos" && rsync -a --ignore-existing data/files/ "$DEST/anexos/" \
    && note=" + anexos" || note=" (AVISO: anexos não copiados)"
fi

# Logs do serviço: acima de 20 MB, guarda só o último pedaço
for log in logs/*.log(N); do
  if (( $(stat -f %z "$log") > 20 * 1024 * 1024 )); then
    # reescreve o mesmo arquivo (o serviço continua escrevendo nele)
    tail -c 5000000 "$log" > "$log.tmp" && cat "$log.tmp" > "$log"; rm -f "$log.tmp"
  fi
done

kept=("$DEST"/malegna-<->-<->-<->_<->.tar.gz(N))
echo "[backup $(date '+%F %T')] ok: $DEST/$name ($(du -h "$DEST/$name" | cut -f1))$note · ${#kept} no histórico"
