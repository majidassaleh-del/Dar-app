export type Channel = 'PUSH' | 'WHATSAPP' | 'IN_APP' | 'EMAIL' | 'SMS';
export interface SendResult { status: 'SENT' | 'QUEUED' | 'FAILED'; providerMessageId?: string; error?: string }
export interface ChannelSender { send(channel: Channel, payload: unknown): Promise<SendResult> }

/** No provider configured (dev / CI): deliveries stay QUEUED with their payload; nothing leaves the machine. */
export class OutboxSender implements ChannelSender {
  async send(channel: Channel): Promise<SendResult> {
    return channel === 'IN_APP' ? { status: 'SENT' } : { status: 'QUEUED', error: 'no provider configured' };
  }
}

/**
 * Real providers over fetch. NOT exercised against the live APIs in this repo:
 * WhatsApp needs an approved Business account, templates and a token; FCM
 * needs a service-account OAuth token (pass `fcmAccessToken`).
 */
export class HttpSender implements ChannelSender {
  constructor(private readonly cfg: { whatsappPhoneNumberId?: string; whatsappToken?: string; fcmProjectId?: string;
    fcmAccessToken?: () => Promise<string>; fetch?: typeof fetch; graphVersion?: string }) {}

  async send(channel: Channel, payload: unknown): Promise<SendResult> {
    const f = this.cfg.fetch ?? fetch;
    try {
      if (channel === 'IN_APP') return { status: 'SENT' };
      if (channel === 'WHATSAPP' && this.cfg.whatsappPhoneNumberId && this.cfg.whatsappToken) {
        const r = await f(`https://graph.facebook.com/${this.cfg.graphVersion ?? 'v21.0'}/${this.cfg.whatsappPhoneNumberId}/messages`, {
          method: 'POST', headers: { Authorization: `Bearer ${this.cfg.whatsappToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const j = (await r.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { message?: string } };
        return r.ok ? { status: 'SENT', providerMessageId: j.messages?.[0]?.id } : { status: 'FAILED', error: j.error?.message ?? `HTTP ${r.status}` };
      }
      if (channel === 'PUSH' && this.cfg.fcmProjectId && this.cfg.fcmAccessToken) {
        const r = await f(`https://fcm.googleapis.com/v1/projects/${this.cfg.fcmProjectId}/messages:send`, {
          method: 'POST', headers: { Authorization: `Bearer ${await this.cfg.fcmAccessToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const j = (await r.json().catch(() => ({}))) as { name?: string; error?: { message?: string } };
        return r.ok ? { status: 'SENT', providerMessageId: j.name } : { status: 'FAILED', error: j.error?.message ?? `HTTP ${r.status}` };
      }
      return { status: 'QUEUED', error: 'provider not configured for this channel' };
    } catch (e) {
      return { status: 'FAILED', error: e instanceof Error ? e.message : String(e) };
    }
  }
}
