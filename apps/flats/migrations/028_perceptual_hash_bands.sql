-- Split the 64-bit perceptual hash into eight 8-bit bands. For a Hamming
-- threshold <= 7, at least one of eight bands must be an exact match
-- (pigeonhole principle), so the OR-prefilter preserves recall while avoiding
-- a country-wide newest-N scan before exact Hamming distance is evaluated.

CREATE INDEX IF NOT EXISTS listing_photo_hashes_phash_band_1_idx
  ON listing_photo_hashes(country, SUBSTRING(perceptual_hash FROM 1 FOR 2))
  WHERE perceptual_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS listing_photo_hashes_phash_band_2_idx
  ON listing_photo_hashes(country, SUBSTRING(perceptual_hash FROM 3 FOR 2))
  WHERE perceptual_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS listing_photo_hashes_phash_band_3_idx
  ON listing_photo_hashes(country, SUBSTRING(perceptual_hash FROM 5 FOR 2))
  WHERE perceptual_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS listing_photo_hashes_phash_band_4_idx
  ON listing_photo_hashes(country, SUBSTRING(perceptual_hash FROM 7 FOR 2))
  WHERE perceptual_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS listing_photo_hashes_phash_band_5_idx
  ON listing_photo_hashes(country, SUBSTRING(perceptual_hash FROM 9 FOR 2))
  WHERE perceptual_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS listing_photo_hashes_phash_band_6_idx
  ON listing_photo_hashes(country, SUBSTRING(perceptual_hash FROM 11 FOR 2))
  WHERE perceptual_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS listing_photo_hashes_phash_band_7_idx
  ON listing_photo_hashes(country, SUBSTRING(perceptual_hash FROM 13 FOR 2))
  WHERE perceptual_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS listing_photo_hashes_phash_band_8_idx
  ON listing_photo_hashes(country, SUBSTRING(perceptual_hash FROM 15 FOR 2))
  WHERE perceptual_hash IS NOT NULL;

ANALYZE listing_photo_hashes;
