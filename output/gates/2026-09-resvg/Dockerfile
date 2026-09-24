# Measurement image for the resvg gate (ADR-036 section 2.3). Not a product image.
#
# Stage 1 builds the resvg 0.48.1 command-line tool from crates.io source, because
# no linux/arm64 binary is published. Stage 2 is the production core image
# unchanged (rsvg-convert 2.54.7 and the production fonts) with the binary added,
# so both renderers see the same fonts, libraries and CPU.
ARG BASE_IMAGE=hawa-core:canva-only-20260913

FROM rust:1-bookworm AS resvg-build
# -j 4 keeps the build inside the memory the Mac can spare while production runs.
RUN cargo install resvg --version 0.48.1 --locked -j 4 \
 && strip /usr/local/cargo/bin/resvg \
 && /usr/local/cargo/bin/resvg --version

FROM ${BASE_IMAGE}
USER root
# /usr/bin/time -v gives peak RSS per render. Installed from the Debian archive the
# base image already uses; it is only in this measurement image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends time \
 && rm -rf /var/lib/apt/lists/*
COPY --from=resvg-build /usr/local/cargo/bin/resvg /usr/local/bin/resvg
USER hawa
WORKDIR /gate
ENTRYPOINT []
