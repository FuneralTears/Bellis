/**
 * A process that is interrupted while it works on production, for tests/release-target.mjs. It links the fake CLI
 * to production, then receives SIGINT in the middle of the step. What matters is where the CLI is left when the
 * process ends, and its exit code. (On Windows a real Ctrl+C reaches Node as this same SIGINT event.)
 */
import { createSupabase } from "../../scripts/release/lib/supabase.mjs";
import { withTarget } from "../../scripts/release/lib/target.mjs";

const [fake, workdir, signal = "SIGINT"] = process.argv.slice(2);
const supabase = createSupabase({ cwd: workdir, command: [process.execPath, fake], environment: process.env });
await withTarget(supabase, "production", async () => {
  process.stdout.write(`on:${supabase.linkedRef()}\n`);
  setTimeout(() => process.emit(signal, signal), 20);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  process.stdout.write("the step finished: it should have been interrupted\n");
}, { environment: process.env, log: (text) => process.stdout.write(`${text}\n`) });
