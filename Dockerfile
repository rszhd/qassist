# Single image: React build served by Express, which spawns the Python
# browser-use agent. Node is the primary runtime; Python + Chromium ride along.

# ---- stage 1: build the React frontend ----
FROM node:22-bookworm-slim AS frontend
WORKDIR /fe
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ---- stage 2: runtime ----
FROM node:22-bookworm-slim AS runtime
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PYTHONUNBUFFERED=1 \
    PYTHON_BIN=/opt/venv/bin/python \
    AGENT_DIR=/app/agent \
    AGENT_SCRIPT=/app/agent/run_agent.py \
    REPORT_SCRIPT=/app/agent/make_report.py \
    ARTIFACTS_DIR=/app/runs \
    PORT=8080
WORKDIR /app

# Python + venv tooling
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Python deps + Chromium (with its system libraries)
COPY agent/requirements.txt /app/agent/requirements.txt
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r /app/agent/requirements.txt \
 && /opt/venv/bin/playwright install --with-deps chromium

# Server deps
COPY server/package.json /app/server/package.json
RUN cd /app/server && npm install --omit=dev

# App code + built frontend (db/ carries the control-plane migrations the
# server applies at boot; demo/ the replay fixtures a demo deployment serves
# from DEMO_DIR, which defaults to /app/demo — without them AUTH_MODE=demo
# boots fine and every run fails at the fixture read)
COPY agent/ /app/agent/
COPY db/ /app/db/
COPY demo/ /app/demo/
COPY server/ /app/server/
COPY --from=frontend /fe/dist /app/server/public

EXPOSE 8080
CMD ["node", "/app/server/src/server.js"]
