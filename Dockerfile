# syntax=docker/dockerfile:1

FROM python:3.12-slim

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini && \
    rm -rf /var/lib/apt/lists/*

# App deps
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# App code
COPY main.py /app/main.py
# Static UI (serve your provided html/ under /msgdrop)
COPY html/ /app/html/

# Data directory (messages.db + blob files)
RUN mkdir -p /data/blob
VOLUME ["/data"]

ENV HOST=0.0.0.0 \
    PORT=443
EXPOSE 443

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["/bin/sh","-c","uvicorn main:app --host 0.0.0.0 --port ${PORT} --proxy-headers"]

