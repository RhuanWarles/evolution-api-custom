import { aesDecryptGCM, hkdf, jidNormalizedUser, proto } from 'baileys';

export type SecretMessageEditResult = {
  key: proto.IMessageKey;
  editedMessage: proto.IMessage;
  messageTimestamp?: number;
};

type SecretMessageEditInput = {
  envelope: proto.Message.ISecretEncryptedMessage;
  messageKey: proto.IMessageKey;
  targetMessage: proto.IWebMessageInfo | proto.IMessage | null | undefined;
  meId: string;
  meLid?: string;
  resolveLidToPn?: (jid: string) => Promise<string | undefined>;
  fallbackTimestamp?: number;
};

const toBytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  if (Array.isArray(value)) return new Uint8Array(value);

  if (value && typeof value === 'object') {
    const candidate = value as { data?: unknown; [key: string]: unknown };
    if (Array.isArray(candidate.data)) return new Uint8Array(candidate.data);

    const keys = Object.keys(candidate).filter((key) => /^\d+$/.test(key));
    if (keys.length > 0) {
      return new Uint8Array(keys.sort((a, b) => Number(a) - Number(b)).map((key) => Number(candidate[key])));
    }
  }

  return null;
};

const getMessageSecret = (message: proto.IWebMessageInfo | proto.IMessage | null | undefined) => {
  const content = (message as proto.IWebMessageInfo)?.message ?? message;
  return toBytes((content as proto.IMessage | undefined)?.messageContextInfo?.messageSecret);
};

const toTimestamp = (value: unknown, fallback?: number) => {
  if (value && typeof value === 'object' && 'toNumber' in value && typeof value.toNumber === 'function') {
    return Math.floor(value.toNumber() / 1000);
  }

  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp / 1000) : fallback;
};

const uniqueJids = (jids: Array<string | null | undefined>) => {
  const result: string[] = [];

  for (const jid of jids) {
    if (!jid) continue;

    const normalized = jidNormalizedUser(jid);
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }

  return result;
};

type MessageKeyWithAlt = proto.IMessageKey & {
  participantAlt?: string | null;
  remoteJidAlt?: string | null;
};

const keyJids = (key: proto.IMessageKey | null | undefined, meId: string, meLid?: string) => {
  const keyWithAlt = key as MessageKeyWithAlt | null | undefined;

  return keyWithAlt?.fromMe
    ? uniqueJids([meLid, meId])
    : uniqueJids([
        keyWithAlt?.participant,
        keyWithAlt?.remoteJid,
        keyWithAlt?.participantAlt,
        keyWithAlt?.remoteJidAlt,
      ]);
};

const targetMessageKey = (message: proto.IWebMessageInfo | proto.IMessage | null | undefined) =>
  (message as proto.IWebMessageInfo | undefined)?.key;

export const isSecretMessageEdit = (message: proto.IMessage | null | undefined) =>
  message?.secretEncryptedMessage?.secretEncType === proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT;

export const decryptSecretMessageEdit = async ({
  envelope,
  messageKey,
  targetMessage,
  meId,
  meLid,
  resolveLidToPn,
  fallbackTimestamp,
}: SecretMessageEditInput): Promise<SecretMessageEditResult | null> => {
  const targetKey = envelope.targetMessageKey;

  if (
    envelope.secretEncType !== proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT ||
    !envelope.targetMessageKey?.id
  ) {
    return null;
  }

  const messageSecret = getMessageSecret(targetMessage);
  const encPayload = toBytes(envelope.encPayload);
  const encIv = toBytes(envelope.encIv);

  if (!messageSecret || !encPayload || !encIv) {
    return null;
  }

  const originalJids = keyJids(targetKey, meId, meLid);
  const storedTargetJids = keyJids(targetMessageKey(targetMessage), meId, meLid);
  const editorJids = keyJids(messageKey, meId, meLid);

  if (targetKey.fromMe) {
    originalJids.push(...editorJids.filter((jid) => !originalJids.includes(jid)));
  }

  const resolvedOriginalJids = [];
  for (const jid of [...originalJids, ...storedTargetJids]) {
    resolvedOriginalJids.push(jid);
    const mappedPn = await resolveLidToPn?.(jid);
    if (mappedPn) resolvedOriginalJids.push(mappedPn);
  }

  for (const originalSenderJid of uniqueJids(resolvedOriginalJids)) {
    for (const editorJid of editorJids) {
      const useCaseSecret = Buffer.concat([
        Buffer.from(targetKey.id, 'utf8'),
        Buffer.from(originalSenderJid, 'utf8'),
        Buffer.from(editorJid, 'utf8'),
        Buffer.from('Message Edit', 'utf8'),
      ]);
      const decryptionKey = await hkdf(messageSecret, 32, { info: useCaseSecret.toString('latin1') });

      try {
        const decrypted = aesDecryptGCM(encPayload, decryptionKey, encIv, Buffer.alloc(0));
        const innerMessage = proto.Message.decode(decrypted);
        const editedMessage = innerMessage.protocolMessage?.editedMessage;

        if (!editedMessage) continue;

        return {
          key: { ...messageKey, ...targetKey, id: targetKey.id },
          editedMessage,
          messageTimestamp: toTimestamp(innerMessage.protocolMessage?.timestampMs, fallbackTimestamp),
        };
      } catch {
        // A wrong LID/PN candidate fails the GCM tag; try the next valid form.
      }
    }
  }

  return null;
};
