#!/usr/bin/env node
// The fleet runs from its TypeScript sources: tsx is a dependency, so there is no build step.
import { register } from "tsx/esm/api";

register();
await import("../src/fleet.ts");
