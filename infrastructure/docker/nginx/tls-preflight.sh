#!/bin/sh
# ---------------------------------------------------------------------------
# JumpToTech Labs — the web edge's certificate gate (BETA-P0-017).
#
# Installed in the web image as /usr/local/bin/jtt-tls-preflight. Three modes:
#
#   jtt-tls-preflight startup
#       Run by /docker-entrypoint.d/05-jumptotech-tls-preflight.sh before nginx
#       starts. With WEB_TLS=required (pinned by docker-compose.production.yml)
#       it validates PUBLIC_ORIGIN and /etc/nginx/tls/{fullchain,privkey}.pem,
#       and only then writes /etc/nginx/jumptotech/runtime/public-host.conf.
#       web-tls.conf includes that file, so nginx cannot start the TLS edge
#       unless this gate passed: skipping the gate is also a refusal.
#
#   jtt-tls-preflight check --cert FILE --key FILE
#       The same validation against a staged pair, changing nothing. Used by
#       scripts/tls-install.sh before a renewed certificate replaces the live one.
#
#   jtt-tls-preflight served
#       The container health check. The certificate nginx is serving on :8443
#       must be the one installed on disk, and must not have expired. A renewal
#       that was installed but never reloaded fails this.
#
# What it refuses (exit 1), naming the file and the reason, never the contents:
#
#   · PUBLIC_ORIGIN unset, not https://, carrying a port, path or credentials,
#     or not a DNS host name (an IP address is refused);
#   · a missing, empty, unreadable or non-regular certificate or key file;
#   · a private key readable by group or others;
#   · a private key in the certificate file, or a certificate in the key file;
#   · an unparseable certificate, or a key that is unparseable or encrypted;
#   · a key that does not belong to the certificate;
#   · an RSA key under 2048 bits, an EC key under 256, or any other key type;
#   · a CA certificate where the server certificate should be;
#   · a certificate not yet valid, expired, or not naming the public host;
#   · a server certificate with no intermediate after it, or a chain that does
#     not verify (order, signature, validity, serverAuth purpose, host name).
#
# It prints the host, notAfter and SHA-256 fingerprint. It never prints, copies
# or hashes the private key itself: the key is only ever asked for its PUBLIC
# half, which is compared with the certificate's.
#
# POSIX sh, for the image's busybox. openssl is installed by web.Dockerfile.
# ---------------------------------------------------------------------------
set -eu

LIVE_CERT=/etc/nginx/tls/fullchain.pem
LIVE_KEY=/etc/nginx/tls/privkey.pem
RUNTIME_DIR=/etc/nginx/jumptotech/runtime
PUBLIC_HOST_CONF=$RUNTIME_DIR/public-host.conf
# Below this many days the gate still passes, and says loudly that renewal is due.
WARN_DAYS=${WEB_TLS_WARN_DAYS:-21}

log() { printf 'jtt-tls-preflight: %s\n' "$*" >&2; }
refuse() {
  log "REFUSED: $*"
  log "see docs/runbooks/production-tls.md"
  exit 1
}

work=
# Keeps the script's own exit status: busybox sh exits with the trap's status,
# so a trap that ends in a false test would turn every success into a failure.
cleanup() {
  status=$?
  if [ -n "$work" ]; then rm -rf "$work"; fi
  exit "$status"
}
trap cleanup EXIT

# The public host name, from PUBLIC_ORIGIN. The value is not echoed on refusal:
# a malformed origin is exactly the place a credential could have been pasted.
public_host() {
  origin=${PUBLIC_ORIGIN:-}
  [ -n "$origin" ] || refuse "PUBLIC_ORIGIN is not set. It is the https:// origin students type into a browser, and the certificate must name its host."
  origin=${origin%/}
  case "$origin" in
    https://*) ;;
    *) refuse "PUBLIC_ORIGIN must be an https:// origin." ;;
  esac
  host=${origin#https://}
  if ! printf '%s' "$host" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'; then
    refuse "PUBLIC_ORIGIN must be exactly https://<dns-host-name>: lower case, no port (the edge serves 443), no path, no credentials, not an IP address."
  fi
  printf '%s' "$host"
}

