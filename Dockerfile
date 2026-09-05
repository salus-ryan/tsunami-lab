FROM nginxinc/nginx-unprivileged:1.27.4-alpine

LABEL org.opencontainers.image.title="Tsunami Lab" \
      org.opencontainers.image.description="Offline-first educational tsunami simulator" \
      org.opencontainers.image.source="https://github.com/salus-ryan/tsunami-lab" \
      org.opencontainers.image.licenses="MIT"

COPY --chown=101:101 deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=101:101 public/ /usr/share/nginx/html/

USER 101
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
