import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../config/env';

export interface OtpMessage { channel: 'sms' | 'email'; to: string; text: string; subject?: string }

/**
 * Sends one-time codes. With OTP_WEBHOOK_URL set, each message is POSTed as JSON
 * to the household's messaging gateway (SMS provider such as Unifonic / Taqnyat,
 * and an email relay), authenticated with OTP_WEBHOOK_TOKEN. Without it (dev,
 * tests) messages stay in an in-memory outbox; production refuses to start
 * without a gateway. NOT exercised against a live SMS or email provider here.
 */
@Injectable()
export class OtpDeliveryService {
  private readonly log = new Logger('OTP');
  readonly outbox: OtpMessage[] = [];
  constructor(@Inject(ENV) private readonly env: Env) {}

  async send(m: OtpMessage) {
    if (!this.env.OTP_WEBHOOK_URL) { this.outbox.push(m); return; }
    const r = await fetch(this.env.OTP_WEBHOOK_URL, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.env.OTP_WEBHOOK_TOKEN ? { Authorization: `Bearer ${this.env.OTP_WEBHOOK_TOKEN}` } : {}) },
      body: JSON.stringify(m) });
    if (!r.ok) { this.log.warn(`gateway answered ${r.status} for ${m.channel}`); throw new Error('could not send the code; try again'); }
  }

  /** Tests / dev: the last code sent to an address. */
  lastCodeFor(to: string) { return [...this.outbox].reverse().find((m) => m.to === to)?.text.match(/\b(\d{6})\b/)?.[1]; }
}
