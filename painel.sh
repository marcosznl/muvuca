#!/bin/zsh
# Painel administrativo do Muvuca (https://painel.<seu domínio>): serviço próprio do macOS (launchd),
# separado do Muvuca — continua no ar quando o Muvuca cai, e mostra isso.
#
#   ./painel.sh senha        cria ou troca o usuário e a senha do painel (tira todo mundo do painel)
#   ./painel.sh instalar     instala e liga (sobe sozinho ao entrar no Mac e reinicia se cair)
#   ./painel.sh status       mostra se está rodando
#   ./painel.sh reiniciar    reinicia (ex.: depois de atualizar o painel)
#   ./painel.sh parar        para até o próximo "ligar"
#   ./painel.sh ligar        liga de novo
#   ./painel.sh log          acompanha o log ao vivo (Ctrl+C sai)
#   ./painel.sh desinstalar  remove o serviço
umask 077
cd "$(dirname "$0")"
DIR=$PWD
UID_=$(id -u)
AGENTS=~/Library/LaunchAgents
LABEL=muvuca.painel
OLD_LABEL=com.marcos.muvuca.painel # nome antigo (removido ao instalar)
PLIST="$AGENTS/$LABEL.plist"
NODE=$(command -v node || echo /opt/homebrew/bin/node)
loaded() { launchctl print "gui/$UID_/$LABEL" >/dev/null 2>&1; }

case "$1" in
  senha)
    mkdir -p data
    print -n "Usuário do painel: "; read -r user
    if [[ ! "$user" =~ '^[A-Za-z0-9_.-]{3,32}$' ]]; then echo "Use de 3 a 32 letras, números, ponto, - ou _."; exit 1; fi
    print -n "Senha (mínimo 12 caracteres; não aparece enquanto digita): "; read -rs pass; echo
    print -n "Repita a senha: "; read -rs pass2; echo
    if [[ "$pass" != "$pass2" ]]; then echo "As senhas não conferem."; exit 1; fi
    if (( ${#pass} < 12 )); then echo "A senha precisa ter pelo menos 12 caracteres."; exit 1; fi
    # A senha vai pela entrada padrão (nunca na linha de comando, que outros programas conseguem ver)
    printf '%s\n%s' "$user" "$pass" | "$NODE" --input-type=module -e "
      import crypto from 'node:crypto';
      import fs from 'node:fs';
      const [user, ...rest] = fs.readFileSync(0, 'utf8').split('\n');
      const password = rest.join('\n');
      const salt = crypto.randomBytes(16);
      const params = { N: 2 ** 16, r: 8, p: 1 };
      const hash = crypto.scryptSync(password, salt, 64, { ...params, maxmem: 256 * 1024 * 1024 });
      const data = { user, salt: salt.toString('hex'), hash: hash.toString('hex'), ...params, updatedAt: new Date().toISOString() };
      fs.writeFileSync('data/painel-auth.json.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync('data/painel-auth.json.tmp', 'data/painel-auth.json');
    " || { echo "Não deu para salvar."; exit 1; }
    unset pass pass2
    chmod 600 data/painel-auth.json
    echo "Pronto. Usuário e senha do painel salvos (só o hash, em data/painel-auth.json)."
    echo "Quem estava com o painel aberto precisa entrar de novo."
    ;;
  instalar)
    mkdir -p "$AGENTS" logs
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>$NODE</string><string>$DIR/painel/server.js</string></array>
    <key>WorkingDirectory</key><string>$DIR</string>
    <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>Umask</key><integer>63</integer>
    <key>StandardOutPath</key><string>$DIR/logs/painel.log</string>
    <key>StandardErrorPath</key><string>$DIR/logs/painel.log</string>
</dict>
</plist>
EOF
    plutil -lint -s "$PLIST" || exit 1
    # Serviço com o nome antigo: sai antes (senão o painel subiria duas vezes)
    launchctl print "gui/$UID_/$OLD_LABEL" >/dev/null 2>&1 && launchctl bootout "gui/$UID_/$OLD_LABEL"
    rm -f "$AGENTS/$OLD_LABEL.plist"
    loaded && launchctl bootout "gui/$UID_/$LABEL"
    launchctl bootstrap "gui/$UID_" "$PLIST"
    echo "Painel instalado (http://127.0.0.1:3002 neste Mac; pela internet em https://painel.<seu domínio>)."
    [[ -f data/painel-auth.json ]] || echo "Falta criar o login: ./painel.sh senha"
    ;;
  desinstalar)
    loaded && launchctl bootout "gui/$UID_/$LABEL"
    rm -f "$PLIST"
    echo "Serviço do painel removido."
    ;;
  status)
    if loaded; then launchctl print "gui/$UID_/$LABEL" | grep -E '^\s+(state|pid) ='; else echo "Painel não instalado (./painel.sh instalar)."; fi
    ;;
  reiniciar) launchctl kickstart -k "gui/$UID_/$LABEL" && echo "Reiniciando o painel…" ;;
  parar)     launchctl bootout "gui/$UID_/$LABEL" && echo "Painel parado (./painel.sh ligar para voltar)." ;;
  ligar)     launchctl bootstrap "gui/$UID_" "$PLIST" && echo "Painel ligado." ;;
  log)       tail -f logs/painel.log ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
