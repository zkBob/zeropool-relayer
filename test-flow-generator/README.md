# Test flow generation tool

This tool allows you to describe a test flow via json:
1. Install dependencies. Run `yarn`
2. Describe a `Flow` object (structure can be found in `src/types.ts`) in `flow.json`
3. Run `./scripts/generate.sh`
4. Find your flow in `flows` directory