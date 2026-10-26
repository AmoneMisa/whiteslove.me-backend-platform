# Apartment encoder

Two small multilingual models (`xlm-roberta-base`) that read listing text:

| Model | Trains with | Answers | Used for |
|---|---|---|---|
| **Flags** (`model/`) | `train.py` | 25 yes / no / unsaid flags + `condition` | replaces the LLM call for amenities |
| **Spans** (`span-model-v4/`) | `train_spans.py` | where the PRICE, CURRENCY, ADDRESS, METRO, DISTRICT, LANDMARK and COMPLEX (ЖК) are in the text | pointing at fields, filling empty ones |

`serve.py` loads both and answers `POST /predict`. The ai-worker calls it through
the `encoder` text provider (`apps/ai-worker/src/services/encoder-provider.js`).

## Run

```bash
python serve.py --model model --spans-model span-model-v3 --port 4040
```

then in the ai-worker: `ENCODER_URL=http://<host>:4040 TEXT_PROVIDERS=encoder,freellmapi`.
`ENCODER_FIELDS` lists the fields the encoder may answer (default: the six flags with
F1 >= 0.85); `address` is opt-in. Everything else falls through to the LLM.

Install: `pip install torch transformers` (CUDA build of torch for training; CPU is fine for serving).

## Shadow mode: learn from real traffic before trusting it

`ENCODER_SHADOW=true` (with `ENCODER_URL`, and `serve.py --model model --spans-model <span model>` running) makes
the ai-worker ask the encoder about every apartment text after the real answer is ready, and compare it with what the
parser already knew (`knownFacts`) and with what the provider chain answered. **Nothing the encoder says is returned,
merged or stored**; the call is not awaited, has its own deadline (`ENCODER_TIMEOUT_MS`), and a failing encoder is only
counted. Leave `TEXT_PROVIDERS` without `encoder`: with it listed the encoder answers for real and shadow is skipped.

The outcome is in `/metrics` under `encoderShadow`: per field (`address`, `district`, `residenceComplex`, `priceAmount`,
`priceCurrency`, `depositAmount` and the flags) and per source (`parser`, `llm`) the counts `agree`, `disagree`,
`encoderOnly` (what the encoder would add) and `sourceOnly`; `found` counts how often the encoder sees a microdistrict,
locality, landmark, "nearby" or station, which the apartment schema has no field for. Disagreements and additions of
text fields are also logged (`encoder shadow`, at most `ENCODER_SHADOW_LOG_PER_MINUTE`, default 20). A field is ready
to be allowed in `ENCODER_FIELDS` when, over a few thousand texts, its `agree` share against the parser is high and the
`encoderOnly` values it adds are right on a hand check. It is enabled per service (deploy ai-worker only).

## Rebuild the data and retrain

All database access is read-only and runs on the server; training data never leaves this machine.

```bash
# flags
node apps/flats/scripts/export-encoder-dataset.mjs --sql > q.sql     # then psql -At -f q.sql > raw.jsonl
node apps/flats/scripts/export-encoder-dataset.mjs raw.jsonl ml/apartment-encoder/data/splits
python train.py --data data/splits --out model

# spans (raw rows: title, description, price, currency, address, street, metro)
node apps/flats/scripts/build-span-dataset.mjs data/spans_raw.jsonl data/span-splits
python train_spans.py --data data/span-splits --out span-model-v4
python eval_spans.py --model span-model-v4 --data data/span-splits --split test
```

`run_spans_and_shutdown.ps1 [-Out DIR] [-Shutdown]` runs the span training detached,
keeps the PC awake, and optionally shuts it down afterwards.

Tests: `node --test` in `apps/flats` and `apps/ai-worker`; `python -m unittest test_price_select`.

## The seven span entities and where their labels come from

| Entity | What it is | Automatic label |
|---|---|---|
| PRICE, CURRENCY | an amount with its currency | the stored price, found in the text |
| ADDRESS | a street, or street + house (what the site shows) | the stored address / street |
| METRO | a station | the stored station, matched across scripts |
| DISTRICT | a district, microdistrict or locality (Глинка, Гидропарк) | the `district` / `area` / `kvartal` columns, matched across scripts with a case ending allowed |
| LANDMARK | a mall, a school, a stop, a park (for the distance to transit) | **rules**: the items of a list after "рядом с", "ориентир:", "lângă", ... (the database has no column) |
| COMPLEX | a residential complex, with its "ЖК" | **rules**: the name after "ЖК", "Complexul", "жилой комплекс" (`residence_complex` is mixed with fragments of the description) |

