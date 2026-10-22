import { InstanceDto } from '@api/dto/instance.dto';
import { ChatwootDto } from '@api/integrations/chatbot/chatwoot/dto/chatwoot.dto';
import { postgresClient } from '@api/integrations/chatbot/chatwoot/libs/postgres.client';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { normalizeWhatsAppPhoneWithPlus } from '@api/integrations/chatbot/chatwoot/utils/contact-lookup';
import { Chatwoot, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { inbox } from '@figuro/chatwoot-sdk';
import { Chatwoot as ChatwootModel, Contact, Message } from '@prisma/client';
import { proto } from 'baileys';

type ChatwootUser = {
  user_type: string;
  user_id: number;
};

type FksChatwoot = {
  phone_number: string;
  contact_id: string;
  conversation_id: string;
};

type firstLastTimestamp = {
  first: number;
  last: number;
};

type IWebMessageInfo = Omit<proto.IWebMessageInfo, 'key'> & Partial<Pick<proto.IWebMessageInfo, 'key'>>;

class ChatwootImport {
  private logger = new Logger('ChatwootImport');
  private repositoryMessagesCache = new Map<string, Set<string>>();
  private historyMessages = new Map<string, Message[]>();
  private historyContacts = new Map<string, Contact[]>();

  public getRepositoryMessagesCache(instance: InstanceDto) {
    return this.repositoryMessagesCache.has(instance.instanceName)
      ? this.repositoryMessagesCache.get(instance.instanceName)
      : null;
  }

  public setRepositoryMessagesCache(instance: InstanceDto, repositoryMessagesCache: Set<string>) {
    this.repositoryMessagesCache.set(instance.instanceName, repositoryMessagesCache);
  }

  public deleteRepositoryMessagesCache(instance: InstanceDto) {
    this.repositoryMessagesCache.delete(instance.instanceName);
  }

  public addHistoryMessages(instance: InstanceDto, messagesRaw: Message[]) {
    const actualValue = this.historyMessages.has(instance.instanceName)
      ? this.historyMessages.get(instance.instanceName)
      : [];
    this.historyMessages.set(instance.instanceName, [...actualValue, ...messagesRaw]);
  }

  public addHistoryContacts(instance: InstanceDto, contactsRaw: Contact[]) {
    const actualValue = this.historyContacts.has(instance.instanceName)
      ? this.historyContacts.get(instance.instanceName)
      : [];
    this.historyContacts.set(instance.instanceName, actualValue.concat(contactsRaw));
  }

  public deleteHistoryMessages(instance: InstanceDto) {
    this.historyMessages.delete(instance.instanceName);
  }

  public deleteHistoryContacts(instance: InstanceDto) {
    this.historyContacts.delete(instance.instanceName);
  }

  public clearAll(instance: InstanceDto) {
    this.deleteRepositoryMessagesCache(instance);
    this.deleteHistoryMessages(instance);
    this.deleteHistoryContacts(instance);
  }

  public getHistoryMessagesLenght(instance: InstanceDto) {
    return this.historyMessages.get(instance.instanceName)?.length ?? 0;
  }

  public async importHistoryContacts(instance: InstanceDto, provider: ChatwootDto) {
    try {
      if (this.getHistoryMessagesLenght(instance) > 0) {
        return;
      }

      const pgClient = postgresClient.getChatwootConnection();

      let totalContactsImported = 0;

      const contacts = this.historyContacts.get(instance.instanceName) || [];
      if (contacts.length === 0) {
        return 0;
      }

      let contactsChunk: Contact[] = this.sliceIntoChunks(contacts, 3000);
      while (contactsChunk.length > 0) {
        const labelSql = `SELECT id FROM labels WHERE title = '${provider.nameInbox}' AND account_id = ${provider.accountId} LIMIT 1`;

        let labelId = (await pgClient.query(labelSql))?.rows[0]?.id;

        if (!labelId) {
          // creating label in chatwoot db and getting the id
          const sqlLabel = `INSERT INTO labels (title, color, show_on_sidebar, account_id, created_at, updated_at) VALUES ('${provider.nameInbox}', '#34039B', true, ${provider.accountId}, NOW(), NOW()) RETURNING id`;

          labelId = (await pgClient.query(sqlLabel))?.rows[0]?.id;
        }

        const contactIds: number[] = [];
        await pgClient.query('BEGIN');
        try {
          for (const contact of contactsChunk) {
            const isGroup = this.isIgnorePhoneNumber(contact.remoteJid);
            const phoneNumber = isGroup ? null : normalizeWhatsAppPhoneWithPlus(contact.remoteJid);
            const contactName = isGroup ? `${contact.pushName} (GROUP)` : contact.pushName;

            await pgClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
              `${provider.accountId}:${phoneNumber || contact.remoteJid}`,
            ]);

            const existingResult = await pgClient.query(
              `SELECT c.id, c.identifier, c.phone_number,
                      EXISTS (SELECT 1 FROM contact_inboxes ci WHERE ci.contact_id = c.id) AS has_inbox
                 FROM contacts c
                WHERE c.account_id = $1
                  AND (c.identifier = $2 OR ($3::text IS NOT NULL AND c.phone_number = $3))
                ORDER BY has_inbox DESC, (c.identifier = $2) DESC, c.id ASC
                LIMIT 1
                FOR UPDATE`,
              [provider.accountId, contact.remoteJid, phoneNumber],
            );

            let contactId = existingResult.rows[0]?.id;
            if (contactId) {
              const identifierConflict = await pgClient.query(
                `SELECT 1 FROM contacts
                  WHERE account_id = $1 AND identifier = $2 AND id <> $3
                  LIMIT 1`,
                [provider.accountId, contact.remoteJid, contactId],
              );

              await pgClient.query(
                `UPDATE contacts
                    SET name = COALESCE($1, name),
                        phone_number = COALESCE($2, phone_number),
                        identifier = CASE
                          WHEN (identifier IS NULL OR identifier = '') AND $4 = false THEN $3
                          ELSE identifier
                        END,
                        updated_at = NOW()
                  WHERE id = $5`,
                [contactName, phoneNumber, contact.remoteJid, identifierConflict.rowCount > 0, contactId],
              );
            } else {
              const inserted = await pgClient.query(
                `INSERT INTO contacts (name, phone_number, account_id, identifier, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, NOW(), NOW())
                 ON CONFLICT (identifier, account_id) DO NOTHING
                 RETURNING id`,
                [contactName, phoneNumber, provider.accountId, contact.remoteJid],
              );
              contactId = inserted.rows[0]?.id;
              if (contactId) totalContactsImported += 1;
            }

            if (!contactId) {
              const resolved = await pgClient.query(
                `SELECT id FROM contacts
                  WHERE account_id = $1
                    AND (identifier = $2 OR ($3::text IS NOT NULL AND phone_number = $3))
                  ORDER BY id ASC
                  LIMIT 1`,
                [provider.accountId, contact.remoteJid, phoneNumber],
              );
              contactId = resolved.rows[0]?.id;
            }

            if (contactId) contactIds.push(Number(contactId));
          }
          await pgClient.query('COMMIT');
        } catch (error) {
          await pgClient.query('ROLLBACK');
          throw error;
        }

        if (contactIds.length > 0) {
          const tag = await pgClient.query(
            `INSERT INTO tags (name, taggings_count)
             VALUES ($1, 0)
             ON CONFLICT (name) DO UPDATE SET taggings_count = tags.taggings_count
             RETURNING id`,
            [provider.nameInbox],
          );
          const tagId = tag.rows[0]?.id;

          for (const contactId of [...new Set(contactIds)]) {
            await pgClient.query(
              `INSERT INTO taggings (tag_id, taggable_type, taggable_id, context, created_at)
               SELECT $1, 'Contact', $2, 'labels', NOW()
                WHERE NOT EXISTS (
                  SELECT 1 FROM taggings
                   WHERE tag_id = $1 AND taggable_type = 'Contact' AND taggable_id = $2 AND context = 'labels'
                )`,
              [tagId, contactId],
            );
          }

          await pgClient.query(
            `UPDATE tags SET taggings_count = (
               SELECT COUNT(*) FROM taggings WHERE tag_id = $1 AND context = 'labels'
             ) WHERE id = $1`,
            [tagId],
          );
        }

        contactsChunk = this.sliceIntoChunks(contacts, 3000);
      }

      this.deleteHistoryContacts(instance);

      return totalContactsImported;
    } catch (error) {
      this.logger.error(`Error on import history contacts: ${error.toString()}`);
    }
  }

  public async getExistingSourceIds(sourceIds: string[], conversationId?: number): Promise<Set<string>> {
    try {
      const existingSourceIdsSet = new Set<string>();

      if (sourceIds.length === 0) {
        return existingSourceIdsSet;
      }

      // Ensure all sourceIds are consistently prefixed with 'WAID:' as required by downstream systems and database queries.
      const formattedSourceIds = sourceIds.map((sourceId) => `WAID:${sourceId.replace('WAID:', '')}`);
      const pgClient = postgresClient.getChatwootConnection();

      const params = conversationId ? [formattedSourceIds, conversationId] : [formattedSourceIds];

      const query = conversationId
        ? 'SELECT source_id FROM messages WHERE source_id = ANY($1) AND conversation_id = $2'
        : 'SELECT source_id FROM messages WHERE source_id = ANY($1)';

      const result = await pgClient.query(query, params);
      for (const row of result.rows) {
        existingSourceIdsSet.add(row.source_id);
      }

      return existingSourceIdsSet;
    } catch (error) {
      this.logger.error(`Error on getExistingSourceIds: ${error.toString()}`);
      return new Set<string>();
    }
  }

  public async importHistoryMessages(
    instance: InstanceDto,
    chatwootService: ChatwootService,
    inbox: inbox,
    provider: ChatwootModel,
  ) {
    try {
      const pgClient = postgresClient.getChatwootConnection();

      const chatwootUser = await this.getChatwootUser(provider);
      if (!chatwootUser) {
        throw new Error('User not found to import messages.');
      }

      let totalMessagesImported = 0;

      let messagesOrdered = this.historyMessages.get(instance.instanceName) || [];
      if (messagesOrdered.length === 0) {
        return 0;
      }

      // ordering messages by number and timestamp asc
      messagesOrdered.sort((a, b) => {
        const aKey = a.key as {
          remoteJid: string;
        };

        const bKey = b.key as {
          remoteJid: string;
        };

        const aMessageTimestamp = a.messageTimestamp as any as number;
        const bMessageTimestamp = b.messageTimestamp as any as number;

        return parseInt(aKey.remoteJid) - parseInt(bKey.remoteJid) || aMessageTimestamp - bMessageTimestamp;
      });

      const allMessagesMappedByPhoneNumber = this.createMessagesMapByPhoneNumber(messagesOrdered);
      // Map structure: +552199999999 => { first message timestamp from number, last message timestamp from number}
      const phoneNumbersWithTimestamp = new Map<string, firstLastTimestamp>();
      allMessagesMappedByPhoneNumber.forEach((messages: Message[], phoneNumber: string) => {
        phoneNumbersWithTimestamp.set(phoneNumber, {
          first: messages[0]?.messageTimestamp as any as number,
          last: messages[messages.length - 1]?.messageTimestamp as any as number,
        });
      });

      const existingSourceIds = await this.getExistingSourceIds(messagesOrdered.map((message: any) => message.key.id));
      messagesOrdered = messagesOrdered.filter((message: any) => !existingSourceIds.has(message.key.id));
      // processing messages in batch
      const batchSize = 4000;
      let messagesChunk: Message[] = this.sliceIntoChunks(messagesOrdered, batchSize);
      while (messagesChunk.length > 0) {
        // Map structure: +552199999999 => Message[]
        const messagesByPhoneNumber = this.createMessagesMapByPhoneNumber(messagesChunk);

        if (messagesByPhoneNumber.size > 0) {
          const fksByNumber = await this.selectOrCreateFksFromChatwoot(
            provider,
            inbox,
            phoneNumbersWithTimestamp,
            messagesByPhoneNumber,
          );

          // inserting messages in chatwoot db
          let sqlInsertMsg = `INSERT INTO messages
            (content, processed_message_content, account_id, inbox_id, conversation_id, message_type, private, content_type,
            sender_type, sender_id, source_id, created_at, updated_at) VALUES `;
          const bindInsertMsg = [provider.accountId, inbox.id];

          messagesByPhoneNumber.forEach((messages: any[], phoneNumber: string) => {
            const fksChatwoot = fksByNumber.get(phoneNumber);

            messages.forEach((message) => {
              if (!message.message) {
                return;
              }

              if (!fksChatwoot?.conversation_id || !fksChatwoot?.contact_id) {
                return;
              }

              const contentMessage = this.getContentMessage(chatwootService, message);
              if (!contentMessage) {
                return;
              }

              bindInsertMsg.push(contentMessage);
              const bindContent = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(fksChatwoot.conversation_id);
              const bindConversationId = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.key.fromMe ? '1' : '0');
              const bindMessageType = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.key.fromMe ? chatwootUser.user_type : 'Contact');
              const bindSenderType = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.key.fromMe ? chatwootUser.user_id : fksChatwoot.contact_id);
              const bindSenderId = `$${bindInsertMsg.length}`;

              bindInsertMsg.push('WAID:' + message.key.id);
              const bindSourceId = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.messageTimestamp as number);
              const bindmessageTimestamp = `$${bindInsertMsg.length}`;

              sqlInsertMsg += `(${bindContent}, ${bindContent}, $1, $2, ${bindConversationId}, ${bindMessageType}, FALSE, 0,
                  ${bindSenderType},${bindSenderId},${bindSourceId}, to_timestamp(${bindmessageTimestamp}), to_timestamp(${bindmessageTimestamp})),`;
            });
          });
          if (bindInsertMsg.length > 2) {
            if (sqlInsertMsg.slice(-1) === ',') {
              sqlInsertMsg = sqlInsertMsg.slice(0, -1);
            }
            totalMessagesImported += (await pgClient.query(sqlInsertMsg, bindInsertMsg))?.rowCount ?? 0;
          }
        }
        messagesChunk = this.sliceIntoChunks(messagesOrdered, batchSize);
      }

      this.deleteHistoryMessages(instance);
      this.deleteRepositoryMessagesCache(instance);

      const providerData: ChatwootDto = {
        ...provider,
        ignoreJids: Array.isArray(provider.ignoreJids) ? provider.ignoreJids.map((event) => String(event)) : [],
      };

      this.importHistoryContacts(instance, providerData);

      return totalMessagesImported;
    } catch (error) {
      this.logger.error(`Error on import history messages: ${error.toString()}`);

      this.deleteHistoryMessages(instance);
      this.deleteRepositoryMessagesCache(instance);
    }
  }

  public async selectOrCreateFksFromChatwoot(
    provider: ChatwootModel,
    inbox: inbox,
    phoneNumbersWithTimestamp: Map<string, firstLastTimestamp>,
    messagesByPhoneNumber: Map<string, Message[]>,
  ): Promise<Map<string, FksChatwoot>> {
    const pgClient = postgresClient.getChatwootConnection();
    const resolved = new Map<string, FksChatwoot>();

    await pgClient.query('BEGIN');
    try {
      for (const phoneNumber of messagesByPhoneNumber.keys()) {
        const timestamp = phoneNumbersWithTimestamp.get(phoneNumber);
        if (!timestamp) continue;

        const identifier = `${phoneNumber.replace('+', '')}@s.whatsapp.net`;
        await pgClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${provider.accountId}:${phoneNumber}`,
        ]);

        let contactResult = await pgClient.query(
          `SELECT id, identifier, phone_number
             FROM contacts
            WHERE account_id = $1 AND phone_number = $2
            ORDER BY id ASC
            LIMIT 1
            FOR UPDATE`,
          [provider.accountId, phoneNumber],
        );

        let contactId = contactResult.rows[0]?.id;
        if (!contactId) {
          const inserted = await pgClient.query(
            `INSERT INTO contacts (name, phone_number, account_id, identifier, created_at, updated_at)
             VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6))
             ON CONFLICT (identifier, account_id) DO NOTHING
             RETURNING id`,
            [
              phoneNumber.replace('+', ''),
              phoneNumber,
              provider.accountId,
              identifier,
              timestamp.first,
              timestamp.last,
            ],
          );
          contactId = inserted.rows[0]?.id;
        }

        if (contactId && contactResult.rows[0]?.identifier !== identifier) {
          const identifierConflict = await pgClient.query(
            `SELECT 1 FROM contacts WHERE account_id = $1 AND identifier = $2 AND id <> $3 LIMIT 1`,
            [provider.accountId, identifier, contactId],
          );
          if (identifierConflict.rowCount === 0) {
            await pgClient.query(
              `UPDATE contacts SET identifier = $1, updated_at = NOW() WHERE id = $2 AND (identifier IS NULL OR identifier = '')`,
              [identifier, contactId],
            );
          }
        }

        if (!contactId) {
          contactResult = await pgClient.query(
            `SELECT id FROM contacts
              WHERE account_id = $1 AND (phone_number = $2 OR identifier = $3)
              ORDER BY id ASC
              LIMIT 1
              FOR UPDATE`,
            [provider.accountId, phoneNumber, identifier],
          );
          contactId = contactResult.rows[0]?.id;
        }

        if (!contactId) continue;

        const contactInboxResult = await pgClient.query(
          `SELECT id FROM contact_inboxes WHERE contact_id = $1 AND inbox_id = $2 LIMIT 1 FOR UPDATE`,
          [contactId, inbox.id],
        );
        let contactInboxId = contactInboxResult.rows[0]?.id;
        if (!contactInboxId) {
          const insertedContactInbox = await pgClient.query(
            `INSERT INTO contact_inboxes (contact_id, inbox_id, source_id, created_at, updated_at)
             VALUES ($1, $2, gen_random_uuid(), NOW(), NOW())
             RETURNING id`,
            [contactId, inbox.id],
          );
          contactInboxId = insertedContactInbox.rows[0]?.id;
        }

        const conversationResult = await pgClient.query(
          `SELECT id FROM conversations
            WHERE account_id = $1 AND inbox_id = $2 AND contact_id = $3 AND contact_inbox_id = $4
            ORDER BY id ASC
            LIMIT 1
            FOR UPDATE`,
          [provider.accountId, inbox.id, contactId, contactInboxId],
        );
        let conversationId = conversationResult.rows[0]?.id;
        if (!conversationId) {
          const insertedConversation = await pgClient.query(
            `INSERT INTO conversations
              (account_id, inbox_id, status, contact_id, contact_inbox_id, uuid, last_activity_at, created_at, updated_at)
             VALUES ($1, $2, 0, $3, $4, gen_random_uuid(), to_timestamp($5), to_timestamp($5), to_timestamp($5))
             RETURNING id`,
            [provider.accountId, inbox.id, contactId, contactInboxId, timestamp.first],
          );
          conversationId = insertedConversation.rows[0]?.id;
        }

        if (contactInboxId && conversationId) {
          resolved.set(phoneNumber, {
            phone_number: phoneNumber,
            contact_id: String(contactId),
            conversation_id: String(conversationId),
          });
        }
      }
      await pgClient.query('COMMIT');
    } catch (error) {
      await pgClient.query('ROLLBACK');
      throw error;
    }

    return resolved;
  }

  public async getChatwootUser(provider: ChatwootModel): Promise<ChatwootUser> {
    try {
      const pgClient = postgresClient.getChatwootConnection();

      const sqlUser = `SELECT owner_type AS user_type, owner_id AS user_id
                         FROM access_tokens
                       WHERE token = $1`;

      return (await pgClient.query(sqlUser, [provider.token]))?.rows[0] || false;
    } catch (error) {
      this.logger.error(`Error on getChatwootUser: ${error.toString()}`);
    }
  }

  public createMessagesMapByPhoneNumber(messages: Message[]): Map<string, Message[]> {
    return messages.reduce((acc: Map<string, Message[]>, message: Message) => {
      const key = message?.key as {
        remoteJid: string;
      };
      if (!this.isIgnorePhoneNumber(key?.remoteJid)) {
        const phoneNumberPlus = normalizeWhatsAppPhoneWithPlus((key as any)?.remoteJidAlt || key?.remoteJid);
        if (phoneNumberPlus) {
          const messages = acc.has(phoneNumberPlus) ? acc.get(phoneNumberPlus) : [];
          messages.push(message);
          acc.set(phoneNumberPlus, messages);
        }
      }

      return acc;
    }, new Map());
  }

  public async getContactsOrderByRecentConversations(
    inbox: inbox,
    provider: ChatwootModel,
    limit = 50,
  ): Promise<{ id: number; phone_number: string; identifier: string }[]> {
    try {
      const pgClient = postgresClient.getChatwootConnection();

      const sql = `SELECT contacts.id, contacts.identifier, contacts.phone_number
                     FROM conversations
                   JOIN contacts ON contacts.id = conversations.contact_id
                   WHERE conversations.account_id = $1
                     AND inbox_id = $2
                   ORDER BY conversations.last_activity_at DESC
                   LIMIT $3`;

      return (await pgClient.query(sql, [provider.accountId, inbox.id, limit]))?.rows;
    } catch (error) {
      this.logger.error(`Error on get recent conversations: ${error.toString()}`);
    }
  }

  public getContentMessage(chatwootService: ChatwootService, msg: IWebMessageInfo) {
    const contentMessage = chatwootService.getConversationMessage(msg.message);
    if (contentMessage) {
      return contentMessage;
    }

    if (!configService.get<Chatwoot>('CHATWOOT').IMPORT.PLACEHOLDER_MEDIA_MESSAGE) {
      return '';
    }

    const types = {
      documentMessage: msg.message.documentMessage,
      documentWithCaptionMessage: msg.message.documentWithCaptionMessage?.message?.documentMessage,
      imageMessage: msg.message.imageMessage,
      videoMessage: msg.message.videoMessage,
      audioMessage: msg.message.audioMessage,
      stickerMessage: msg.message.stickerMessage,
      templateMessage: msg.message.templateMessage?.hydratedTemplate?.hydratedContentText,
    };

    const typeKey = Object.keys(types).find((key) => types[key] !== undefined && types[key] !== null);
    switch (typeKey) {
      case 'documentMessage': {
        const doc = msg.message.documentMessage;
        const fileName = doc?.fileName || 'document';
        const caption = doc?.caption ? ` ${doc.caption}` : '';
        return `_<File: ${fileName}${caption}>_`;
      }

      case 'documentWithCaptionMessage': {
        const doc = msg.message.documentWithCaptionMessage?.message?.documentMessage;
        const fileName = doc?.fileName || 'document';
        const caption = doc?.caption ? ` ${doc.caption}` : '';
        return `_<File: ${fileName}${caption}>_`;
      }

      case 'templateMessage': {
        const template = msg.message.templateMessage?.hydratedTemplate;
        return (
          (template?.hydratedTitleText ? `*${template.hydratedTitleText}*\n` : '') +
          (template?.hydratedContentText || '')
        );
      }

      case 'imageMessage':
        return '_<Image Message>_';

      case 'videoMessage':
        return '_<Video Message>_';

      case 'audioMessage':
        return '_<Audio Message>_';

      case 'stickerMessage':
        return '_<Sticker Message>_';

      default:
        return '';
    }
  }

  public sliceIntoChunks(arr: any[], chunkSize: number) {
    return arr.splice(0, chunkSize);
  }

  public isGroup(remoteJid: string) {
    return remoteJid.includes('@g.us');
  }

  public isIgnorePhoneNumber(remoteJid: string) {
    return this.isGroup(remoteJid) || remoteJid === 'status@broadcast' || remoteJid === '0@s.whatsapp.net';
  }

  public updateMessageSourceID(messageId: string | number, sourceId: string) {
    const pgClient = postgresClient.getChatwootConnection();

    const sql = `UPDATE messages SET source_id = $1 WHERE id = $2;`;

    return pgClient.query(sql, [`WAID:${sourceId}`, messageId]);
  }
}

export const chatwootImport = new ChatwootImport();
