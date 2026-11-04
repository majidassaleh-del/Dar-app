/**
 * Provider payloads, built exactly as the provider APIs expect them and stored
 * on the notification row, so what was (or will be) sent is auditable.
 */

/** WhatsApp Business Cloud API: POST /{phone-number-id}/messages, template message. */
export function whatsappTemplate(to: string, template: string, languageCode: string, bodyParams: string[]) {
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, ''), type: 'template',
    template: { name: template, language: { code: languageCode },
      // Template variables may not contain newlines, tabs or 4+ consecutive spaces.
      components: [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text: text.replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').slice(0, 1000) })) }] },
  };
}

/** Firebase Cloud Messaging HTTP v1: POST /v1/projects/{project}/messages:send. */
export function fcmMessage(token: string, title: string, body: string, data: Record<string, string>) {
  return {
    message: {
      token, notification: { title, body }, data,
      android: { priority: 'HIGH', notification: { channel_id: 'reminders' } },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default', 'thread-id': data.kind ?? 'reminders' } } },
    },
  };
}
