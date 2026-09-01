FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 4020

# Keep a small process pool per fetcher service. max-requests periodically
# recycles long-lived curl_cffi/libcurl state so one degraded worker cannot stay
# unhealthy indefinitely. The UA service gets its own identical pool in compose.
# Threaded workers: work is I/O-bound (waiting on OLX), so threads give cheap
# concurrency for parallel country/segment fetches. RabbitMQ owns retries, so
# a normal compose request is bounded by one curl_cffi timeout (~45s).
# max-requests periodically recycles long-lived curl_cffi/libcurl state so one
# degraded worker cannot stay unhealthy indefinitely.
CMD ["gunicorn", "--bind", "0.0.0.0:4020", "--worker-class", "gthread", "--workers", "2", "--threads", "4", "--timeout", "120", "--max-requests", "100", "--max-requests-jitter", "20", "app:app"]
