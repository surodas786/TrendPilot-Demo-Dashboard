-- Separate databases so automated tests never touch development data.
CREATE DATABASE trendpilot_test OWNER trendpilot;
CREATE DATABASE trendpilot_e2e OWNER trendpilot;
