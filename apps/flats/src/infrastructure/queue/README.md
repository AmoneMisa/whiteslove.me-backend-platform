# Queue infrastructure

This directory owns durable PostgreSQL mechanics for flat ingestion tasks.

- `pgQueue.js` handles enqueueing, leasing, retry state, recovery and atomic
  completion of queue tasks.
- `queueTaskDedup.js` prevents duplicate execution of the same logical task and
  maintains execution leases.

Queue payload construction and task dispatch belong to the application/worker
layer. This infrastructure layer persists and coordinates tasks; it must not
contain scraper selection or listing normalization rules.
