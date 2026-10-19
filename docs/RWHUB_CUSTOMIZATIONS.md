# Rwhub production baseline

This repository is the Git baseline reconstructed from the production Evolution
container before the message-editing work. It does not change production.

## Base runtime

- Upstream repository: `https://github.com/EvolutionAPI/evolution-api.git`
- Upstream tag: `2.3.7`
- Upstream commit: `cd800f2976e1e5b682fbf86a01ee4d85ae61f370`
- Runtime: Evolution API `2.3.7` on Node
- Baileys: `7.0.0-rc.9`
- Production image observed: `evolution-api:group-reactions`
- Production custom source reference: `/home/deploy/evolution-group-mentions`

The source directory on the VPS had no Git history. The repository history is
therefore intentionally based on the official upstream checkout, followed by a
single Rwhub customization commit.

## Customization inventory

| Customization | Files | Preserved? | Documented? |
| --- | --- | --- | --- |
| Chatwoot outbound attributes, including `whatsapp_message_key` | `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` | Yes | Yes |
| Group mentions with JID/LID normalization and Baileys `mentioned` values | `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` | Yes | Yes |
| Group reaction forwarding to Chatwoot `reaction_events` | `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` | Yes | Yes |
| Reaction authentication header and event metadata | `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` | Yes | Yes |
| Suppression of old reaction-as-message behavior | `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` | Yes | Yes |
| Send acknowledgement/status synchronization through Chatwoot Rails | `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` | Yes | Yes |
| Preserve imported status/timestamps while assigning `source_id` | `src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper.ts` | Yes | Yes |
| Existing LID/JID, participant and group handling from upstream | Related upstream files | Yes | Yes |

## Why these changes exist

The Chatwoot integration needs WhatsApp message keys to correlate outbound
messages, a stable source ID during history import, and an explicit status
confirmation so the Chatwoot conversation websocket receives the final state.
Group mentions must be translated from Chatwoot message attributes into the
JID/LID values expected by Baileys. Group reactions are sent as reaction events
to the mapped Chatwoot conversation, rather than creating a normal message in
the timeline.

The reaction implementation is preserved from the recovered production source
because no complete standalone reaction patch was present on the VPS.

## Build files

- `Dockerfile` remains the official upstream build definition at the base
  revision.
- `deploy/Dockerfile.rwhub-v2.3.7` preserves the two-stage wrapper observed in
  production. It compiles the repository `src` against
  `evoapicloud/evolution-api:v2.3.7` and copies the resulting `dist` into that
  runtime image.
- `patches/` contains the two historical patches recovered from the VPS for
  traceability. The checked-in source is authoritative because the reactions
  changes were not represented by a complete standalone patch.

## Scope of this baseline

This tag does not implement outbound WhatsApp message editing. That work must
be a subsequent commit/tag after this baseline is reviewed and validated.
