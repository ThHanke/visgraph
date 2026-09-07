# ── Stage 1: build ────────────────────────────────────────────────────────────
# Pin to a specific node:22-slim digest for reproducibility.
# To update: docker pull node:22-slim and replace the tag with the new digest.
FROM node:22-slim AS builder

WORKDIR /app

# Copy manifests first so dependency installation is cached as a separate layer.
COPY package.json package-lock.json ./

# Install exact locked versions; skip postinstall (patches/ and scripts/ not yet copied).
RUN npm ci --ignore-scripts

# Copy the rest of the source tree, then run postinstall (patch-package + copy-konclude-assets).
COPY . .
RUN npm run postinstall

# Build for root path (Docker serves from /, not /ontosphere/ like GitHub Pages).
RUN VITE_BASE_PATH=/ npm run build

# ── Stage 2: serve ────────────────────────────────────────────────────────────
# Minimal Node runtime; no build tools, no source, only dist/.
FROM node:22-slim AS server

WORKDIR /app

# Only the production dependency for the static file server.
# express is already a runtime dependency (listed in package.json dependencies),
# so we install only it rather than the full node_modules tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy built assets and the production server script from the builder stage.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/docker-static-server.js ./

# Self-signed TLS cert so SharedArrayBuffer works on non-localhost hostnames.
# Set HTTPS=false at runtime to disable.
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl \
    && mkdir -p certs \
    && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
         -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes \
         -subj "/CN=ontosphere-docker" \
    && apt-get purge -y openssl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

EXPOSE 8080

ENV PORT=8080 \
    NODE_ENV=production

# HTTPS by default; set HTTPS=false for plain HTTP (OWL reasoner needs HTTPS on remote hosts).
#   docker run --rm -p 8080:8080 ontosphere:latest
# Then open https://localhost:8080 in a Chromium-based browser.
CMD ["node", "docker-static-server.js"]
