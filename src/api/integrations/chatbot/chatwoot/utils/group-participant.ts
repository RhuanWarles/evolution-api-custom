type ParticipantKey = {
  remoteJid?: string | null;
  fromMe?: boolean | null;
  participant?: string | null;
  participantAlt?: string | null;
  addressingMode?: string | null;
};

type ParticipantMessage = {
  participant?: string | null;
  key?: ParticipantKey | null;
};

export type LidToPnResolver = (lid: string) => Promise<string | null | undefined> | string | null | undefined;

const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

export const isLidJid = (jid?: string | null): boolean => hasText(jid) && /@(hosted\.)?lid$/.test(jid);

/** A usable display name: non-empty and not a bare JID (a WhatsApp id is not a name). */
export const hasDisplayName = (name: unknown): name is string =>
  hasText(name) && !/^[\w.-]+(:\d+)?@(s\.whatsapp\.net|lid|hosted\.lid|hosted|g\.us|c\.us)$/.test(name.trim());

/** "5511999990000:12@s.whatsapp.net" -> "5511999990000@s.whatsapp.net" */
export const stripDeviceSuffix = (jid: string): string => jid.replace(/:\d+(?=@)/, '');

/**
 * Normalizes the group author of an incoming message in place, before it is stored or forwarded.
 *
 * Baileys' placeholder resend (`placeholderMessageResendResponse`) emits the decoded message with the
 * author outside the key (`message.participant`) and without `key.participant`/`participantAlt`/
 * `addressingMode`. This copies the author into the key, resolves a phone number for LID authors when
 * possible and flags LID addressing. Values already present are never overwritten, and a failing
 * LID lookup never prevents the message from being delivered.
 */
export async function normalizeGroupParticipant<T extends ParticipantMessage>(
  message: T,
  resolveLidToPn?: LidToPnResolver,
  onLookupError?: (error: unknown) => void,
): Promise<T> {
  const key = message?.key;
  if (!key?.remoteJid?.endsWith('@g.us')) return message;

  if (!hasText(key.participant) && hasText(message.participant)) {
    key.participant = message.participant;
  }

  if (!hasText(key.participant) || !isLidJid(key.participant)) return message;

  if (!hasText(key.addressingMode)) {
    key.addressingMode = 'lid';
  }

  if (!hasText(key.participantAlt) && resolveLidToPn) {
    try {
      const resolved = await resolveLidToPn(key.participant);
      if (hasText(resolved) && !isLidJid(resolved)) {
        key.participantAlt = stripDeviceSuffix(resolved);
      }
    } catch (error) {
      onLookupError?.(error);
    }
  }

  return message;
}

/**
 * Phone-number JID of the group author, or null when only a LID (or nothing) is known.
 * A LID is never returned: it must not be shown as a phone number nor become a contact's phone.
 */
export function resolveParticipantPhoneJid(message: ParticipantMessage | null | undefined): string | null {
  const candidates = [message?.key?.participantAlt, message?.key?.participant, message?.participant];
  const phoneJid = candidates.find((jid): jid is string => hasText(jid) && !isLidJid(jid));

  return phoneJid ? stripDeviceSuffix(phoneJid.trim()) : null;
}
