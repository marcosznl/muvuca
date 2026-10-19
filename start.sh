#!/bin/zsh
# Sobe o servidor de mídia (LiveKit), o app e o HTTPS (Caddy). Ctrl+C encerra tudo.
cd "$(dirname "$0")"
set -a; source .env; set +a

if lsof -nP -iTCP:3000 -iTCP:7881 -iTCP:443 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "O Muvuca (ou outro programa) já está usando as portas 443/3000/7881."
  echo "Feche a outra cópia antes (Ctrl+C na janela onde ela roda)."
  exit 1
fi
# Com DuckDNS configurado, o endereço público passa a ser o domínio fixo.
# Aceita vários separados por vírgula (ex.: "minha-turma,turma-antiga"): o primeiro é o principal,
# os outros continuam funcionando (links antigos)
domains=()
if [[ -n "$DUCKDNS_SUBDOMAIN" ]]; then
  for sub in ${(s:,:)DUCKDNS_SUBDOMAIN}; do domains+=("${sub// /}.duckdns.org"); done
  export DOMAIN="${domains[1]}"
else
  domains=("$DOMAIN")
fi
# O site atende na 443 (IPv6 e certificado) e, se definida, numa porta extra para o IPv4
addrs=()
for d in $domains; do
  addrs+=("$d")
  [[ -n "$PUBLIC_PORT" && "$PUBLIC_PORT" != 443 ]] && addrs+=("$d:$PUBLIC_PORT")
done
export SITE_ADDRESSES="${(j:, :)addrs}"
# Painel administrativo: painel.<domínio principal> (e na porta extra do IPv4)
paddrs=("painel.$DOMAIN")
[[ -n "$PUBLIC_PORT" && "$PUBLIC_PORT" != 443 ]] && paddrs+=("painel.$DOMAIN:$PUBLIC_PORT")
export PAINEL_ADDRESSES="${(j:, :)paddrs}"
PUBLIC_URL="https://$DOMAIN"
[[ -n "$PUBLIC_PORT" && "$PUBLIC_PORT" != 443 ]] && PUBLIC_URL="https://$DOMAIN:$PUBLIC_PORT"
export LIVEKIT_URL="${PUBLIC_URL/https:/wss:}"

# O banco usa o SQLite embutido no Node, que só funciona sem configuração extra a partir do 22.13
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'; then
  echo "[$(date '+%F %T')] Node $(node -v 2>/dev/null || echo 'não encontrado'): o Muvuca precisa do 22.13 ou mais novo (brew upgrade node)"
  sleep 60 # rodando como serviço, evita tentar de novo a cada 10 s
  exit 1
fi

pids=()
trap 'kill $pids 2>/dev/null' EXIT INT TERM

# Configuração do LiveKit com o domínio e a pasta dos certificados do Caddy preenchidos (livekit.yaml é o modelo)
mkdir -p logs
CADDY_CERTS="${CADDY_CERTS:-$HOME/Library/Application Support/Caddy/certificates/acme-v02.api.letsencrypt.org-directory}"
sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__CADDY_CERTS__|$CADDY_CERTS|g" livekit.yaml > logs/livekit.yaml

# Voz (LiveKit) numa função: o painel pode pedir para reiniciar só ela (ver o laço lá embaixo)
lk_config=logs/livekit.yaml
lk_pid=
start_livekit() {
  LIVEKIT_KEYS="$LIVEKIT_API_KEY: $LIVEKIT_API_SECRET" \
    livekit-server --config "$lk_config" --bind 127.0.0.1 &
  lk_pid=$!
  pids+=($lk_pid)
}

# Modo local (./server.sh local): só neste Mac, em http://localhost:3000 — para testar
# fora de casa. Sem HTTPS nem DNS, e a voz anuncia os IPs da rede local em vez do IP público.
if [[ -f .modo-local ]]; then
  sed 's/use_external_ip: true/use_external_ip: false/' logs/livekit.yaml > logs/livekit-local.yaml
  lk_config=logs/livekit-local.yaml
  start_livekit
  unset LIVEKIT_URL # o app entrega ws://localhost:7880 para quem abre pelo localhost
  PUBLIC_URL="http://localhost:3000"
  echo "[$(date '+%F %T')] MODO LOCAL: só neste Mac"
else
  # API/sinalização do LiveKit só na máquina local (o Caddy expõe via HTTPS);
  # as portas de mídia (7881 TCP e 50000-50200 UDP) ficam abertas para a internet.
  start_livekit

  # Também avisa quando o IP público muda (Mac em outra rede): aí tudo reinicia com o endereço novo
  ./ddns-update.sh --loop &
  pids+=($!)

  caddy run --config Caddyfile --adapter caddyfile &
  pids+=($!)
fi

node server.js &
pids+=($!)

echo "Link para os amigos: $PUBLIC_URL/"
# Se qualquer parte cair (voz, HTTPS, DNS ou o app), encerra tudo: rodando como serviço,
# o macOS sobe tudo de novo em seguida (ver server.sh)
while sleep 5; do
  # Painel pediu "reiniciar só a voz": relança só o LiveKit. As calls caem por uns segundos e voltam
  # sozinhas; o chat, os jogos e a música continuam (o resto não reinicia)
  if [[ -f logs/.reiniciar-voz ]]; then
    rm -f logs/.reiniciar-voz
    echo "[$(date '+%F %T')] reiniciando só a voz (LiveKit), a pedido do painel"
    old=$lk_pid
    pids=(${pids:#$old})
    kill $old 2>/dev/null
    for i in {1..20}; do kill -0 $old 2>/dev/null || break; sleep 0.5; done
    kill -9 $old 2>/dev/null
    start_livekit
  fi
  for pid in $pids; do
    if ! kill -0 $pid 2>/dev/null; then
      echo "[$(date '+%F %T')] um dos processos ($pid) parou; encerrando para reiniciar tudo"
      exit 1
    fi
  done
done
