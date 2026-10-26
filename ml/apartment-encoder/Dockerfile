# Serving image for the apartment encoder (flags + span tagger). CPU only: it runs in shadow mode beside the
# ai-worker, one text at a time. The weights are not in the image: mount a directory with the flags model and the
# span model at /models (see README, "Shadow mode").
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/hf \
    TOKENIZERS_PARALLELISM=false \
    OMP_NUM_THREADS=4

WORKDIR /app
COPY requirements.txt ./
RUN pip install --index-url https://download.pytorch.org/whl/cpu "torch>=2.3"  && pip install -r requirements.txt

# Both models start from xlm-roberta-base. Keep it in the image so the container never needs the network.
RUN python -c "from transformers import AutoModel, AutoTokenizer; AutoModel.from_pretrained('xlm-roberta-base'); AutoTokenizer.from_pretrained('xlm-roberta-base')"
ENV HF_HUB_OFFLINE=1

COPY serve.py train.py train_spans.py price_select.py ./

EXPOSE 4040
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:4040/health', timeout=8).status == 200 else 1)"
CMD ["python", "serve.py", "--model", "/models/model", "--spans-model", "/models/span-model", "--port", "4040"]