validate() {
  cert=$1
  key=$2
  host=$3

  for file in "$cert" "$key"; do
    [ -e "$file" ] || refuse "$file does not exist."
    [ -f "$file" ] || refuse "$file is not a regular file."
    [ -r "$file" ] || refuse "$file is not readable."
    [ -s "$file" ] || refuse "$file is empty."
  done

  mode=$(stat -L -c %a "$key")
  if [ $((0$mode & 077)) -ne 0 ]; then
    refuse "$key is readable by group or others (mode $mode). chmod 600 it."
  fi

  if grep -q 'PRIVATE KEY' "$cert"; then
    refuse "$cert contains a private key. It must hold certificates only."
  fi
  if grep -q 'BEGIN CERTIFICATE' "$key"; then
    refuse "$key contains a certificate. It must hold the private key only."
  fi
  count=$(grep -c 'BEGIN CERTIFICATE' "$cert" || true)
  [ "$count" -ge 1 ] || refuse "$cert holds no PEM certificate."

  work=$(mktemp -d)
  # Certificates only: the leaf, then everything after it.
  awk -v leaf="$work/leaf.pem" -v rest="$work/chain.pem" '
    /-----BEGIN CERTIFICATE-----/ { n++ }
    n == 1 { print > leaf }
    n > 1  { print > rest }
  ' "$cert"
  leaf=$work/leaf.pem

  openssl x509 -in "$leaf" -noout 2>/dev/null ||
    refuse "the first certificate in $cert cannot be parsed."
  # -passin with an empty password: an encrypted key fails instead of prompting.
  openssl pkey -in "$key" -passin pass: -noout 2>/dev/null ||
    refuse "$key is not a readable, unencrypted private key."

  cert_public=$(openssl x509 -in "$leaf" -noout -pubkey | sha256sum | cut -d' ' -f1)
  key_public=$(openssl pkey -in "$key" -passin pass: -pubout 2>/dev/null | sha256sum | cut -d' ' -f1)
  [ "$cert_public" = "$key_public" ] ||
    refuse "$key does not belong to the server certificate in $cert."

  # Strength, read from the certificate's public key rather than the key file.
  public_text=$(openssl x509 -in "$leaf" -noout -pubkey | openssl pkey -pubin -noout -text_pub)
  bits=$(printf '%s\n' "$public_text" | sed -n 's/.*Public-Key: (\([0-9]*\) bit).*/\1/p' | head -n 1)
  if printf '%s\n' "$public_text" | grep -q '^Modulus:'; then
    [ "${bits:-0}" -ge 2048 ] || refuse "the server certificate has a ${bits:-?}-bit RSA key. Use RSA 2048 or larger, or EC P-256."
  elif printf '%s\n' "$public_text" | grep -q 'ASN1 OID:'; then
    [ "${bits:-0}" -ge 256 ] || refuse "the server certificate has a ${bits:-?}-bit EC key. Use P-256 or larger."
  else
    refuse "the server certificate's key is neither RSA nor EC, which browsers do not all accept."
  fi

  if openssl x509 -in "$leaf" -noout -ext basicConstraints 2>/dev/null | grep -q 'CA:TRUE'; then
    refuse "the first certificate in $cert is a CA certificate, not the server certificate."
  fi

  not_before=$(openssl x509 -in "$leaf" -noout -dateopt iso_8601 -startdate | sed 's/^notBefore=//')
  not_after=$(openssl x509 -in "$leaf" -noout -dateopt iso_8601 -enddate | sed 's/^notAfter=//')
  now=$(date -u +%s)
  starts=$(date -u -D '%Y-%m-%d %H:%M:%SZ' -d "$not_before" +%s)
  [ "$starts" -le "$now" ] || refuse "the certificate in $cert is not valid until $not_before."
  openssl x509 -in "$leaf" -noout -checkend 0 >/dev/null ||
    refuse "the certificate in $cert expired at $not_after."

  openssl x509 -in "$leaf" -noout -checkhost "$host" >/dev/null 2>&1 ||
    refuse "the certificate in $cert does not name $host."

  [ -s "$work/chain.pem" ] ||
    refuse "$cert holds only the server certificate. Append the issuer's intermediate certificate(s) after it: clients that do not fetch a missing intermediate themselves, curl and Node among them, refuse the connection."

  # The rest of the file is the only trust anchor here: this proves the chain
  # is ordered, signed and in date, and names the host for a TLS server. Whether
  # a public root anchors it is checked from outside, by scripts/tls-check.ts.
  if ! verification=$(openssl verify -partial_chain -purpose sslserver -verify_hostname "$host" \
      -CAfile "$work/chain.pem" "$leaf" 2>&1); then
    reason=$(printf '%s\n' "$verification" | grep -m 1 '^error' || true)
    refuse "the certificate chain in $cert does not verify: ${reason:-unknown error}."
  fi

  if ! openssl x509 -in "$leaf" -noout -checkend $((WARN_DAYS * 86400)) >/dev/null; then
    log "WARNING: the certificate for $host expires at $not_after, within ${WARN_DAYS} days. Renew it now."
  fi

  fingerprint=$(openssl x509 -in "$leaf" -noout -fingerprint -sha256 | sed 's/^.*=//')
  log "certificate OK: host=$host notAfter=$not_after sha256=$fingerprint chain=$count"
}

