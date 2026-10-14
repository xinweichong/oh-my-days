-- More repeat rules for recurring tasks (improvement D3): "weekdays" (daily,
-- Monday to Friday) and "last_day" (monthly, last day of the month). NULL is a
-- plain rule. Intervals were already stored.
ALTER TABLE task_series ADD COLUMN by_rule TEXT CHECK (by_rule IN ('weekdays', 'last_day'));
