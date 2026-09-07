#!/bin/sh
# Disposable SSH qualification fixture, not the application's remote runtime.
set -eu
set -f
umask 077
[ "$(id -un)" = dwtrial ] || exit 77
project="$HOME/donwells-trial-project"
state="$HOME/.donwells-trial"
self="$state/remote-work-trial.sh"
mkdir -p "$state/operations"
revision() { shasum -a 256 "$project/revision.txt" | cut -d ' ' -f 1; }
valid_id() { case "$1" in ''|*[!a-f0-9]*) return 1;; esac; [ "${#1}" = 32 ]; }
valid_hash() { case "$1" in ''|*[!a-f0-9]*) return 1;; esac; [ "${#1}" = 64 ]; }
outcome() { printf '%s\n' "$1" > "$op/status.tmp"; mv "$op/status.tmp" "$op/status"; }

if [ "${1-}" = --worker ]; then
  [ "$#" = 4 ] && valid_id "$2" && valid_hash "$3" || exit 64
  case "$4" in 5|20) ;; *) exit 64;; esac
  op="$state/operations/$2"
  printf '%s\n' "$$" > "$op/pid"
  trap 'outcome stopped; exit 0' HUP INT TERM
  outcome running
  count=0
  while [ "$count" -lt "$4" ]; do sleep 1; count=$((count + 1)); done
  [ ! -e "$state/paused" ] || { outcome paused; exit 0; }
  [ "$(revision)" = "$3" ] || { outcome divergence; exit 0; }
  printf 'verified remote artifact %s\n' "$2" > "$op/artifact.tmp"
  mv "$op/artifact.tmp" "$op/artifact.txt"
  outcome complete
  exit 0
fi

# Only whitespace-separated, validated protocol tokens; never evaluate shell input.
set -- ${SSH_ORIGINAL_COMMAND-}
[ "$#" -ge 3 ] || exit 64
[ "$1" = trial-v1 ] && [ "$2" = donwells-task24 ] || exit 65
shift 2
command=$1; shift
case "$command" in
  hello)
    [ "$#" = 0 ] || exit 64
    printf 'trial-v1 donwells-task24 %s\n' "$project"
    printf 'capabilities start status artifact pause resume stop revision\n'
    ;;
  revision)
    [ "$#" = 0 ] || exit 64
    revision
    ;;
  pause|resume)
    [ "$#" = 0 ] || exit 64
    if [ "$command" = pause ]; then : > "$state/paused"; else rm -f "$state/paused"; fi
    printf '%s\n' "$command"
    ;;
  start)
    [ "$#" = 3 ] && valid_id "$1" && valid_hash "$2" || exit 64
    case "$3" in 5|20) ;; *) exit 64;; esac
    [ ! -e "$state/paused" ] || exit 75
    [ "$(revision)" = "$2" ] || exit 73
    op="$state/operations/$1"
    mkdir "$op" 2>/dev/null || { printf 'existing '; cat "$op/status"; exit 0; }
    outcome accepted
    nohup "$self" --worker "$1" "$2" "$3" > "$op/log" 2>&1 < /dev/null &
    worker=$!
    printf 'accepted %s %s\n' "$1" "$worker"
    wait "$worker"
    ;;
  status|artifact|stop)
    [ "$#" = 1 ] && valid_id "$1" || exit 64
    op="$state/operations/$1"
    [ -d "$op" ] || exit 66
    case "$command" in
      status) cat "$op/status"; [ ! -f "$op/pid" ] || cat "$op/pid" ;;
      artifact) [ "$(cat "$op/status")" = complete ] || exit 75; cat "$op/artifact.txt" ;;
      stop)
        pid=$(cat "$op/pid")
        case "$pid" in ''|*[!0-9]*) exit 64;; esac
        owner=$(ps -p "$pid" -o command=)
        case "$owner" in "/bin/sh $self --worker $1 "*) kill -TERM "$pid";; *) exit 69;; esac
        ;;
    esac
    ;;
  *) exit 64 ;;
esac
