#!/usr/bin/env bash
# Run at boot by hyperplayer-docker.service. Docker starts the container itself (restart:
# unless-stopped), but tries only once: if an SMB share isn't answering yet (the NAS is still
# booting, the network is slow), mounting its volume fails and the container stays down until
# someone starts it. This retries such a failed start for up to an hour.
#
# A container stopped on purpose (docker stop, compose down) has no start error and is left alone.
set -uo pipefail

NAME=hyperplayer
TRIES=240 # every 15 s: an hour
DELAY=15

# Let Docker's own start at boot go first.
sleep "$DELAY"
for ((i = 1; i <= TRIES; i++)); do
  state=$(docker inspect -f '{{.State.Running}} {{.State.Error}}' "$NAME" 2>/dev/null) || {
    echo "No $NAME container (removed on purpose?); nothing to do."
    exit 0
  }
  running=${state%% *}
  error=${state#* }
  [[ "$running" == true ]] && {
    ((i > 1)) && echo "$NAME is running."
    exit 0
  }
  [[ -z "$error" ]] && {
    echo "$NAME was stopped on purpose; leaving it stopped."
    exit 0
  }
  echo "$NAME didn't start ($error); retrying (attempt $i)."
  docker start "$NAME" >/dev/null 2>&1 && {
    echo "$NAME is running."
    exit 0
  }
  sleep "$DELAY"
done
echo "$NAME still can't start after an hour; check its shares, then: docker start $NAME" >&2
exit 1
