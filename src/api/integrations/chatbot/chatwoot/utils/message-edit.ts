export type WhatsAppMessageKeyLike = {
  id?: string | null;
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  participant?: string | null;
  participantAlt?: string | null;
  fromMe?: boolean | null;
  from_me?: boolean | null;
};

export function extractEditedMessageText(body: any): string | null {
  const editedMessage = body?.editedMessage;
  const text =
    editedMessage?.conversation ??
    editedMessage?.extendedTextMessage?.text ??
    editedMessage?.imageMessage?.caption ??
    editedMessage?.videoMessage?.caption ??
    editedMessage?.documentMessage?.caption ??
    (typeof body?.text === 'string' ? body.text : undefined);

  if (typeof text !== 'string') return null;

  const normalized = text.trim();
  return normalized || null;
}

export function whatsappMessageKeysMatch(eventKey: WhatsAppMessageKeyLike, storedKey: WhatsAppMessageKeyLike) {
  if (!eventKey?.id || !storedKey?.id || String(eventKey.id) !== String(storedKey.id)) {
    return false;
  }

  const eventFromMe = eventKey.fromMe ?? eventKey.from_me;
  const storedFromMe = storedKey.fromMe ?? storedKey.from_me;
  if (eventFromMe !== undefined && storedFromMe !== undefined && eventFromMe !== storedFromMe) {
    return false;
  }

  const jids = (value: WhatsAppMessageKeyLike) =>
    [value.remoteJid, value.remoteJidAlt, value.participant, value.participantAlt].filter(
      (jid): jid is string => typeof jid === 'string' && jid.length > 0,
    );
  const eventJids = jids(eventKey);
  const storedJids = jids(storedKey);

  return eventJids.length === 0 || storedJids.length === 0 || eventJids.some((jid) => storedJids.includes(jid));
}
