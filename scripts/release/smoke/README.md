# smoke/

The runner of the SQL smokes in `supabase/tests/`: each one inside a single transaction that ends in `ROLLBACK`, and a smoke only passes when the CLI exits 0, prints no error and returns a row.

Empty for now (phase 3).
