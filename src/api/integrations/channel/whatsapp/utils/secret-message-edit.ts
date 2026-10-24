import { aesDecryptGCM, hmacSign, jidNormalizedUser, proto } from 'baileys';

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
  onDiagnostic?: (diagnostic: SecretMessageEditDiagnostic) => void;
};

export type SecretMessageEditFailure =
  | 'invalid_envelope'
  | 'target_not_found'
  | 'message_secret_missing'
  | 'payload_invalid'
  | 'decrypt_auth_failed'
  | 'decoded_payload_invalid'
  | 'edited_content_missing';

export type SecretMessageEditDiagnostic = {
  failure?: SecretMessageEditFailure;
  targetFound: boolean;
  messageSecretLength: number;
  payloadLength: number;
  ivLength: number;
  attempts: Array<{
    originalSender: string;
    editor: string;
    authenticated: boolean;
  }>;
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

export const getMessageSecret = (message: proto.IWebMessageInfo | proto.IMessage | null | undefined) => {
  const webMessageInfo = message as proto.IWebMessageInfo | undefined;
  const content = webMessageInfo?.message ?? message;
  const persistedContextInfo = (
    webMessageInfo as (proto.IWebMessageInfo & { contextInfo?: proto.IMessageContextInfo }) | undefined
  )?.contextInfo;
  const nestedContextInfo =
    content && typeof content === 'object'
      ? Object.values(content as Record<string, unknown>)
          .map((value) => (value as { contextInfo?: proto.IMessageContextInfo } | null)?.contextInfo)
          .find((contextInfo) => contextInfo?.messageSecret)
      : undefined;

  return (
    toBytes(webMessageInfo?.messageSecret) ||
    toBytes((content as proto.IMessage | undefined)?.messageContextInfo?.messageSecret) ||
    toBytes(nestedContextInfo?.messageSecret) ||
    toBytes(persistedContextInfo?.messageSecret)
  );
};

export const preserveMessageSecret = (message: proto.IMessage, messageSecret?: unknown) => {
  const normalizedSecret = toBytes(messageSecret);
  if (!normalizedSecret?.length) return message;

  return {
    ...message,
    messageContextInfo: {
      ...message.messageContextInfo,
      messageSecret: normalizedSecret,
    },
  };
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

const jidType = (jid: string) => {
  if (jid.endsWith('@lid')) return 'LID';
  if (jid.endsWith('@s.whatsapp.net')) return 'PN';
  if (jid.endsWith('@g.us')) return 'GROUP';
  return 'OTHER';
};

type MessageKeyWithAlt = proto.IMessageKey & {
  participantAlt?: string | null;
  remoteJidAlt?: string | null;
};

type MessageLookupRetryOptions = {
  attempts?: number;
  delayMs?: number;
};

export const retryMessageLookup = async <T>(
  lookup: () => Promise<T | null | undefined>,
  { attempts = 6, delayMs = 250 }: MessageLookupRetryOptions = {},
) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await lookup();

    if (result) return result;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return undefined;
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

export const deriveSecretMessageEditKey = (
  messageSecret: Uint8Array,
  targetMessageId: string,
  originalSenderJid: string,
  editorJid: string,
) => {
  const useCaseSecret = Buffer.concat([
    Buffer.from(targetMessageId, 'utf8'),
    Buffer.from(originalSenderJid, 'utf8'),
    Buffer.from(editorJid, 'utf8'),
    Buffer.from('Message Edit', 'utf8'),
    Buffer.from([0x01]),
  ]);
  const intermediateKey = hmacSign(messageSecret, Buffer.alloc(32), 'sha256');

  return hmacSign(useCaseSecret, intermediateKey, 'sha256');
};

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
  onDiagnostic,
}: SecretMessageEditInput): Promise<SecretMessageEditResult | null> => {
  const targetKey = envelope.targetMessageKey;
  const targetFound = Boolean(targetMessage);
  const messageSecret = getMessageSecret(targetMessage);
  const encPayload = toBytes(envelope.encPayload);
  const encIv = toBytes(envelope.encIv);
  const diagnostic: SecretMessageEditDiagnostic = {
    targetFound,
    messageSecretLength: messageSecret?.length || 0,
    payloadLength: encPayload?.length || 0,
    ivLength: encIv?.length || 0,
    attempts: [],
  };

  if (
    envelope.secretEncType !== proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT ||
    !envelope.targetMessageKey?.id
  ) {
    diagnostic.failure = 'invalid_envelope';
    onDiagnostic?.(diagnostic);
    return null;
  }

  if (!targetFound) {
    diagnostic.failure = 'target_not_found';
    onDiagnostic?.(diagnostic);
    return null;
  }

  if (!messageSecret) {
    diagnostic.failure = 'message_secret_missing';
    onDiagnostic?.(diagnostic);
    return null;
  }

  if (!encPayload || encPayload.length <= 16 || !encIv) {
    diagnostic.failure = 'payload_invalid';
    onDiagnostic?.(diagnostic);
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
      const decryptionKey = deriveSecretMessageEditKey(messageSecret, targetKey.id, originalSenderJid, editorJid);
      const attempt = {
        originalSender: jidType(originalSenderJid),
        editor: jidType(editorJid),
        authenticated: false,
      };
      diagnostic.attempts.push(attempt);

      try {
        const decrypted = aesDecryptGCM(encPayload, decryptionKey, encIv, Buffer.alloc(0));
        attempt.authenticated = true;

        let innerMessage: proto.Message;
        try {
          innerMessage = proto.Message.decode(decrypted);
        } catch {
          diagnostic.failure = 'decoded_payload_invalid';
          continue;
        }

        const editedMessage = innerMessage.protocolMessage?.editedMessage;

        if (!editedMessage) continue;

        onDiagnostic?.(diagnostic);

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

  diagnostic.failure = diagnostic.attempts.some((attempt) => attempt.authenticated)
    ? 'edited_content_missing'
    : 'decrypt_auth_failed';
  onDiagnostic?.(diagnostic);
  return null;
};