startup() {
  case "${WEB_TLS:-}" in
    required) ;;
    ''|off)
      log "WEB_TLS is not 'required': the development listener, no certificate checked."
      exit 0
      ;;
    *) refuse "WEB_TLS must be 'required' or unset." ;;
  esac

  # A file left by an earlier start must not stand in for this start's gate.
  rm -f "$PUBLIC_HOST_CONF"
  host=$(public_host) || exit 1
  validate "$LIVE_CERT" "$LIVE_KEY" "$host"

  mkdir -p "$RUNTIME_DIR"
  printf 'server_name %s;\n' "$host" > "$PUBLIC_HOST_CONF.tmp"
  mv "$PUBLIC_HOST_CONF.tmp" "$PUBLIC_HOST_CONF"
}

check() {
  cert=
  key=
  while [ $# -gt 0 ]; do
    case "$1" in
      --cert) cert=${2:-}; shift 2 ;;
      --key) key=${2:-}; shift 2 ;;
      *) refuse "unknown argument '$1'. Usage: jtt-tls-preflight check --cert FILE --key FILE" ;;
    esac
  done
  [ -n "$cert" ] && [ -n "$key" ] || refuse "usage: jtt-tls-preflight check --cert FILE --key FILE"
  host=$(public_host) || exit 1
  validate "$cert" "$key" "$host"
}

served() {
  fail() { log "UNHEALTHY: $*"; exit 1; }
  [ -r "$PUBLIC_HOST_CONF" ] || fail "$PUBLIC_HOST_CONF is missing: the startup gate did not pass."
  host=$(sed -n 's/^server_name \(.*\);$/\1/p' "$PUBLIC_HOST_CONF")
  [ -n "$host" ] || fail "$PUBLIC_HOST_CONF names no host."

  # Fetching the served certificate is not trusting it: it is compared, byte
  # for byte by fingerprint, with the installed one the startup gate verified.
  served_pem=$(timeout 5 openssl s_client -connect 127.0.0.1:8443 -servername "$host" </dev/null 2>/dev/null |
    openssl x509 2>/dev/null) || fail "nothing is serving a certificate for $host on :8443."
  [ -n "$served_pem" ] || fail "nothing is serving a certificate for $host on :8443."

  served_fp=$(printf '%s\n' "$served_pem" | openssl x509 -noout -fingerprint -sha256)
  installed_fp=$(openssl x509 -in "$LIVE_CERT" -noout -fingerprint -sha256 2>/dev/null) ||
    fail "$LIVE_CERT cannot be read."
  [ "$served_fp" = "$installed_fp" ] ||
    fail "the served certificate is not the installed one: a renewal was installed without a reload (docker compose exec web nginx -s reload)."
  printf '%s\n' "$served_pem" | openssl x509 -noout -checkend 0 >/dev/null ||
    fail "the served certificate for $host has expired."
}

mode=${1:-startup}
[ $# -gt 0 ] && shift
case "$mode" in
  startup) startup ;;
  check) check "$@" ;;
  served) served ;;
  *) refuse "unknown mode '$mode' (startup, check or served)." ;;
esac
