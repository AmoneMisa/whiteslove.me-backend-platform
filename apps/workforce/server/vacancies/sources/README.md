# Vacancy source adapters

Each file represents an upstream vacancy source or a closely related source
family. Adapters may define targets, construct requests, parse responses and
normalize records into the vacancy contract.

Execution policy is external: no adapter-local scheduler, retry loop, queue
lease, concurrency limiter, result cap or successful page-depth limit.

Social transports are internal sidecars only. Semantic classification stays in
this directory so transport services remain product-neutral.
