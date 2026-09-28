#!/bin/zsh
# Atualiza o DuckDNS com o IPv4 público da casa e o IPv6 fixo ("secured") do Mac.
# Uso: ./ddns-update.sh           -> atualiza uma vez
#      ./ddns-update.sh --loop    -> atualiza a cada 5 minutos
cd "$(dirname "$0")"
set -a; source .env; set +a

if [[ -z "$DUCKDNS_SUBDOMAIN" || -z "$DUCKDNS_TOKEN" ]]; then
  echo "[ddns] DUCKDNS_SUBDOMAIN/DUCKDNS_TOKEN não definidos no .env, pulando."
  exit 0
fi

api="https://www.duckdns.org/update?domains=$DUCKDNS_SUBDOMAIN&token=$DUCKDNS_TOKEN"
last=""
last4=""
while true; do
  ip6=$(ifconfig | awk '/inet6 2/ && /secured/ { print $2; exit }')
  ip4=$(curl -4 -s --max-time 10 https://api.ipify.org)
  [[ "$ip4" =~ '^[0-9.]+$' ]] || ip4=""
  current="$ip4 $ip6"
  # Mudou de rede (outro IPv4 público): sai para o start.sh reiniciar tudo — o LiveKit
  # só descobre o IP público ao ligar, e com o IP velho as chamadas não conectam
  if [[ "$1" == --loop && -n "$last4" && -n "$ip4" && "$ip4" != "$last4" ]]; then
    echo "[ddns] IP público mudou ($last4 -> $ip4): reiniciando para usar o novo"
    exit 3
  fi
  [[ -n "$ip4" ]] && last4=$ip4
  if [[ -z "$ip4$ip6" ]]; then
    echo "[ddns] nenhum IP público encontrado"
  elif [[ "$current" != "$last" ]]; then
    # Limpa e grava os dois (o pedido vai por IPv6 para o DuckDNS não adivinhar o IPv4 sozinho)
    cleared=$(curl -s --max-time 15 "$api&clear=true")
    res=$(curl -6 -s --max-time 15 "$api&ip=$ip4&ipv6=$ip6")
    if [[ "$cleared" == OK* && "$res" == OK* ]]; then
      echo "[ddns] ${DUCKDNS_SUBDOMAIN//,/, } (.duckdns.org) -> IPv4 ${ip4:-nenhum} | IPv6 ${ip6:-nenhum}"
      last=$current
    else
      echo "[ddns] falha ao atualizar (respostas: $cleared / $res)"
    fi
  fi
  [[ "$1" == "--loop" ]] || break
  sleep 300
done
