// Run by hub.test.ts as a separate process, to write channels concurrently with its siblings.
// Given a third argument, it creates that file just before it starts writing.
import fs from "node:fs";
import { Hub } from "../src/hub.ts";

const [dir, id, ready] = process.argv.slice(2);
const hub = new Hub(dir);
if (ready) fs.writeFileSync(ready, "");
for (let i = 0; i < 15; i++) hub.upsertChannel({ name: `c${id}-${i}`, members: [] });
