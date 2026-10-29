FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=4040

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && playwright install --with-deps chromium

COPY app.py main.py facebook_guard.py test_app.py test_facebook_guard.py ./
RUN python -m py_compile app.py main.py facebook_guard.py \
    && python -m unittest -v test_app.py test_facebook_guard.py

EXPOSE 4040

CMD ["gunicorn", "--bind", "0.0.0.0:4040", "--workers", "1", "--threads", "4", "--timeout", "180", "main:app"]
