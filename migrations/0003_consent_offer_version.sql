-- Bind outstanding consent challenges to the notice actually offered.
ALTER TABLE users ADD COLUMN consent_offer_version text;
