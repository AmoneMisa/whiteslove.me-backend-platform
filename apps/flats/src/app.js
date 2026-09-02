import express from 'express';
import cors from 'cors';
import {installTranslationRoutes} from './routes/translation-routes.js';
import {installSocialRoutes} from './routes/social-routes.js';
import {installAvailabilityRoutes} from './routes/availability-routes.js';
import {installSystemRoutes} from './routes/system-routes.js';
import {installListingRoutes} from './routes/listing-routes.js';
import {installListingItemRoutes} from './routes/listing-item-routes.js';
import {installMobileListingRoutes} from './routes/mobile-listing-routes.js';
import {installStatisticsRoutes} from './support/statistics-snapshot.js';
import {installCatalogRoutes} from './routes/catalog-routes.js';
import {installMediaRoutes} from './routes/media-routes.js';
import {checkRate} from './support/request-rate-limit.js';
import {registerMobileSubscriptionRoutes} from './mobile/mobile-subscriptions.js';

export function createApp() {
  const app = express();

  // Production exposes the API only on host loopback and serves public traffic
  // through one reverse-proxy hop. Trust that hop so req.ip reflects the actual
  // client instead of making process-local flood protection global to nginx.
  app.set('trust proxy', 1);

  app.use(cors());
  app.use(express.json());

  // A custom-source request can enqueue external fetch work in the PostgreSQL
  // worker queue. Keep ordinary PostgreSQL listing reads unrestricted while
  // placing a small per-client guard around on-demand custom ingestion.
  app.use('/api/listings', (req, res, next) => {
    const hasCustomSources = String(req.query?.customSources || '').trim().length > 0;
    if (hasCustomSources && !checkRate(req, res, 'customSourceSearch', 3000)) return;
    next();
  });

  installTranslationRoutes(app);
  installSocialRoutes(app);
  installAvailabilityRoutes(app);
  installSystemRoutes(app);
  installListingRoutes(app);
  installMobileListingRoutes(app);
  installStatisticsRoutes(app);
  installListingItemRoutes(app);
  installCatalogRoutes(app);
  installMediaRoutes(app);
  registerMobileSubscriptionRoutes(app);

  return app;
}
