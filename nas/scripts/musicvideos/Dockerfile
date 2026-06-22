FROM alpine:3.20

# python3  — for future scripting / health-check hooks (mirrors playlistsync)
# ffmpeg   — muxes the best-video+best-audio streams yt-dlp selects
# ca-certificates tzdata — HTTPS + correct TZ inside the container
# tini     — PID-1 signal forwarding + zombie reaping
# wget     — used once at image build time to fetch the standalone yt-dlp binary
RUN apk add --no-cache python3 ffmpeg ca-certificates tzdata tini wget

# Standalone yt-dlp binary so `yt-dlp -U` can self-update at runtime without
# rebuilding the image (YouTube's extractor breaks frequently).
RUN wget -qO /usr/local/bin/yt-dlp \
        https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app
COPY run.sh /app/
RUN chmod +x /app/run.sh

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/run.sh"]