Station names also come from `@whiteslove/parsing-lexicon` (`src/ml/lexicon-names.js`), not from a list of our own:
the database stores one Latin spelling per station, the lexicon knows the others ("Дружба народов", "Максим
Горький"), so a stored station is matched under any of its spellings, and a known station next to the word
"метро" is labelled even when the row stores none. A station that is also a district ("Чиланзар", "Алмазар") is
a station only next to such a cue. Lexicon *district* names were tried and left out: on the hand labels they cut
precision from 67% to 35-42% (they include cities and ordinary words), so districts still come from the database
columns. The geo-catalog is encrypted and needs `GEO_CATALOG_DECRYPTION_KEY`, so it is not used by the build.

LANDMARK and COMPLEX labels are rules, not truth; DISTRICT is only as good as the database columns. They are
good for a first model and for finding the mentions, and the hand review is what says how good that is.
Models trained before a label existed carry their own `entities` list in `config.json`; `train_spans.py
--init-from span-model-v3` starts a longer model from a shorter one.

## Hand review: a real before / after

The scores below only measure agreement with automatic labels. To learn how right the
models are on real listings, and whether they beat what the database holds today:

```bash
python build_review_set.py --model model --spans-model span-model-v3 \
    --data data/span-splits --raw data/spans_raw.jsonl --out review      # ~5 min
# open review/review.html in a browser, mark spans right / wrong, press "Скачать результаты"
python compare_review.py review/items.json review/review_results.json
```

200 listings from the test split in four groups (random; database has no address but the
model found one; same for the metro; several amounts in the text). The report gives, for
price / currency / address / metro: the model's precision and recall, the accuracy of the
stored values, and *before* (database only) against *after* (database, filled in by the
model where empty), each with a 95% interval. A partial review works, with wider intervals.
Each card also has a **сборное / мусор** button (several flats in one post, search filters, not a
listing): the card is skipped, left out of every score and counted on its own; two "missed" ticks,
**район / мкр / местность** and **ориентир**, record what the site needs but the model does not look for
yet; "скрыть размеченные" and "перейти к №" save scrolling. `review/` holds listing texts and is git-ignored.

**Selecting fragments.** Select text in a card (mouse, or a long press on a phone) and pick a type in the bar
at the bottom: адрес (street, or street + house), район / мкр / местность (Глинка, Гидропарк), ориентир
(a mall, a school, a stop) or метро. The fragment is stored as exact positions in Unicode code points,
underlined in the card, listed under "Ваши выделения", and can be removed. Then

```bash
python review_to_training.py review/items.json review/review_results.json --out data/review-gold.jsonl
```

writes one row per card you ticked "checked in full": the model spans you confirmed plus your own
selections, in the same shape as `data/span-splits/*.jsonl`. Wrong model spans are left out; labels that
could not be judged (district / landmark on a card ticked before they existed) go into `ignore`.
These person-checked labels are the right *test set* for the models, and the only source for DISTRICT and
LANDMARK. A few hundred cards is far too little to teach landmarks (an open class: any shop, school or
park); district can also be bootstrapped from the database `district` / `area` columns, and landmarks from
cue words ("рядом с", "возле", "напротив", "ориентир"). Resolving a found district to a canonical place
belongs to `@whiteslove/geo-catalog` and `parsing-lexicon`, not to this model.

**From a phone (or two devices at once):** run `python review_server.py --dir review`. It prints a link
with a one-off key; open it on the PC and on the phone (same Wi-Fi). Answers from both are merged into
`review/review_results.json`, the file `compare_review.py` reads. Answers already made in a plain
`review.html` stay in that browser: press "Скачать результаты" there, then "Загрузить результаты" on the
served page. Plain HTTP on the local network, protected only by the key: use a home Wi-Fi you trust and
stop the server (Ctrl+C) when done.

## What the numbers mean (and don't)

Labels are **not** hand-made. They are the stored database values, located in the text by
`apps/flats/src/ml/span-align.js` (spans) and `field-evidence.js` (flags). Scores such as
"address F1 0.89" measure agreement with that alignment, not accuracy against a person.
A hand-checked sample is still needed before trusting the models in production.

Rules the labels follow, because earlier versions got them wrong:

* a stored `false` flag is only a label if the text denies the feature (`field-evidence.js`);
* span offsets are Unicode code points, not JS UTF-16 units (emoji shift them otherwise);
* other amounts / streets / stations in the same text are *neutral*: masked from loss and scoring;
* a station named after a city ("Toshkent") counts only next to a metro cue.

Known limits: texts are cut at 256 tokens (`truncated` in the response); several flats in
one post make the choice of "the" price ambiguous (`price.ambiguous`); streets written
without "ул." are only found when capitalised and followed by a house number.
