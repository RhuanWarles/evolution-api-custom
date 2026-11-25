import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { hasDisplayName, isLidJid, resolveParticipantPhoneJid } from './group-participant';

type GroupMessageBody = {
  pushName?: string | null;
  participant?: string | null;
  key?: {
    fromMe?: boolean | null;
    participant?: string | null;
    participantAlt?: string | null;
  } | null;
};

/** Shown when a received group message has no identifiable author (no phone and no name). */
export const UNKNOWN_PARTICIPANT_LABEL = 'Participante desconhecido';

/**
 * Builds the "**+55 62 9xxxx-xxxx - Name:**" header shown above messages received in a group.
 * Never throws and never presents a LID as a phone number: a LID, an invalid number or a missing
 * participant degrade to the name only, or to a neutral label when there is no name either.
 * Messages sent by the instance itself (fromMe) have no header, so an empty string is returned.
 */
export function formatGroupParticipantHeader(body: GroupMessageBody): string {
  if (body?.key?.fromMe) return '';

  const jid = resolveParticipantPhoneJid(body ?? {});
  const number = jid ? jid.split('@')[0] : '';
  const phone = number && !isLidJid(jid) ? parsePhoneNumberFromString(`+${number}`)?.formatInternational() : undefined;
  const name = hasDisplayName(body?.pushName) ? body.pushName.trim() : '';

  const label = [phone, name].filter(Boolean).join(' - ') || UNKNOWN_PARTICIPANT_LABEL;

  return `**${label}:**`;
}

/** Message content sent to Chatwoot for a group message: header (received only) + body. */
export function buildGroupMessageContent(body: GroupMessageBody, bodyMessage?: string | null): string {
  const header = formatGroupParticipantHeader(body);
  const text = bodyMessage || '';

  if (!header) return text;

  return text ? `${header}\n\n${text}` : header;
}
