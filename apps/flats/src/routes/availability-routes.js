import {readListingAvailability} from '../availability/availability-sweep.js';

export function installAvailabilityRoutes(app) {
  // Compatibility endpoint for existing clients. It only reads persisted
  // availability state; source checks are performed by the isolated worker.
  // Schema ownership belongs to versioned migrations, not application setup.
  app.post('/api/listings/verify', async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      return res.json({results: []});
    }

    try {
      const results = await readListingAvailability(items);
      return res.json({results, verificationOwner: 'worker'});
    } catch (error) {
      console.warn('[availability] state read failed:', error?.message ?? error);
      return res.status(500).json({
        error: error?.message ?? String(error),
        results: [],
      });
    }
  });
}
