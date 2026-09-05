-- Store RaceResult's split NAME alongside its Label.
--
-- rr_splitname turned out to hold the RR *Label* (display text — "Service
-- station 1", may contain spaces/commas/accents), because contest-loading.ts
-- stores Label-else-Name. List expressions, however, must reference the RR
-- *Name* ("ServiceStation1" — RaceResult's editor forbids spaces in it).
--
-- rr_split_token carries that Name, so list provisioning and the splits
-- fingerprint can be driven from our own tables. Populated by the CMS
-- contest/splits loader and by provisioning (both call splits/get, which
-- returns Name and Label separately). NULL until an event is next reloaded.

ALTER TABLE v2.splits
  ADD COLUMN IF NOT EXISTS rr_split_token VARCHAR(150);

ALTER TABLE v2.legs
  ADD COLUMN IF NOT EXISTS rr_split_token VARCHAR(150);

COMMENT ON COLUMN v2.splits.rr_split_token IS
  'RaceResult split Name (expression token, e.g. ServiceStation1). rr_splitname holds the Label.';
COMMENT ON COLUMN v2.legs.rr_split_token IS
  'RaceResult leg Name (expression token). rr_label holds the Label.';
