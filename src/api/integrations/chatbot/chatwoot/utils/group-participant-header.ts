import { parsePhoneNumberFromString } from 'libphonenumber-js';

type GroupMessageBody = {
  pushName?: string | null;
  participant?: string | null;
  key?: {
    fromMe?: boolean | null;
    participant?: string | null;
    participantAlt?: string | null;
  } | null;
};

const isLidJid = (jid: string) => /@(hosted\.)?lid$/.test(jid);

const jidToNumber = (jid: string) => jid.split('@')[0].split(':')[0].trim();

/**
 * Picks the JID that identifies who sent the message inside the group.
 * Prefers a phone-number JID (participantAlt carries it when the key is LID-addressed,
 * participant carries it otherwise); only falls back to a LID when nothing else exists.
 */
function pickParticipantJid(body: GroupMessageBody) {
  const candidates = [body.key?.participantAlt, body.key?.participant, body.participant].filter(
    (jid): jid is string => typeof jid === 'string' && jid.trim() !== '',
  );

  return candidates.find((jid) => !isLidJid(jid)) ?? candidates[0];
}

/**
 * Builds the "**+55 62 9xxxx-xxxx - Name:**" header shown above messages received in a group.
 * Never throws: a LID, an invalid number or a missing participant degrade to the name only
 * (or the raw identifier when there is no name). Messages sent by the instance itself
 * (fromMe) have no header, so an empty string is returned.
 */
export function formatGroupParticipantHeader(body: GroupMessageBody): string {
  if (body?.key?.fromMe) return '';

  const jid = pickParticipantJid(body ?? {});
  const number = jid ? jidToNumber(jid) : '';
  const phone = number && !isLidJid(jid) ? parsePhoneNumberFromString(`+${number}`)?.formatInternational() : undefined;
  const name = typeof body?.pushName === 'string' ? body.pushName : '';

  const label = [phone, name].filter(Boolean).join(' - ') || number;

  return label ? `**${label}:**` : '';
}

/** Message content sent to Chatwoot for a group message: header (received only) + body. */
export function buildGroupMessageContent(body: GroupMessageBody, bodyMessage?: string | null): string {
  const header = formatGroupParticipantHeader(body);
  const text = bodyMessage || '';

  if (!header) return text;

  return text ? `${header}\n\n${text}` : header;
}
