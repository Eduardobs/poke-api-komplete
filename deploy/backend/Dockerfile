FROM python:3.14-slim AS snapshot
COPY --from=ghcr.io/astral-sh/uv:0.11.19 /uv /usr/local/bin/uv
WORKDIR /app
COPY vendor/pokeapi/pyproject.toml vendor/pokeapi/uv.lock vendor/pokeapi/
RUN uv sync --project vendor/pokeapi --locked --no-dev --no-install-project
COPY vendor/ vendor/
COPY scripts/ scripts/
COPY data/ data/
COPY contracts/ contracts/
COPY deploy/graphiql.html deploy/graphiql.html
COPY upstream.lock.json .
RUN vendor/pokeapi/.venv/bin/python scripts/build_data.py

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=dependencies /app/node_modules node_modules/
COPY src/ src/
COPY contracts/graphql.introspection.json contracts/graphql.introspection.json
COPY package.json LICENSE THIRD_PARTY_NOTICES.md ./
COPY vendor/pokeapi/LICENSE.md vendor/pokeapi/LICENSE.md
USER node
EXPOSE 8080
CMD ["node", "--max-old-space-size=192", "src/backend/server.js"]

# CI supplies the exact snapshot that passed the compatibility gates.
FROM runtime AS tested-snapshot
COPY public/ public/
COPY src/generated/ src/generated/

# Standalone builds (including Render) still generate their own snapshot.
FROM runtime AS production
COPY --from=snapshot /app/public public/
COPY --from=snapshot /app/src/generated src/generated/
