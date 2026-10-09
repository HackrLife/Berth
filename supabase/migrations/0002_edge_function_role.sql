-- The berth-api Edge Function connects as `postgres` and switches to the
-- restricted `berth_app` role inside every transaction (set local role).
grant berth_app to postgres;
