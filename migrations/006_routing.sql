-- Tiered routing (Keel AI Routing guide, Nov 28): which ladder rung served a
-- turn, the tool the model called, and the rung a moved-up run came from, so
-- a weekly query can show cost and moves up per task type.
alter table usage_ledger
  add column tier text check (tier in ('cheap', 'mid', 'top')),
  add column tool_called text,
  add column escalated_from text check (escalated_from in ('cheap', 'mid', 'top'));

create index usage_ledger_task_time_idx on usage_ledger(task_type, created_at);
