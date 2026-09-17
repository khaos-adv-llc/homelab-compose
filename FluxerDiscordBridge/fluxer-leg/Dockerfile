FROM python:3.12-slim

# livekit's Python wheel bundles its own compiled rtc engine, but a couple
# of transitive deps still want basic build tooling on some platforms.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY bridge.py ./

CMD ["python", "bridge.py"]
