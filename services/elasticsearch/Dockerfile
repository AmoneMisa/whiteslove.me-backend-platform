FROM docker.elastic.co/elasticsearch/elasticsearch:9.5.1

COPY --chown=elasticsearch:root \
    analysis-icu-9.5.1.zip \
    /tmp/analysis-icu.zip

RUN ( \
        bin/elasticsearch-plugin install --batch analysis-icu \
        || bin/elasticsearch-plugin install --batch file:///tmp/analysis-icu.zip \
    ) \
    && rm -f /tmp/analysis-icu.zip
