#!/bin/zsh
# Muvuca como serviço do macOS (launchd): sobe sozinho ao entrar no Mac, reinicia se cair,
# mantém o Mac acordado enquanto roda e faz backup todo dia às 4h.
#
#   ./server.sh instalar     instala e liga (use no lugar do ./start.sh)
#   ./server.sh status       mostra se está rodando
#   ./server.sh reiniciar    reinicia (ex.: depois de atualizar o servidor)
#   ./server.sh parar        para até o próximo "ligar" (ou até reiniciar o Mac)
#   ./server.sh ligar        liga de novo
#   ./server.sh log          acompanha o log ao vivo (Ctrl+C sai)
#   ./server.sh backup       faz um backup agora
#   ./server.sh local        modo local: só neste Mac (http://localhost:3000), para testar fora de casa
#   ./server.sh publico      volta ao normal (link público para os amigos)
#   ./server.sh desinstalar  remove os serviços (volta a ser só o ./start.sh)
cd "$(dirname "$0")"
DIR=$PWD
UID_=$(id -u)
AGENTS=~/Library/LaunchAgents
APP=muvuca.server
BACKUP=muvuca.server.backup
OLD=(com.marcos.malegna com.marcos.malegna.backup) # nomes antigos dos serviços (removidos ao instalar)
PATH_ENV="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

write_plists() {
  mkdir -p "$AGENTS" logs
  # caffeinate -is: impede o repouso do Mac na tomada enquanto o Muvuca roda
  cat > "$AGENTS/$APP.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$APP</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-is</string>
        <string>/bin/zsh</string>
        <string>$DIR/start.sh</string>
    </array>
    <key>WorkingDirectory</key><string>$DIR</string>
    <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>$PATH_ENV</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>$DIR/logs/server.log</string>
    <key>StandardErrorPath</key><string>$DIR/logs/server.log</string>
</dict>
</plist>
EOF
  cat > "$AGENTS/$BACKUP.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$BACKUP</string>
    <key>ProgramArguments</key>
    <array><string>/bin/zsh</string><string>$DIR/backup.sh</string></array>
    <key>WorkingDirectory</key><string>$DIR</string>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
    <key>StandardOutPath</key><string>$DIR/logs/backup.log</string>
    <key>StandardErrorPath</key><string>$DIR/logs/backup.log</string>
</dict>
</plist>
EOF
  plutil -lint -s "$AGENTS/$APP.plist" "$AGENTS/$BACKUP.plist"
}

loaded() { launchctl print "gui/$UID_/$1" >/dev/null 2>&1; }

case "$1" in
  instalar)
    write_plists || exit 1
    # Serviços com os nomes antigos: sai antes de ligar os novos (senão o Muvuca subiria duas vezes)
    for label in $OLD; do
      loaded $label && launchctl bootout "gui/$UID_/$label"
      rm -f "$AGENTS/$label.plist"
    done
    [[ -f logs/malegna.log && ! -f logs/server.log ]] && mv logs/malegna.log logs/server.log
    for label in $APP $BACKUP; do
      loaded $label && launchctl bootout "gui/$UID_/$label"
      launchctl bootstrap "gui/$UID_" "$AGENTS/$label.plist"
    done
    echo "Instalado. O Muvuca sobe sozinho ao entrar no Mac e reinicia se cair. Backup diário às 4h."
    ;;
  desinstalar)
    for label in $APP $BACKUP; do
      loaded $label && launchctl bootout "gui/$UID_/$label"
      rm -f "$AGENTS/$label.plist"
    done
    echo "Serviços removidos. Para ligar à mão: ./start.sh"
    ;;
  parar)    launchctl bootout "gui/$UID_/$APP" && echo "Parado." ;;
  ligar)    loaded $APP || launchctl bootstrap "gui/$UID_" "$AGENTS/$APP.plist"; echo "Ligado." ;;
  reiniciar) launchctl kickstart -k "gui/$UID_/$APP" && echo "Reiniciando…" ;;
  backup)   ./backup.sh ;;
  local)
    touch .modo-local
    launchctl kickstart -k "gui/$UID_/$APP" && echo "Modo local: abra http://localhost:3000 (só neste Mac). Para voltar: ./server.sh publico"
    ;;
  publico)
    rm -f .modo-local
    launchctl kickstart -k "gui/$UID_/$APP" && echo "Modo público: o link dos amigos volta a funcionar (em casa, com as portas do roteador)."
    ;;
  log)      tail -n 40 -f logs/server.log ;;
  status)
    if loaded $APP; then
      launchctl print "gui/$UID_/$APP" | grep -E '^\s+(state|pid|last exit code) ='
      [[ -f .modo-local ]] && echo "	MODO LOCAL (só http://localhost:3000)" || echo "	modo público"
    else
      echo "Serviço não instalado ou parado."
    fi
    ls -1t ~/Backups/Muvuca/malegna-*.tar.gz(N) 2>/dev/null | head -1 | sed 's/^/Último backup: /'
    ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
