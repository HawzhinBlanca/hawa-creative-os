# ADR183. Sourced by deploy.sh; COMPOSE, INTERP_FILE and expected digests come from that deploy.
hawa_nginx_seen() {
  "${COMPOSE[@]}" --env-file "$INTERP_FILE" exec -T nginx sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || true
}
hawa_nginx_mounts_match() {
  [[ "$(hawa_nginx_seen /etc/nginx/nginx.conf)" == "$NGINX_WANT" &&
     "$(hawa_nginx_seen /etc/nginx/hawa-office-proof.conf)" == "$OFFICE_PROOF_WANT" ]]
}
hawa_nginx_test() {
  "${COMPOSE[@]}" --env-file "$INTERP_FILE" exec -T nginx nginx -t >/dev/null 2>&1
}
hawa_nginx_bind_paths_match() {
  local mounted root="${HAWA_RELEASE_ROOT:-$ROOT_DIR}"
  mounted="$(docker inspect hawa-production-nginx-1 --format '{{range .Mounts}}{{if eq .Destination "/etc/nginx/nginx.conf"}}{{.Source}}{{end}}{{end}}|{{range .Mounts}}{{if eq .Destination "/etc/nginx/hawa-office-proof.conf"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)" || return 1
  [[ "$mounted" == "$root/infra/docker/nginx.conf|$root/infra/docker/.office-proxy-header.conf" ]]
}
hawa_nginx_reload() {
  if ! hawa_nginx_bind_paths_match; then
    "${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d --no-deps --force-recreate nginx >/dev/null 2>&1 || {
      echo 'ERROR: nginx mount recreation failed; deployment is not admitted' >&2; return 1;
    }
    echo '✓ nginx recreated onto current bind paths'
  elif ! hawa_nginx_mounts_match || ! hawa_nginx_test; then
    "${COMPOSE[@]}" --env-file "$INTERP_FILE" restart nginx >/dev/null 2>&1 || {
      echo 'ERROR: nginx restart failed; deployment is not admitted' >&2; return 1;
    }
    hawa_nginx_mounts_match || {
      echo 'ERROR: nginx still has stale configuration or office-proof mounts' >&2; return 1;
    }
    echo '✓ nginx restarted onto both deployed configuration files'
  fi
  hawa_nginx_mounts_match && hawa_nginx_bind_paths_match || {
    echo 'ERROR: nginx bind paths or mounted configuration remain stale' >&2; return 1;
  }
  hawa_nginx_test || { echo 'ERROR: live nginx -t failed after configuration preparation' >&2; return 1; }
  "${COMPOSE[@]}" --env-file "$INTERP_FILE" exec -T nginx nginx -s reload >/dev/null 2>&1 || {
    echo 'ERROR: nginx reload failed; deployment is not admitted' >&2; return 1;
  }
  hawa_nginx_test || { echo 'ERROR: nginx validation failed after reload' >&2; return 1; }
  echo '✓ nginx configuration and office proof validated and reloaded'
}
