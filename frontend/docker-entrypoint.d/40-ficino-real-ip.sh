#!/bin/sh
# Trust a reverse proxy in front of the web container (self-host). The nginx image runs this before
# nginx starts. REAL_IP_FROM is a comma or space separated list of the proxy's addresses or CIDRs;
# from those peers nginx takes the client from X-Forwarded-For (the rightmost address that is not
# itself listed), so the api's per-IP limits and audit log see the client, not the proxy.
# Unset or empty: no proxy is trusted and the direct peer is the client (the default).
# frontend/nginx.conf includes /etc/nginx/ficino/*.conf; the tailnet template does not, so this
# never changes the tailnet node.
set -eu

conf_dir=/etc/nginx/ficino
conf=$conf_dir/real-ip.conf

if [ -z "${REAL_IP_FROM:-}" ]; then
    if [ -e "$conf" ]; then
        rm -f "$conf"
    fi
    exit 0
fi

set -f # no glob expansion of the entries below
out=""
for entry in $(printf '%s' "$REAL_IP_FROM" | tr ',' ' '); do
    # Only address characters reach the config: nginx checks the value itself, this keeps
    # anything else (;, {, quotes, spaces) out of it.
    if ! printf '%s' "$entry" | grep -Eq '^[0-9A-Fa-f.:]*[.:][0-9A-Fa-f.:]*(/[0-9]{1,3})?$'; then
        echo "$0: REAL_IP_FROM entry is not an IP address or CIDR: $entry" >&2
        exit 1
    fi
    out="${out}set_real_ip_from ${entry};
"
done
if [ -z "$out" ]; then
    echo "$0: REAL_IP_FROM lists no address" >&2
    exit 1
fi

mkdir -p "$conf_dir"
printf '%sreal_ip_header X-Forwarded-For;\nreal_ip_recursive on;\n' "$out" > "$conf"
if [ -z "${NGINX_ENTRYPOINT_QUIET_LOGS:-}" ]; then
    echo "$0: trusting X-Forwarded-For from REAL_IP_FROM: $REAL_IP_FROM"
fi
