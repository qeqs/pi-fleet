// Run by hub.test.ts as a separate process, to write channels concurrently with its siblings.
import { Hub } from "../src/hub.ts";

const [dir, id] = process.argv.slice(2);
const hub = new Hub(dir);
for (let i = 0; i < 15; i++) hub.upsertChannel({ name: `c${id}-${i}`, members: [] });
