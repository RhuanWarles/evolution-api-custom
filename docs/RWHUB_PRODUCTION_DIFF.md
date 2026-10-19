# Production source comparison

This report was created before importing production customizations into the clean
upstream checkout.

## Comparison scope

- Production reference: `/home/deploy/evolution-group-mentions/src` on the VPS.
- Upstream reference: `EvolutionAPI/evolution-api` at commit
  `cd800f2976e1e5b682fbf86a01ee4d85ae61f370`, upstream tag `2.3.7`.
- Runtime reference: Node Evolution `2.3.7`, Baileys `7.0.0-rc.9`, image
  `evolution-api:group-reactions`.
- Result: 191 source files on each side; exactly two files differ.

## Difference classification

| Classification | Result |
| --- | --- |
| A — real production customization | The two Chatwoot integration files listed below. |
| B — generated artifact | `installed-main.js.map`; not copied or committed. |
| C — line-ending-only change | None found. The recovered files are LF-normalized text. |
| D — temporary/debug/snapshot data | `container-before.json` and `instances-before.json`; not copied or committed. |
| E — uncertain | None among the source files. The historical Dockerfile and patch files are retained as reconstruction evidence. |

## Production changes to preserve

1. `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts`
   - preserves `whatsapp_message_key` in Chatwoot message attributes;
   - maps group mentions using JID/LID values and passes them to Baileys;
   - confirms imported outbound messages through the Chatwoot Rails PATCH endpoint;
   - forwards group reactions to Chatwoot `reaction_events` with the Evolution
     reaction key header;
   - prevents a reaction from being represented as an ordinary timeline message.
2. `src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper.ts`
   - updates only `source_id` when associating an imported message, preserving
     the existing status and timestamps.

The broader LID/JID and participant handling already exists in the common
upstream source at this revision and is therefore not an independent diff, but
it remains in the resulting checkout.

## Recovered build evidence

- `Dockerfile` — the two-stage production wrapper based on
  `evoapicloud/evolution-api:v2.3.7`.
- `group-mentions.patch` — historical patch retained for traceability.
- `send-ack.patch` — historical patch retained for traceability.

The source files are the production source of truth because the reactions
customization was not represented by a separate patch file.

## Excluded from the repository

- environment files, credentials, API keys and database URLs;
- WhatsApp sessions and instance data;
- `container-before.json` and `instances-before.json`;
- `installed-main.js.map`, `dist`, `node_modules`, logs, caches and tarballs;
- Docker volume contents and database dumps.
