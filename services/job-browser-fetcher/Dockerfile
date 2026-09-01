FROM python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

EXPOSE 4040

CMD ["gunicorn", "--bind", "0.0.0.0:4040", "--workers", "2", "--threads", "4", "--timeout", "60", "app:app"]
