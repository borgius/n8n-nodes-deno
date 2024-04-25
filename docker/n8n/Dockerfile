ARG N8N_VERSION

FROM gcr.io/distroless/cc as cc

FROM n8nio/n8n:${N8N_VERSION}

USER root

# from: https://github.com/denoland/deno_docker/blob/4d61d7da8e7350ee31862d1a5e6268993f4dd1ff/alpine.dockerfile#L22
COPY --from=cc --chown=root:root --chmod=755 /lib/*-linux-gnu/* /usr/local/lib/
COPY --from=cc --chown=root:root --chmod=755 /lib/ld-linux-* /lib/

RUN mkdir -p /lib64 \
    && ln -sf /usr/local/lib/ld-linux-* /lib64/ \
    && rm -f /usr/local/lib/libgcc_s.so.1

USER node
