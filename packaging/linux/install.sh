#!/usr/bin/env bash
# HyperPlayer installer: the server (in Docker or as a systemd service), the player, or both.
#
#   sudo ./install.sh              the wizard
#   sudo ./install.sh --uninstall  removes the server and/or player (keeps the music and, if asked, the data)
#
# Runs from the unpacked release bundle: server/ (bundled, with its own Node.js),
# docker/Dockerfile, systemd/, player/*.deb.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo dev)"
PREFIX=/opt/hyperplayer
CONFIG_DIR=/etc/hyperplayer
ENV_FILE=$CONFIG_DIR/server.env
MODE_FILE=$CONFIG_DIR/install-mode
# SMB shares the Docker container mounts: one per line, fields separated by the ASCII unit
# separator (it keeps empty fields apart, unlike a tab):
# name, //server/share, folder inside it, username (empty: guest), password, SMB version.
SMB_FILE=$CONFIG_DIR/smb-shares
DATA_DIR=/var/lib/hyperplayer
SERVICE=hyperplayer-server
USER_NAME=hyperplayer

# ------------------------------------------------------------------ prompts

if [[ -t 1 ]]; then
  BOLD=$'\e[1m' DIM=$'\e[2m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RED=$'\e[31m' RESET=$'\e[0m'
else
  BOLD="" DIM="" GREEN="" YELLOW="" RED="" RESET=""
fi

say() { printf '%s\n' "$*"; }
title() { printf '\n%s%s%s\n' "$BOLD" "$*" "$RESET"; }
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() {
  printf '%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2
  exit 1
}

# ask VAR "Question" [default]
ask() {
  local answer prompt="$2"
  [[ -n "${3:-}" ]] && prompt+=" ${DIM}[$3]${RESET}"
  read -r -p "$prompt: " answer </dev/tty
  printf -v "$1" '%s' "${answer:-${3:-}}"
}

# ask_secret VAR "Question" — not echoed; empty keeps the current value ($3).
ask_secret() {
  local answer prompt="$2"
  [[ -n "${3:-}" ]] && prompt+=" ${DIM}[keep current]${RESET}"
  read -r -s -p "$prompt: " answer </dev/tty
  echo
  printf -v "$1" '%s' "${answer:-${3:-}}"
}

# choose VAR "Question" "Option 1" "Option 2" ... — sets VAR to the chosen number (1-based).
choose() {
  local var=$1 question=$2 i answer
  shift 2
  say "$question"
  for i in $(seq 1 $#); do say "  $i) ${!i}"; done
  while true; do
    read -r -p "Choose 1-$#: " answer </dev/tty
    answer=${answer:-1}
    if [[ "$answer" =~ ^[0-9]+$ ]] && ((answer >= 1 && answer <= $#)); then
      printf -v "$var" '%s' "$answer"
      return
    fi
  done
}

# confirm "Question" [y|n]
confirm() {
  local answer hint="y/N"
  [[ "${2:-n}" == y ]] && hint="Y/n"
  read -r -p "$1 [$hint]: " answer </dev/tty
  answer=${answer:-${2:-n}}
  [[ "$answer" =~ ^[Yy] ]]
}

# --------------------------------------------------------------- settings

# Current value of a setting in the env file (single-quoted values, as we write them).
setting() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^$1='\(.*\)'\$/\1/p" "$ENV_FILE" | tail -1
}

quote() {
  [[ "$1" == *"'"* ]] && die "Settings can't contain single quotes: $1"
  printf "'%s'" "$1"
}

host_names() {
  { hostname -f 2>/dev/null || true; hostname 2>/dev/null || true; hostname -I 2>/dev/null | tr ' ' '\n' || true; } |
    grep -v -e '^$' -e '^127\.' -e '^::1$' -e '^fe80:' -e '^172\.1[7-9]\.' -e '^172\.2[0-9]\.' | sort -u | paste -sd, -
}

# ------------------------------------------------------------------ checks

need_root() {
  if [[ $EUID -ne 0 ]]; then
    say "The installer needs administrator rights; asking sudo."
    exec sudo bash "$0" "$@"
  fi
}

have_docker() { command -v docker >/dev/null && docker compose version >/dev/null 2>&1; }

installed_mode() { [[ -f "$MODE_FILE" ]] && cat "$MODE_FILE" || true; }

# --------------------------------------------------------------- the server

configure_server() {
  local mode=$1
  title "Server settings"

  local library="" port tls names cert key lfkey lfsecret
  local current_local
  # The folders on this machine (SMB shares, under /smb, are asked for separately).
  current_local=$(setting HP_LIBRARY | tr ':' '\n' | grep -v '^/smb/' | paste -sd: - || true)
  say "Music folders on this machine, separated by ':' (e.g. /srv/music:/mnt/nas/Music). They're only read."
  [[ "$mode" == docker ]] && say "Leave it empty if all the music is on SMB shares (asked next)."
  while true; do
    ask library "Music folders" "$current_local"
    [[ -n "$library" || "$mode" == docker ]] || continue
    local missing=0 dir
    IFS=: read -r -a dirs <<<"$library"
    for dir in "${dirs[@]}"; do
      [[ -d "$dir" ]] || {
        warn "$dir doesn't exist (yet)."
        missing=1
      }
    done
    ((missing == 0)) || confirm "Use these folders anyway?" n && break
  done

  if [[ "$mode" == docker ]]; then
    configure_smb
    local share
    while IFS=$'\037' read -r share _ _ _ _ _; do
      library+="${library:+:}$(smb_library_path "$share")"
    done < <(smb_shares)
  else
    say "${DIM}SMB/NFS shares: mount them on this machine (e.g. in /etc/fstab) and list their folders above.${RESET}"
    rm -f "$SMB_FILE"
  fi
  [[ -n "$library" ]] || die "No music folders or shares: nothing to play."

  while true; do
    ask port "Port" "$(setting HP_PORT || true)"
    port=${port:-4533}
    [[ "$port" =~ ^[0-9]+$ ]] && ((port > 0 && port < 65536)) && break
  done

  local tls_choice
  choose tls_choice "HTTPS:" \
    "Self-signed certificate (made by the server; players ask you to trust it once)" \
    "My own certificate files (PEM, e.g. from Let's Encrypt)" \
    "Off: a reverse proxy in front does HTTPS"
  case $tls_choice in
  1)
    tls=on
    say "The certificate names this server so other software can check it."
    local detected
    detected=$(setting HP_TLS_NAMES)
    [[ -n "$detected" ]] || detected=$(host_names)
    ask names "Host names and addresses clients use (comma-separated)" "$detected"
    ;;
  2)
    tls=on
    while true; do
      ask cert "Certificate file (fullchain.pem)" "$(setting HP_TLS_CERT)"
      ask key "Private key file (privkey.pem)" "$(setting HP_TLS_KEY)"
      [[ -r "$cert" && -r "$key" ]] && break
      warn "Can't read those files."
    done
    ;;
  3) tls=off ;;
  esac

  say "Last.fm scrobbling needs a Last.fm API account (https://www.last.fm/api/account/create)."
  ask lfkey "Last.fm API key (empty: no Last.fm)" "$(setting HP_LASTFM_API_KEY)"
  lfsecret=""
  [[ -n "$lfkey" ]] && ask_secret lfsecret "Last.fm shared secret" "$(setting HP_LASTFM_SECRET)"

  mkdir -p "$CONFIG_DIR"
  {
    echo "# HyperPlayer server settings (see the README). Written by install.sh; edit and restart the server."
    echo "HP_LIBRARY=$(quote "$library")"
    echo "HP_PORT=$(quote "$port")"
    echo "HP_HOST='0.0.0.0'"
    echo "HP_TLS=$(quote "$tls")"
    [[ -n "${names:-}" ]] && echo "HP_TLS_NAMES=$(quote "$names")"
    [[ -n "${cert:-}" ]] && echo "HP_TLS_CERT=$(quote "$cert")" && echo "HP_TLS_KEY=$(quote "$key")"
    # Behind a proxy: client addresses (for sign-in limits) come from X-Forwarded-For.
    [[ "$tls" == off ]] && echo "HP_TRUST_PROXY='true'"
    if [[ -n "$lfkey" ]]; then
      echo "HP_LASTFM_API_KEY=$(quote "$lfkey")"
      echo "HP_LASTFM_SECRET=$(quote "$lfsecret")"
    fi
  } >"$ENV_FILE.new"
  chmod 640 "$ENV_FILE.new"
  chown root:"$USER_NAME" "$ENV_FILE.new"
  mv "$ENV_FILE.new" "$ENV_FILE"
  ok "Settings saved in $ENV_FILE"
}

smb_shares() { [[ -f "$SMB_FILE" ]] && cat "$SMB_FILE" || true; }

# Where a share's music is inside the container.
smb_library_path() {
  local name=$1 sub
  sub=$(smb_shares | awk -F'\037' -v n="$name" '$1 == n { print $3 }')
  printf '/smb/%s%s' "$name" "${sub:+/${sub#/}}"
}

configure_smb() {
  local keep=0
  if [[ -s "$SMB_FILE" ]]; then
    say "SMB shares:"
    smb_shares | awk -F'\037' '{ printf "  %s%s%s\n", $2, ($3 != "" ? "/" $3 : ""), ($4 != "" ? " (as " $4 ")" : " (guest)") }'
    confirm "Keep these shares?" y && keep=1
  fi
  ((keep)) || {
    mkdir -p "$CONFIG_DIR"
    : >"$SMB_FILE"
  }
  chmod 600 "$SMB_FILE"
  say "The container can mount SMB shares itself (e.g. a NAS), read-only."
  say "${DIM}If Docker runs in an unprivileged Proxmox LXC, it can't: mount the share on the Proxmox host instead and pass the folder into the LXC.${RESET}"
  local unc sub user pass vers n
  while confirm "Add an SMB share?" n; do
    while true; do
      ask unc "Share, as //server/share" ""
      [[ "$unc" =~ ^//[^/]+/[^/].* ]] && break
      warn "Write it like //nas.local/Music"
    done
    unc=${unc%/}
    ask sub "Music folder inside the share (empty: the whole share)" ""
    sub=${sub#/}
    sub=${sub%/}
    ask user "Username (empty: guest access)" ""
    pass=""
    [[ -n "$user" ]] && ask_secret pass "Password"
    ask vers "SMB protocol version" "3.1.1"
    n=$(($(smb_shares | wc -l) + 1))
    printf 'smb%s\037%s\037%s\037%s\037%s\037%s\n' "$n" "$unc" "$sub" "$user" "$pass" "$vers" >>"$SMB_FILE"
    ok "Added $unc${sub:+/$sub}"
  done
}

create_user() {
  if ! id "$USER_NAME" >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
    ok "Created the $USER_NAME system user"
  fi
  mkdir -p "$DATA_DIR"
  chown "$USER_NAME:$USER_NAME" "$DATA_DIR"
  chmod 750 "$DATA_DIR"
}

check_music_access() {
  local dir
  IFS=: read -r -a dirs <<<"$(setting HP_LIBRARY)"
  for dir in "${dirs[@]}"; do
    [[ "$dir" != /smb/* && -d "$dir" ]] || continue
    if ! runuser -u "$USER_NAME" -- test -r "$dir" -a -x "$dir" 2>/dev/null; then
      warn "The $USER_NAME user can't read $dir. Give it access, e.g. add it to the folder's group:"
      say "    usermod -aG $(stat -c %G "$dir") $USER_NAME   (then restart the server)"
    fi
  done
  local f
  for f in "$(setting HP_TLS_CERT)" "$(setting HP_TLS_KEY)"; do
    [[ -n "$f" ]] || continue
    runuser -u "$USER_NAME" -- test -r "$f" 2>/dev/null ||
      warn "The $USER_NAME user can't read $f; the server won't start until it can (e.g. a group that may read the key)."
  done
}

install_files() {
  mkdir -p "$PREFIX"
  rm -rf "$PREFIX/server.new"
  cp -a "$HERE/server" "$PREFIX/server.new"
  rm -rf "$PREFIX/server"
  mv "$PREFIX/server.new" "$PREFIX/server"
  echo "$VERSION" >"$PREFIX/VERSION"
}

stop_server() {
  case "$(installed_mode)" in
  # --volumes: only the SMB mounts are volumes (dropped so changed share settings apply); data is a bind mount.
  docker) [[ -f "$PREFIX/compose.yaml" ]] && docker compose -f "$PREFIX/compose.yaml" down --volumes 2>/dev/null || true ;;
  native) systemctl disable --now "$SERVICE" 2>/dev/null || true ;;
  esac
}

# YAML double-quoted string.
yq() {
  local s=${1//\\/\\\\}
  printf '"%s"' "${s//\"/\\\"}"
}

write_compose() {
  local port uid gid dir
  port=$(setting HP_PORT)
  uid=$(id -u "$USER_NAME")
  gid=$(id -g "$USER_NAME")
  rm -rf "$PREFIX/docker"
  mkdir -p "$PREFIX/docker"
  cp "$HERE/docker/Dockerfile" "$PREFIX/docker/"
  {
    echo "# Written by install.sh. Settings are in $ENV_FILE."
    echo "name: hyperplayer"
    echo "services:"
    echo "  hyperplayer:"
    echo "    build: { context: $PREFIX, dockerfile: docker/Dockerfile }"
    echo "    image: hyperplayer-server:$VERSION"
    echo "    container_name: hyperplayer"
    echo "    restart: unless-stopped"
    echo "    user: \"$uid:$gid\""
    echo "    env_file: $ENV_FILE"
    echo "    environment: { HP_DATA_DIR: /data }"
    echo "    ports: [\"$port:$port\"]"
    echo "    volumes:"
    echo "      - { type: bind, source: $DATA_DIR, target: /data }"
    # Music at the same paths as on the host, read-only.
    IFS=: read -r -a dirs <<<"$(setting HP_LIBRARY)"
    for dir in "${dirs[@]}"; do
      [[ "$dir" == /smb/* ]] && continue
      echo "      - { type: bind, source: $(yq "$dir"), target: $(yq "$dir"), read_only: true }"
    done
    local name unc sub user pass vers
    while IFS=$'\037' read -r name unc sub user pass vers; do
      echo "      - { type: volume, source: $name, target: /smb/$name, read_only: true }"
    done < <(smb_shares)
    for f in "$(setting HP_TLS_CERT)" "$(setting HP_TLS_KEY)"; do
      [[ -n "$f" ]] && echo "      - { type: bind, source: $(yq "$f"), target: $(yq "$f"), read_only: true }"
    done
    if [[ -s "$SMB_FILE" ]]; then
      echo "volumes:"
      while IFS=$'\037' read -r name unc sub user pass vers; do
        local host addr opts
        host=${unc#//}
        host=${host%%/*}
        # The kernel's SMB client needs the server's address, not its name.
        addr=$(getent ahostsv4 "$host" | awk 'NR == 1 { print $1 }' || true)
        [[ -n "$addr" ]] || {
          warn "Can't resolve $host; using the name as is."
          addr=$host
        }
        if [[ -n "$user" ]]; then
          # Commas in mount options are written twice.
          opts="username=${user//,/,,},password=${pass//,/,,}"
        else
          opts="guest"
        fi
        echo "  $name:"
        echo "    driver: local"
        echo "    driver_opts:"
        echo "      type: cifs"
        echo "      device: $(yq "$unc")"
        echo "      o: $(yq "addr=$addr,$opts,vers=$vers,ro,uid=$uid,gid=$gid,file_mode=0444,dir_mode=0555")"
      done < <(smb_shares)
    fi
  } >"$PREFIX/compose.yaml"
  # It holds the shares' passwords.
  chmod 600 "$PREFIX/compose.yaml"
}

start_docker() {
  write_compose
  say "Building the image and starting the container (the first build downloads Debian and ffmpeg)..."
  docker compose -f "$PREFIX/compose.yaml" up -d --build
  echo docker >"$MODE_FILE"
}

start_native() {
  if ! command -v ffmpeg >/dev/null; then
    warn "ffmpeg isn't installed; the server needs it for transcoding and waveforms."
    if command -v apt-get >/dev/null && confirm "Install it with apt-get?" y; then
      apt-get update -q && apt-get install -y -q ffmpeg
    else
      die "Install ffmpeg, then run the installer again."
    fi
  fi
  install -m 644 "$HERE/systemd/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  systemctl restart "$SERVICE"
  echo native >"$MODE_FILE"
}

# Waits until the server answers, then shows how to reach it and its certificate.
report_server() {
  local port tls scheme node="$PREFIX/server/node"
  port=$(setting HP_PORT)
  tls=$(setting HP_TLS)
  scheme=https
  [[ "$tls" == off ]] && scheme=http
  say "Waiting for the server..."
  local i
  for i in $(seq 1 90); do
    if "$node" -e '
      const [scheme, port] = process.argv.slice(1);
      const lib = require(scheme === "https" ? "node:https" : "node:http");
      lib.get({ host: "127.0.0.1", port, path: "/api/auth/status", rejectUnauthorized: false, timeout: 2000 },
        (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on("error", () => process.exit(1));
    ' "$scheme" "$port" 2>/dev/null; then
      break
    fi
    sleep 2
    if ((i == 90)); then
      warn "The server didn't answer in 3 minutes. Its log:"
      [[ "$(installed_mode)" == docker ]] && say "    docker logs hyperplayer" || say "    journalctl -u $SERVICE"
      return
    fi
  done
  ok "The server is running"
  local first
  first=$(setting HP_TLS_NAMES | cut -d, -f1)
  [[ -n "$first" ]] || first=$(hostname)
  title "Connect a player to"
  say "    $scheme://$first:$port"
  if [[ "$tls" != off && -z "$(setting HP_TLS_CERT)" && -f "$DATA_DIR/tls/cert.pem" ]]; then
    local fp
    fp=$("$node" -e 'console.log(new (require("node:crypto").X509Certificate)(require("node:fs").readFileSync(process.argv[1])).fingerprint256)' "$DATA_DIR/tls/cert.pem")
    title "Certificate fingerprint (SHA-256)"
    say "    $fp"
    say "Players ask whether to trust this server the first time: check that they show this."
  fi
  title "First sign-in"
  say "    Username admin, password hyperplayer (you choose your own right away)."
}

install_server() {
  local current mode
  current=$(installed_mode)
  title "How should the server run?"
  local docker_note=""
  have_docker || docker_note=" (Docker with Compose isn't installed here)"
  choose mode "Choose one; you can switch later, keeping the library and accounts:" \
    "In a Docker container$docker_note" \
    "As a systemd service (native)"
  if ((mode == 1)) && ! have_docker; then
    die "Docker with the Compose plugin is needed: https://docs.docker.com/engine/install/"
  fi
  mode=$([[ $mode == 1 ]] && echo docker || echo native)

  create_user
  # Settings carry over within a mode (SMB shares only work in Docker).
  if [[ -f "$ENV_FILE" && "$current" == "$mode" ]] && confirm "Keep the current server settings?" y; then
    :
  else
    configure_server "$mode"
  fi
  stop_server
  install_files
  if [[ "$mode" == docker ]]; then start_docker; else start_native; fi
  check_music_access
  report_server
}

# --------------------------------------------------------------- the player

install_player() {
  title "Player"
  local deb flatpak_bundle kind=""
  deb=$(ls "$HERE"/player/*.deb 2>/dev/null | head -1 || true)
  flatpak_bundle=$(ls "$HERE"/player/*.flatpak 2>/dev/null | head -1 || true)
  local can_deb=0 can_flatpak=0
  [[ -n "$deb" ]] && command -v apt-get >/dev/null && can_deb=1
  [[ -n "$flatpak_bundle" ]] && command -v flatpak >/dev/null && can_flatpak=1
  if ((can_deb && can_flatpak)); then
    local choice
    choose choice "Install the player as:" \
      ".deb package (Ubuntu 26.04 / Debian with the same or newer libraries)" \
      "Flatpak (any distribution; the runtime is downloaded from Flathub)"
    kind=$([[ $choice == 1 ]] && echo deb || echo flatpak)
  elif ((can_deb)); then
    kind=deb
  elif ((can_flatpak)); then
    kind=flatpak
  else
    warn "This system has neither apt nor Flatpak; install Flatpak (https://flatpak.org/setup/) and run the installer again."
    return
  fi
  if [[ "$kind" == deb ]]; then
    if apt-get install -y -q "$deb"; then
      ok "HyperPlayer is in your applications menu (or run: hyperplayer)"
      return
    fi
    warn "The .deb doesn't fit this system's libraries."
    ((can_flatpak)) && confirm "Install the Flatpak instead?" y || return
  fi
  flatpak remote-add --system --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
  flatpak install --system -y --noninteractive "$flatpak_bundle"
  ok "HyperPlayer is in your applications menu (or run: flatpak run io.ansaloni.HyperPlayer)"
}

# ---------------------------------------------------------------- uninstall

uninstall() {
  title "Uninstall HyperPlayer"
  if [[ -n "$(installed_mode)" ]] && confirm "Remove the server?" y; then
    stop_server
    [[ -f "$PREFIX/compose.yaml" ]] && docker image rm "hyperplayer-server:$(cat "$PREFIX/VERSION")" 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICE.service"
    systemctl daemon-reload 2>/dev/null || true
    rm -rf "$PREFIX" "$MODE_FILE"
    ok "Server removed"
    if confirm "Also delete its data (library database, accounts, certificate) in $DATA_DIR and the settings?" n; then
      rm -rf "$DATA_DIR" "$CONFIG_DIR"
      userdel "$USER_NAME" 2>/dev/null || true
      ok "Data and settings deleted"
    else
      say "Kept $DATA_DIR and $CONFIG_DIR: installing again picks them up."
    fi
  fi
  if dpkg -s hyperplayer >/dev/null 2>&1 && confirm "Remove the player (.deb)?" y; then
    apt-get remove -y -q hyperplayer
    ok "Player removed (your sign-in and settings stay in each user's ~/.config/hyperplayer)"
  fi
  if command -v flatpak >/dev/null && flatpak info --system io.ansaloni.HyperPlayer >/dev/null 2>&1 &&
    confirm "Remove the player (Flatpak)?" y; then
    flatpak uninstall --system -y --noninteractive io.ansaloni.HyperPlayer
    ok "Player removed (settings stay in each user's ~/.var/app/io.ansaloni.HyperPlayer)"
  fi
}

# --------------------------------------------------------------------- main

main() {
  need_root "$@"
  [[ "${1:-}" == --uninstall ]] && {
    uninstall
    exit 0
  }

  title "HyperPlayer $VERSION"
  current=$(installed_mode)
  [[ -n "$current" ]] && say "A server is installed here ($current, version $(cat "$PREFIX/VERSION" 2>/dev/null || echo unknown))."
  choose what "What should be installed on this machine?" \
    "The server and the player" \
    "Only the server (e.g. on a home server or NAS)" \
    "Only the player"
  case $what in
  1) install_server && install_player ;;
  2) install_server ;;
  3) install_player ;;
  esac
  title "Done."
}

# Sourcing the script (for tests) only defines the functions.
[[ "${BASH_SOURCE[0]}" != "$0" ]] || main "$@"
