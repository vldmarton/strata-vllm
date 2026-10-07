FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .
COPY web/ ./web/

ENV PORT=8377 \
    DATA_DIR=/app/data

VOLUME /app/data
EXPOSE 8377

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8377/api/metrics', timeout=2)" || exit 1

CMD ["python", "server.py"]
